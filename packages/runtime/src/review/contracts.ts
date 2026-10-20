// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Destination-neutral existing-MR review target and result.
 *
 * Binds exact GitLab host, numeric project, MR IID, source/target branches, and
 * head SHA plus trigger, request identity, workflow, and delivery intent.
 * Model output cannot select or alter the target. Results are projector-neutral;
 * GitLab note posting is host-owned. Reuses the `comment-existing-mr` delivery
 * intent string without importing publication.
 */

import { createHostAuthorityFactory } from "../contract-kit/index.js";
import { LIMIT_DEFINITION_BY_NAME } from "../config/limits.generated.js";
import { digestGitlabMrReviewLocator } from "../inputs/gitlab-mr-locator.js";
import {
  assertHostedReportUrl,
  decodeQualityReportProjection,
  type QualityReportProjection,
} from "../evaluation-report/index.js";
import { egressValue, hostRootSet, type HostRootSet } from "../security/egress.js";
import { processHostRootSet } from "../security/host-roots.js";
import type { TemplateValidationFinding } from "../templates/validate.js";

import { failReviewTarget, kit, REVIEW_FINDING_SEVERITIES } from "./contracts/codec-kit.js";
import { PATCH_MARKERS, positiveInteger, relativePath } from "./contracts/value-primitives.js";
import { normalizeIssues, normalizeSourceContexts } from "./contracts/issue-evidence.js";
export { REVIEW_FINDING_SEVERITIES, failReviewTarget } from "./contracts/codec-kit.js";
export { ReviewTargetError } from "./contracts/codec-kit.js";
export type { ReviewTargetErrorCode } from "./contracts/codec-kit.js";

export const REVIEW_TARGET_SCHEMA_VERSION = 1 as const;
export const REVIEW_TARGET_KIND = "docsfab-review-target" as const;
export const REVIEW_TARGET_KEY_KIND = "docsfab-review-target-key" as const;
export const REVIEW_RESULT_KIND = "docsfab-review-result" as const;

export const REVIEW_SCM_PROVIDERS = ["gitlab", "github"] as const;
export type ReviewScmProvider = (typeof REVIEW_SCM_PROVIDERS)[number];

/** Same axis as the delivery triggers; a local copy keeps this module publication-free. */
export const REVIEW_TRIGGERS = ["interactive", "api", "webhook"] as const;
export type ReviewTrigger = (typeof REVIEW_TRIGGERS)[number];

/** Review-tier delivery intent. `update-existing-mr` is out of scope. */
export const REVIEW_DELIVERY_INTENT = "comment-existing-mr" as const;
export type ReviewDeliveryIntent = typeof REVIEW_DELIVERY_INTENT;

export const REVIEW_HEAD_PROOF_STATES = ["current", "unknown", "ambiguous", "moving"] as const;
export type ReviewHeadProofState = (typeof REVIEW_HEAD_PROOF_STATES)[number];

export type ReviewFindingSeverity = (typeof REVIEW_FINDING_SEVERITIES)[number];

export const REVIEW_FINDING_ORIGINS = ["deterministic", "agent"] as const;
export type ReviewFindingOrigin = (typeof REVIEW_FINDING_ORIGINS)[number];

export const REVIEW_CHECK_STATUSES = ["passed", "failed", "skipped"] as const;
export type ReviewCheckStatus = (typeof REVIEW_CHECK_STATUSES)[number];

const SUMMARY_MAX = LIMIT_DEFINITION_BY_NAME["reviewFindings.resultSummaryMaxChars"]!.value;
const CONTINUATION_MAX = LIMIT_DEFINITION_BY_NAME["reviewScope.continuationTextMaxChars"]!.value;
const CONTINUATION_MIN =
  LIMIT_DEFINITION_BY_NAME["reviewFindings.coverageContinuationMinChars"]!.value;
const SAFE_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const NO_HOST_ROOTS = hostRootSet([]);

export interface ReviewTargetInputV1 {
  scmProvider: "gitlab";
  host: string;
  projectId: number;
  mergeRequestIid: number;
  sourceBranch: string;
  targetBranch: string;
  headSha: string;
  trigger: ReviewTrigger;
  requestIdentitySha256: string;
  workflow: string;
  deliveryIntent: ReviewDeliveryIntent;
  logicalRequestId: string;
}

export interface ReviewTargetV1 extends ReviewTargetInputV1 {
  schemaVersion: 1;
  kind: typeof REVIEW_TARGET_KIND;
  targetSha256: string;
}

export interface ReviewTargetInputV2Common {
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly trigger: ReviewTrigger;
  readonly requestIdentitySha256: string;
  readonly workflow: string;
  readonly deliveryIntent: ReviewDeliveryIntent;
  readonly logicalRequestId: string;
  readonly changeSourceSha256: string;
}

export interface ReviewTargetInputV2Gitlab extends ReviewTargetInputV2Common {
  readonly scmProvider: "gitlab";
  readonly host: string;
  readonly projectId: number;
  readonly mergeRequestIid: number;
  readonly sourceFork: boolean;
}

export interface ReviewTargetInputV2Github extends ReviewTargetInputV2Common {
  readonly scmProvider: "github";
  readonly host: "github.com";
  /** Target repository identity; this remains stable across repository renames. */
  readonly repositoryId: number;
  /** Source repository identity; null when GitHub no longer reports a deleted fork. */
  readonly headRepositoryId: number | null;
  readonly pullRequestNumber: number;
}

export type ReviewTargetInputV2 = ReviewTargetInputV2Gitlab | ReviewTargetInputV2Github;

export type ReviewTargetV2 = ReviewTargetInputV2 & {
  readonly schemaVersion: 2;
  readonly kind: typeof REVIEW_TARGET_KIND;
  readonly targetSha256: string;
};

export type ReviewTargetKeyV2 = {
  readonly schemaVersion: 2;
  readonly kind: typeof REVIEW_TARGET_KEY_KIND;
  readonly keySha256: string;
  readonly host: string;
  readonly logicalRequestId: string;
  readonly deliveryIntent: ReviewDeliveryIntent;
} & (
  | { readonly scmProvider: "gitlab"; readonly projectId: number; readonly mergeRequestIid: number }
  | {
      readonly scmProvider: "github";
      readonly repositoryId: number;
      readonly pullRequestNumber: number;
    }
);

export interface ReviewTargetKeyV1 {
  schemaVersion: 1;
  kind: typeof REVIEW_TARGET_KEY_KIND;
  keySha256: string;
  scmProvider: "gitlab";
  host: string;
  projectId: number;
  mergeRequestIid: number;
  logicalRequestId: string;
  deliveryIntent: ReviewDeliveryIntent;
}

export interface ReviewHeadObservationV1 {
  scmProvider: "gitlab";
  host: string;
  projectId: number;
  mergeRequestIid: number;
  observedHeadSha: string | null;
  sourceBranch: string | null;
  targetBranch: string | null;
  proofStatus: ReviewHeadProofState;
}

export type ReviewHeadAuthority = {
  readonly kind: "docsfab-review-head-authority";
};

export interface ReviewHeadVerifier {
  verifyCurrent(observation: ReviewHeadObservationV1): { status: "admitted" };
}

const reviewHeadAuthorities = createHostAuthorityFactory<
  "docsfab-review-head-authority",
  ReviewHeadVerifier
>({
  kind: "docsfab-review-head-authority",
  invalidMessage: "Review-head verifier must expose verifyCurrent.",
});

export function createReviewHeadAuthority(verifier: ReviewHeadVerifier): ReviewHeadAuthority {
  return reviewHeadAuthorities.create(verifier) as ReviewHeadAuthority;
}

export interface ReviewFindingV1 {
  id: string;
  severity: ReviewFindingSeverity;
  code: string;
  summary: string;
  path: string | null;
  origin?: ReviewFindingOrigin;
  line?: number;
  evidence?: string;
  recommendation?: string;
}

export interface ReviewSkippedPathV1 {
  path: string;
  reason: string;
}

export interface ReviewCheckV1 {
  id: string;
  name: string;
  status: ReviewCheckStatus;
}

export interface ReviewQuestionV1 {
  id: string;
  summary: string;
}

export interface ReviewPatchLocatorV1 {
  kind: "artifact-digest";
  digestSha256: string;
}

/** Host template-audit evidence and the still-unknown selected-rubric axis. */
export interface ReviewTemplateCoverageV1 {
  /** Null means no valid host audit report was retained for this review. */
  reportDigest: string | null;
  pages: readonly {
    path: string;
    mapping: "mapped" | "unmapped" | "unknown";
    applicability: "applicable" | "not-applicable" | "unknown";
    reason: string;
    templateId: string | null;
    conformance: "passed" | "failed" | "not-applicable" | "unknown";
    rules: readonly Pick<TemplateValidationFinding, "rule" | "severity" | "expected" | "line">[];
    /** IDs of recommendations actually retained in this review result. */
    suggestionIds: readonly string[];
    /** #1843 selected-rubric evidence is not yet available at this seam. */
    rubric: { status: "unknown"; reason: string };
  }[];
}

/**
 * Optional focused-review coverage: the scope label, how many pages the run
 * reviewed, the tracked Markdown corpus that count is measured against (null
 * when uncounted), the deferred pages in the order they were named, and the
 * registered canon digest the continue command needs (null when the producer
 * has none). The host's review-summary note renders it as one coverage line. A
 * result without the block seals byte-identically to one sealed before the
 * block existed.
 */
export interface ReviewCoverageV1 {
  scope: string;
  reviewedCount: number;
  corpusFileCount: number | null;
  deferredPaths: readonly string[];
  anchorPaths: readonly string[];
  scopeSha256: string;
  reviewRevision: string;
  accounting: {
    radiusSha256: string;
    radiusPageCount: number;
    listedPageCount: number;
    unlistedPageCount: number;
    unreviewableNeighbourCount: number;
    changedPathCount: number | null;
    continuationCharacterLimit: number;
  };
  canonSha256: string | null;
  /** Hosted project-bound CAS plan; absent for local and legacy producers. */
  continuationLocator?: string;
  /** Per-page host audit evidence, when the review projected a focused scope. */
  templateCoverage?: ReviewTemplateCoverageV1;
}

/** One scope names at most this many deferred pages (the review-scope transport ceiling). */
export const REVIEW_COVERAGE_MAX_DEFERRED =
  LIMIT_DEFINITION_BY_NAME["reviewFindings.coverageDeferredMaxCount"]!.value;

export interface ReviewResultInputV1 {
  taskId: string;
  runIdSha256: string;
  findings: readonly ReviewFindingV1[];
  checks: readonly ReviewCheckV1[];
  unresolvedQuestions: readonly ReviewQuestionV1[];
  affectedPaths: readonly string[];
  patchLocator: ReviewPatchLocatorV1 | null;
  locatorSha256: string | null;
  skippedPaths?: readonly ReviewSkippedPathV1[];
  reviewScope?: ReviewCoverageV1;
}

export interface ReviewResultV1 extends ReviewResultInputV1 {
  schemaVersion: 1;
  kind: typeof REVIEW_RESULT_KIND;
  targetSha256: string;
  reviewedHeadSha: string;
  resultSha256: string;
}

export interface ReviewResultInputV2 extends ReviewResultInputV1 {
  qualityReport: QualityReportProjection;
  hostedReportUrl?: string;
}

export interface ReviewResultV2 extends ReviewResultInputV2 {
  schemaVersion: 2;
  kind: typeof REVIEW_RESULT_KIND;
  targetSha256: string;
  reviewedHeadSha: string;
  resultSha256: string;
}

export interface ReviewIssueFactRefV3 {
  dimensionIndex: number;
  factIndex: number;
}

export interface ReviewIssueV3 {
  id: string;
  producerStepId: string;
  producerSkill: string;
  originalId: string;
  severity: ReviewFindingSeverity;
  originalSeverity: "critical" | "major" | "minor";
  category: string;
  finding: string;
  location: string;
  path: string | null;
  line: number | null;
  locationFidelity: "exact" | "normalized" | "unresolved";
  evidence: { sourceId: string; locator: string };
  requiredChange: string;
  limitations: readonly string[];
  sourceContextId: string | null;
  factRefs: readonly ReviewIssueFactRefV3[];
}

export type ReviewProposedEditV4 =
  | { readonly kind: "advice"; readonly text: string }
  | {
      readonly kind: "replacement";
      readonly text: string;
      readonly path: string;
      readonly originalText: string;
      readonly replacementText: string;
    };

export type ReviewIssueRichV4 =
  | {
      readonly status: "unavailable";
      readonly reason:
        | "candidate-absent"
        | "link-changed"
        | "contradicted"
        | "unresolved"
        | "source-unavailable"
        | "qualification-unproven";
    }
  | {
      readonly status: "admitted";
      readonly candidateSha256: string;
      readonly title: string;
      readonly readerConsequence: string;
      readonly proposedEdit: ReviewProposedEditV4;
      readonly grounding: readonly {
        readonly factId: string;
        readonly qualification: string;
        readonly status: "supported";
        readonly rationale: string;
        readonly sourceLocators: readonly string[];
      }[];
    };

export interface ReviewIssueV4 extends ReviewIssueV3 {
  readonly rich: ReviewIssueRichV4;
}

export interface ReviewSourceFactV3 {
  id: string;
  dimension: string;
  sourceLocators: readonly string[];
  statement: string;
  documentationDisposition:
    | "documented"
    | "omitted"
    | "conflicting"
    | "unverified-policy"
    | "product-defect";
  uncertainty: string;
  issueIds: readonly string[];
}

export interface ReviewSourceContextV3 {
  id: string;
  completeness: "bounded-not-proven";
  limitations: readonly string[];
  dimensions: readonly {
    dimension: string;
    status: "applicable" | "not-applicable" | "unverified";
    reason: string;
    sourceLocators: readonly string[];
    facts: readonly ReviewSourceFactV3[];
  }[];
}

export interface ReviewResultInputV3 extends ReviewResultInputV1 {
  issues: readonly ReviewIssueV3[];
  sourceContexts: readonly ReviewSourceContextV3[];
  qualityReport: QualityReportProjection | null;
  hostedReportUrl?: string;
}

export interface ReviewResultV3 extends ReviewResultInputV3 {
  schemaVersion: 3;
  kind: typeof REVIEW_RESULT_KIND;
  targetSha256: string;
  reviewedHeadSha: string;
  resultSha256: string;
}

export interface ReviewResultInputV5 extends Omit<ReviewResultInputV3, "issues"> {
  issues: readonly ReviewIssueV4[];
}

export interface ReviewResultV5 extends ReviewResultInputV5 {
  schemaVersion: 5;
  kind: typeof REVIEW_RESULT_KIND;
  targetSha256: string;
  reviewedHeadSha: string;
  resultSha256: string;
}

/** Version 4 binds shared finding semantics to a provider-discriminated target. */
export type ReviewResultInputV4 = ReviewResultInputV1 & {
  qualityReport?: QualityReportProjection | null;
  hostedReportUrl?: string;
} & (
    | { issues?: never; sourceContexts?: never }
    | {
        issues: readonly ReviewIssueV3[];
        sourceContexts: readonly ReviewSourceContextV3[];
      }
  );

export type ReviewResultV4 = ReviewResultInputV4 & {
  schemaVersion: 4;
  kind: typeof REVIEW_RESULT_KIND;
  target: ReviewTargetV2;
  targetSha256: string;
  reviewedHeadSha: string;
  resultSha256: string;
};

export type ReviewResultInputV6 = ReviewResultInputV1 & {
  qualityReport?: QualityReportProjection | null;
  hostedReportUrl?: string;
  issues: readonly ReviewIssueV4[];
  sourceContexts: readonly ReviewSourceContextV3[];
};

export type ReviewResultV6 = ReviewResultInputV6 & {
  schemaVersion: 6;
  kind: typeof REVIEW_RESULT_KIND;
  target: ReviewTargetV2;
  targetSha256: string;
  reviewedHeadSha: string;
  resultSha256: string;
};

export type ReviewResult =
  | ReviewResultV1
  | ReviewResultV2
  | ReviewResultV3
  | ReviewResultV4
  | ReviewResultV5
  | ReviewResultV6;

export interface ReviewResultEgressOptionsV1 {
  /**
   * This host's roots, replaced in the result body before it is sealed. A
   * workspace root leaves the repository-relative remainder. Defaults to HOME
   * and the tmpdir, less `DOCSFAB_PUBLIC_ROOTS`.
   */
  readonly hostRoots?: HostRootSet;
}

export interface CandidateReviewResultBindingV1 {
  readonly bindingSha256: string;
  readonly reviewCommitObjectId: string;
}

/** Seal the normal review-result envelope against a private candidate binding. */
export function createCandidateReviewResult(
  binding: CandidateReviewResultBindingV1,
  input: ReviewResultInputV2,
  options: ReviewResultEgressOptionsV1 = {},
): ReviewResultV2 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  const syntheticTarget = {
    targetSha256: kit.hash(binding.bindingSha256),
    headSha: kit.revision(binding.reviewCommitObjectId),
  } as ReviewTargetV1;
  const { qualityReport, hostedReportUrl: rawHostedReportUrl, ...common } = input;
  const normalized = normalizeResultInput(syntheticTarget, replaceHostRoots(common, options), true);
  const parsedQuality = decodeQualityReportProjection(qualityReport);
  if (parsedQuality.repositoryRevision !== syntheticTarget.headSha)
    failReviewTarget("mr-head-changed");
  const hostedReportUrl =
    rawHostedReportUrl === undefined ? undefined : hostedReportUrlFrom(rawHostedReportUrl);
  const envelope = {
    schemaVersion: 2 as const,
    kind: REVIEW_RESULT_KIND,
    ...normalized,
    qualityReport: parsedQuality,
    ...(hostedReportUrl ? { hostedReportUrl } : {}),
  };
  return kit.deepFreeze({ ...envelope, resultSha256: kit.canonicalDigest(envelope) });
}

const TARGET_BODY_KEYS = [
  "scmProvider",
  "host",
  "projectId",
  "mergeRequestIid",
  "sourceBranch",
  "targetBranch",
  "headSha",
  "trigger",
  "requestIdentitySha256",
  "workflow",
  "deliveryIntent",
  "logicalRequestId",
] as const;
const TARGET_BODY_KEYS_V2 = [
  "scmProvider",
  "host",
  "sourceBranch",
  "targetBranch",
  "baseSha",
  "headSha",
  "trigger",
  "requestIdentitySha256",
  "workflow",
  "deliveryIntent",
  "logicalRequestId",
  "changeSourceSha256",
  "projectId",
  "mergeRequestIid",
  "sourceFork",
  "repositoryId",
  "headRepositoryId",
  "pullRequestNumber",
] as const;

const RESULT_BODY_KEYS_V1 = [
  "taskId",
  "runIdSha256",
  "targetSha256",
  "reviewedHeadSha",
  "findings",
  "checks",
  "unresolvedQuestions",
  "affectedPaths",
  "patchLocator",
  "locatorSha256",
] as const;
const RESULT_BODY_KEYS_V2 = [...RESULT_BODY_KEYS_V1, "qualityReport"] as const;
const RESULT_BODY_KEYS_V3 = [...RESULT_BODY_KEYS_V2, "issues", "sourceContexts"] as const;
const FINDING_KEYS = [
  "id",
  "severity",
  "code",
  "summary",
  "path",
  "origin",
  "line",
  "evidence",
  "recommendation",
] as const;
const FINDING_OPTIONAL = ["origin", "line", "evidence", "recommendation"] as const;
const RESULT_INPUT_KEYS = [
  "taskId",
  "runIdSha256",
  "findings",
  "checks",
  "unresolvedQuestions",
  "affectedPaths",
  "patchLocator",
  "locatorSha256",
  "skippedPaths",
  "reviewScope",
] as const;
const RESULT_INPUT_OPTIONAL = ["skippedPaths", "reviewScope"] as const;
const REVIEW_COVERAGE_KEYS = [
  "scope",
  "reviewedCount",
  "corpusFileCount",
  "deferredPaths",
  "anchorPaths",
  "scopeSha256",
  "reviewRevision",
  "accounting",
  "canonSha256",
] as const;

export function createReviewTarget(input: ReviewTargetInputV1): ReviewTargetV1 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  return kit.seal(REVIEW_TARGET_KIND, "targetSha256", normalizeTargetInput(input));
}

/** Seal a provider-discriminated target only when its shipped source record agrees. */
export function sealReviewTargetV2(input: ReviewTargetInputV2): ReviewTargetV2 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  const normalized = normalizeTargetInputV2(input);
  return kit.seal(REVIEW_TARGET_KIND, "targetSha256", normalized, 2) as ReviewTargetV2;
}

/** Decode V2 without discarding provider or source identity. */
export function decodeReviewTargetV2(value: unknown): ReviewTargetV2 {
  kit.rejectCredentials(value);
  const root = kit.object(value);
  const providerKeys =
    root.scmProvider === "gitlab"
      ? ["projectId", "mergeRequestIid", "sourceFork"]
      : ["repositoryId", "headRepositoryId", "pullRequestNumber"];
  kit.exact(root, [
    "schemaVersion",
    "kind",
    ...TARGET_BODY_KEYS_V2.filter(
      (key) =>
        ![
          "projectId",
          "mergeRequestIid",
          "sourceFork",
          "repositoryId",
          "headRepositoryId",
          "pullRequestNumber",
        ].includes(key),
    ),
    ...providerKeys,
    "targetSha256",
  ]);
  if (root.schemaVersion !== 2 || root.kind !== REVIEW_TARGET_KIND)
    failReviewTarget("migration-required");
  const targetInput = Object.fromEntries(
    TARGET_BODY_KEYS_V2.filter((key) => Object.hasOwn(root, key)).map((key) => [key, root[key]]),
  );
  const normalized = normalizeTargetInputV2(targetInput as unknown as ReviewTargetInputV2);
  const envelope = { schemaVersion: 2 as const, kind: REVIEW_TARGET_KIND, ...normalized };
  const target = kit.deepFreeze({ ...envelope, targetSha256: kit.canonicalDigest(envelope) });
  if (kit.canonicalJson(root) !== kit.canonicalJson(target)) failReviewTarget("digest-mismatch");
  return target;
}

/** Durable provider and repository scoped key; revisions are intentionally excluded. */
export function reviewTargetKeyV2(target: ReviewTargetV2): ReviewTargetKeyV2 {
  const current = decodeReviewTargetV2(target);
  const identity =
    current.scmProvider === "gitlab"
      ? {
          scmProvider: current.scmProvider,
          host: current.host,
          projectId: current.projectId,
          mergeRequestIid: current.mergeRequestIid,
          logicalRequestId: current.logicalRequestId,
          deliveryIntent: current.deliveryIntent,
        }
      : {
          scmProvider: current.scmProvider,
          host: current.host,
          repositoryId: current.repositoryId,
          pullRequestNumber: current.pullRequestNumber,
          logicalRequestId: current.logicalRequestId,
          deliveryIntent: current.deliveryIntent,
        };
  return kit.deepFreeze({
    schemaVersion: 2 as const,
    kind: REVIEW_TARGET_KEY_KIND,
    keySha256: kit.canonicalDigest(identity),
    ...identity,
  });
}

export function decodeReviewTarget(value: unknown): ReviewTargetV1 {
  return kit.decodeSealed(
    value,
    REVIEW_TARGET_KIND,
    "targetSha256",
    [...TARGET_BODY_KEYS],
    (root) => normalizeTargetInput(root as unknown as ReviewTargetInputV1),
  );
}

/** Durable key: project + MR + logical request + delivery intent. Head is excluded. */
export function reviewTargetKey(target: ReviewTargetV1): ReviewTargetKeyV1 {
  const current = decodeReviewTarget(target);
  const identity = {
    scmProvider: current.scmProvider,
    host: current.host,
    projectId: current.projectId,
    mergeRequestIid: current.mergeRequestIid,
    logicalRequestId: current.logicalRequestId,
    deliveryIntent: current.deliveryIntent,
  };
  return kit.deepFreeze({
    schemaVersion: 1 as const,
    kind: REVIEW_TARGET_KEY_KIND,
    keySha256: kit.canonicalDigest(identity),
    ...identity,
  });
}

export function createReviewResult(
  target: ReviewTargetV1,
  input: ReviewResultInputV1 | ReviewResultInputV2 | ReviewResultInputV3 | ReviewResultInputV5,
  options: ReviewResultEgressOptionsV1 = {},
): ReviewResult {
  const bound = decodeReviewTarget(target);
  kit.assertInert(input);
  kit.rejectCredentials(input);
  if (
    "issues" in input &&
    Array.isArray(input.issues) &&
    input.issues.some((issue) => issue !== null && typeof issue === "object" && "rich" in issue)
  )
    return createReviewResultV5(bound, input as ReviewResultInputV5, options);
  if ("issues" in input) {
    const projected = replaceHostRoots(input, options) as ReviewResultInputV3;
    const {
      issues: rawIssues,
      sourceContexts: rawContexts,
      qualityReport: rawQuality,
      hostedReportUrl: rawHostedReportUrl,
      ...commonInput
    } = projected;
    const common = normalizeResultInput(bound, commonInput);
    const sourceContexts = normalizeSourceContexts(rawContexts);
    const issues = normalizeIssues(rawIssues, sourceContexts);
    const qualityReport = rawQuality === null ? null : decodeQualityReportProjection(rawQuality);
    if (qualityReport && qualityReport.repositoryRevision !== bound.headSha)
      failReviewTarget("mr-head-changed");
    const hostedReportUrl =
      rawHostedReportUrl === undefined ? undefined : hostedReportUrlFrom(rawHostedReportUrl);
    const envelope = {
      schemaVersion: 3 as const,
      kind: REVIEW_RESULT_KIND,
      ...common,
      issues,
      sourceContexts,
      qualityReport,
      ...(hostedReportUrl ? { hostedReportUrl } : {}),
    };
    return kit.deepFreeze({ ...envelope, resultSha256: kit.canonicalDigest(envelope) });
  }
  const hostedReportUrl =
    "hostedReportUrl" in input && input.hostedReportUrl !== undefined
      ? hostedReportUrlFrom(input.hostedReportUrl)
      : undefined;
  const commonInput =
    "qualityReport" in input
      ? (Object.fromEntries(
          Object.entries(input).filter(
            ([key]) => key !== "qualityReport" && key !== "hostedReportUrl",
          ),
        ) as unknown as ReviewResultInputV1)
      : input;
  const normalized = normalizeResultInput(bound, replaceHostRoots(commonInput, options));
  if (!("qualityReport" in input)) {
    return kit.seal(REVIEW_RESULT_KIND, "resultSha256", normalized);
  }
  const qualityReport = decodeQualityReportProjection(input.qualityReport);
  if (qualityReport.repositoryRevision !== bound.headSha) failReviewTarget("mr-head-changed");
  const body = {
    ...normalized,
    qualityReport,
    ...(hostedReportUrl ? { hostedReportUrl } : {}),
  };
  const envelope = { schemaVersion: 2 as const, kind: REVIEW_RESULT_KIND, ...body };
  return kit.deepFreeze({ ...envelope, resultSha256: kit.canonicalDigest(envelope) });
}

/** Explicit V5 constructor also admits an empty rich issue graph without changing V3 defaults. */
export function createReviewResultV5(
  targetValue: ReviewTargetV1,
  input: ReviewResultInputV5,
  options: ReviewResultEgressOptionsV1 = {},
): ReviewResultV5 {
  const target = decodeReviewTarget(targetValue);
  kit.assertInert(input);
  kit.rejectCredentials(input);
  const projected = replaceHostRoots(input, options) as ReviewResultInputV5;
  if (
    !Array.isArray(input.issues) ||
    !Array.isArray(projected.issues) ||
    !input.issues.every(
      (issue) => issue !== null && typeof issue === "object" && "rich" in issue,
    ) ||
    !projected.issues.every(
      (issue) => issue !== null && typeof issue === "object" && "rich" in issue,
    ) ||
    kit.canonicalJson(input.issues.map((issue) => issue.rich)) !==
      kit.canonicalJson(projected.issues.map((issue) => issue.rich))
  )
    failReviewTarget("invalid-value");
  const {
    issues: rawIssues,
    sourceContexts: rawContexts,
    qualityReport: rawQuality,
    hostedReportUrl: rawHostedReportUrl,
    ...baseInput
  } = projected;
  const common = normalizeResultInput(target, baseInput);
  const sourceContexts = normalizeSourceContexts(rawContexts);
  const issues = normalizeIssues(rawIssues, sourceContexts, true);
  const qualityReport = rawQuality === null ? null : decodeQualityReportProjection(rawQuality);
  if (qualityReport && qualityReport.repositoryRevision !== target.headSha)
    failReviewTarget("mr-head-changed");
  const hostedReportUrl =
    rawHostedReportUrl === undefined ? undefined : hostedReportUrlFrom(rawHostedReportUrl);
  const envelope = {
    schemaVersion: 5 as const,
    kind: REVIEW_RESULT_KIND,
    ...common,
    issues,
    sourceContexts,
    qualityReport,
    ...(hostedReportUrl ? { hostedReportUrl } : {}),
  };
  return kit.deepFreeze({ ...envelope, resultSha256: kit.canonicalDigest(envelope) });
}

/** Create a schema V4 result bound to a provider target and its sealed source record. */
export function createReviewResultV2Record(
  targetValue: ReviewTargetV2,
  input:
    | ReviewResultInputV1
    | ReviewResultInputV2
    | ReviewResultInputV3
    | ReviewResultInputV4
    | ReviewResultInputV6,
  options: ReviewResultEgressOptionsV1 = {},
): ReviewResultV4 | ReviewResultV6 {
  const target = decodeReviewTargetV2(targetValue);
  kit.assertInert(input);
  kit.rejectCredentials(input);
  if (
    "issues" in input &&
    Array.isArray(input.issues) &&
    input.issues.some((issue) => issue !== null && typeof issue === "object" && "rich" in issue)
  )
    return createReviewResultV6Record(target, input as ReviewResultInputV6, options);
  const projected = replaceHostRoots(input, options) as ReviewResultInputV4;
  const {
    qualityReport: rawQuality,
    hostedReportUrl: rawHostedReportUrl,
    issues: rawIssues,
    sourceContexts: rawContexts,
    ...baseInput
  } = projected;
  const common = normalizeResultInput(target as unknown as ReviewTargetV1, baseInput, false, true);
  const qualityReport =
    rawQuality === undefined || rawQuality === null
      ? rawQuality
      : decodeQualityReportProjection(rawQuality);
  if (qualityReport && qualityReport.repositoryRevision !== target.headSha)
    failReviewTarget("mr-head-changed");
  const hostedReportUrl =
    rawHostedReportUrl === undefined ? undefined : hostedReportUrlFrom(rawHostedReportUrl);
  let sourceContexts: ReviewSourceContextV3[] | undefined;
  let issues: ReviewIssueV3[] | undefined;
  if (rawIssues !== undefined || rawContexts !== undefined) {
    if (rawIssues === undefined || rawContexts === undefined) failReviewTarget("invalid-shape");
    sourceContexts = normalizeSourceContexts(rawContexts);
    issues = normalizeIssues(rawIssues, sourceContexts);
  }
  const envelope = {
    schemaVersion: 4 as const,
    kind: REVIEW_RESULT_KIND,
    ...common,
    target,
    ...(qualityReport === undefined ? {} : { qualityReport }),
    ...(hostedReportUrl ? { hostedReportUrl } : {}),
  };
  const graphEnvelope =
    issues === undefined ? envelope : { ...envelope, issues, sourceContexts: sourceContexts! };
  return kit.deepFreeze({
    ...graphEnvelope,
    resultSha256: kit.canonicalDigest(graphEnvelope),
  });
}

/** Explicit V6 constructor preserves the closed V4 default for empty issue graphs. */
export function createReviewResultV6Record(
  targetValue: ReviewTargetV2,
  input: ReviewResultInputV6,
  options: ReviewResultEgressOptionsV1 = {},
): ReviewResultV6 {
  const target = decodeReviewTargetV2(targetValue);
  kit.assertInert(input);
  kit.rejectCredentials(input);
  const projected = replaceHostRoots(input, options) as ReviewResultInputV6;
  if (
    !Array.isArray(input.issues) ||
    !Array.isArray(projected.issues) ||
    !input.issues.every(
      (issue) => issue !== null && typeof issue === "object" && "rich" in issue,
    ) ||
    !projected.issues.every(
      (issue) => issue !== null && typeof issue === "object" && "rich" in issue,
    ) ||
    kit.canonicalJson(input.issues.map((issue) => issue.rich)) !==
      kit.canonicalJson(projected.issues.map((issue) => issue.rich))
  )
    failReviewTarget("invalid-value");
  const {
    qualityReport: rawQuality,
    hostedReportUrl: rawHostedReportUrl,
    issues: rawIssues,
    sourceContexts: rawContexts,
    ...baseInput
  } = projected;
  const common = normalizeResultInput(target, baseInput, false, true);
  const sourceContexts = normalizeSourceContexts(rawContexts);
  const issues = normalizeIssues(rawIssues, sourceContexts, true);
  const qualityReport =
    rawQuality === undefined || rawQuality === null
      ? rawQuality
      : decodeQualityReportProjection(rawQuality);
  if (qualityReport && qualityReport.repositoryRevision !== target.headSha)
    failReviewTarget("mr-head-changed");
  const hostedReportUrl =
    rawHostedReportUrl === undefined ? undefined : hostedReportUrlFrom(rawHostedReportUrl);
  const envelope = {
    schemaVersion: 6 as const,
    kind: REVIEW_RESULT_KIND,
    ...common,
    target,
    issues,
    sourceContexts,
    ...(qualityReport === undefined ? {} : { qualityReport }),
    ...(hostedReportUrl ? { hostedReportUrl } : {}),
  };
  return kit.deepFreeze({ ...envelope, resultSha256: kit.canonicalDigest(envelope) });
}

export function decodeReviewResult(
  value: unknown,
): ReviewResultV1 | ReviewResultV2 | ReviewResultV3 | ReviewResultV5 {
  kit.rejectCredentials(value);
  if (kit.sourceVersion(value) === 4 || kit.sourceVersion(value) === 6)
    failReviewTarget("migration-required");
  if (kit.sourceVersion(value) === 5) {
    const root = kit.object(value);
    kit.exact(
      root,
      [
        "schemaVersion",
        "kind",
        ...RESULT_BODY_KEYS_V3,
        "skippedPaths",
        "hostedReportUrl",
        "reviewScope",
        "resultSha256",
      ],
      ["skippedPaths", "hostedReportUrl", "reviewScope"],
    );
    if (root.kind !== REVIEW_RESULT_KIND) failReviewTarget("migration-required");
    const common = normalizeDecodedResult(root);
    const sourceContexts = normalizeSourceContexts(root.sourceContexts);
    const issues = normalizeIssues(root.issues, sourceContexts, true);
    const qualityReport =
      root.qualityReport === null ? null : decodeQualityReportProjection(root.qualityReport);
    if (qualityReport && qualityReport.repositoryRevision !== common.reviewedHeadSha)
      failReviewTarget("mr-head-changed");
    const hostedReportUrl =
      root.hostedReportUrl === undefined ? undefined : hostedReportUrlFrom(root.hostedReportUrl);
    const envelope = {
      schemaVersion: 5 as const,
      kind: REVIEW_RESULT_KIND,
      ...common,
      issues,
      sourceContexts,
      qualityReport,
      ...(hostedReportUrl ? { hostedReportUrl } : {}),
    };
    const decoded = kit.deepFreeze({ ...envelope, resultSha256: kit.canonicalDigest(envelope) });
    if (kit.canonicalJson(root) !== kit.canonicalJson(decoded)) failReviewTarget("digest-mismatch");
    return decoded;
  }
  if (kit.sourceVersion(value) === 3) {
    const root = kit.object(value);
    kit.exact(
      root,
      [
        "schemaVersion",
        "kind",
        ...RESULT_BODY_KEYS_V3,
        "skippedPaths",
        "hostedReportUrl",
        "reviewScope",
        "resultSha256",
      ],
      ["skippedPaths", "hostedReportUrl", "reviewScope"],
    );
    if (root.schemaVersion !== 3 || root.kind !== REVIEW_RESULT_KIND)
      failReviewTarget("migration-required");
    const common = normalizeDecodedResult(root);
    const sourceContexts = normalizeSourceContexts(root.sourceContexts);
    const issues = normalizeIssues(root.issues, sourceContexts);
    const qualityReport =
      root.qualityReport === null ? null : decodeQualityReportProjection(root.qualityReport);
    if (qualityReport && qualityReport.repositoryRevision !== common.reviewedHeadSha)
      failReviewTarget("mr-head-changed");
    const hostedReportUrl =
      root.hostedReportUrl === undefined ? undefined : hostedReportUrlFrom(root.hostedReportUrl);
    const envelope = {
      schemaVersion: 3 as const,
      kind: REVIEW_RESULT_KIND,
      ...common,
      issues,
      sourceContexts,
      qualityReport,
      ...(hostedReportUrl ? { hostedReportUrl } : {}),
    };
    const normalized = kit.deepFreeze({ ...envelope, resultSha256: kit.canonicalDigest(envelope) });
    if (kit.canonicalJson(root) !== kit.canonicalJson(normalized))
      failReviewTarget("digest-mismatch");
    return normalized;
  }
  if (kit.sourceVersion(value) === 1) {
    const root = kit.object(value);
    kit.exact(
      root,
      [
        "schemaVersion",
        "kind",
        ...RESULT_BODY_KEYS_V1,
        "skippedPaths",
        "reviewScope",
        "resultSha256",
      ],
      ["skippedPaths", "reviewScope"],
    );
    if (root.schemaVersion !== 1 || root.kind !== REVIEW_RESULT_KIND) {
      failReviewTarget("migration-required");
    }
    const common = normalizeDecodedResult(root);
    const envelope = { schemaVersion: 1 as const, kind: REVIEW_RESULT_KIND, ...common };
    const normalized = kit.deepFreeze({
      ...envelope,
      resultSha256: kit.canonicalDigest(envelope),
    });
    if (kit.canonicalJson(root) !== kit.canonicalJson(normalized)) {
      failReviewTarget("digest-mismatch");
    }
    return normalized;
  }
  const root = kit.object(value);
  kit.exact(
    root,
    [
      "schemaVersion",
      "kind",
      ...RESULT_BODY_KEYS_V2,
      "skippedPaths",
      "hostedReportUrl",
      "reviewScope",
      "resultSha256",
    ],
    ["skippedPaths", "hostedReportUrl", "reviewScope"],
  );
  if (root.schemaVersion !== 2 || root.kind !== REVIEW_RESULT_KIND) {
    failReviewTarget("migration-required");
  }
  const common = normalizeDecodedResult(root);
  const qualityReport = decodeQualityReportProjection(root.qualityReport);
  if (qualityReport.repositoryRevision !== common.reviewedHeadSha) {
    failReviewTarget("mr-head-changed");
  }
  const hostedReportUrl =
    root.hostedReportUrl === undefined ? undefined : hostedReportUrlFrom(root.hostedReportUrl);
  const envelope = {
    schemaVersion: 2 as const,
    kind: REVIEW_RESULT_KIND,
    ...common,
    qualityReport,
    ...(hostedReportUrl ? { hostedReportUrl } : {}),
  };
  const normalized = kit.deepFreeze({
    ...envelope,
    resultSha256: kit.canonicalDigest(envelope),
  });
  if (kit.canonicalJson(root) !== kit.canonicalJson(normalized)) {
    failReviewTarget("digest-mismatch");
  }
  return normalized;
}

export function decodeReviewResultV2(value: unknown): ReviewResult {
  const version = kit.sourceVersion(value);
  if (version !== 4 && version !== 6) return decodeReviewResult(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(
    root,
    [
      "schemaVersion",
      "kind",
      ...RESULT_BODY_KEYS_V1,
      "target",
      "qualityReport",
      "hostedReportUrl",
      "issues",
      "sourceContexts",
      "skippedPaths",
      "reviewScope",
      "resultSha256",
    ],
    version === 6
      ? ["qualityReport", "hostedReportUrl", "skippedPaths", "reviewScope"]
      : [
          "qualityReport",
          "hostedReportUrl",
          "issues",
          "sourceContexts",
          "skippedPaths",
          "reviewScope",
        ],
  );
  if (root.schemaVersion !== version || root.kind !== REVIEW_RESULT_KIND)
    failReviewTarget("migration-required");
  const common = normalizeDecodedResult(root);
  const target = decodeReviewTargetV2(root.target);
  if (common.targetSha256 !== target.targetSha256) failReviewTarget("digest-mismatch");
  if (common.reviewedHeadSha !== target.headSha) failReviewTarget("mr-head-changed");
  if (target.scmProvider === "github") {
    if (common.locatorSha256 !== null) failReviewTarget("digest-mismatch");
  } else if (
    common.locatorSha256 !==
    digestGitlabMrReviewLocator({
      host: target.host,
      projectId: target.projectId,
      mergeRequestIid: target.mergeRequestIid,
    })
  )
    failReviewTarget("digest-mismatch");
  const qualityReport =
    root.qualityReport === undefined || root.qualityReport === null
      ? root.qualityReport
      : decodeQualityReportProjection(root.qualityReport);
  if (qualityReport && qualityReport.repositoryRevision !== common.reviewedHeadSha)
    failReviewTarget("mr-head-changed");
  const hostedReportUrl =
    root.hostedReportUrl === undefined ? undefined : hostedReportUrlFrom(root.hostedReportUrl);
  let sourceContexts: ReviewSourceContextV3[] | undefined;
  let issues: ReviewIssueV3[] | ReviewIssueV4[] | undefined;
  if (root.issues !== undefined || root.sourceContexts !== undefined) {
    if (root.issues === undefined || root.sourceContexts === undefined)
      failReviewTarget("invalid-shape");
    sourceContexts = normalizeSourceContexts(root.sourceContexts);
    issues =
      version === 6
        ? normalizeIssues(root.issues, sourceContexts, true)
        : normalizeIssues(root.issues, sourceContexts);
  }
  const envelope = {
    schemaVersion: version,
    kind: REVIEW_RESULT_KIND,
    ...common,
    target,
    ...(qualityReport === undefined ? {} : { qualityReport }),
    ...(hostedReportUrl ? { hostedReportUrl } : {}),
  };
  const graphEnvelope =
    issues === undefined ? envelope : { ...envelope, issues, sourceContexts: sourceContexts! };
  const decoded = kit.deepFreeze({
    ...graphEnvelope,
    resultSha256: kit.canonicalDigest(graphEnvelope),
  });
  if (kit.canonicalJson(root) !== kit.canonicalJson(decoded)) failReviewTarget("digest-mismatch");
  return decoded as ReviewResultV4 | ReviewResultV6;
}

export function assertReviewResultMatchesTarget(
  result: unknown,
  target: ReviewTargetV1,
): ReviewResult {
  const bound = decodeReviewTarget(target);
  const decoded = decodeReviewResult(result);
  if (decoded.targetSha256 !== bound.targetSha256) failReviewTarget("digest-mismatch");
  if (decoded.reviewedHeadSha !== bound.headSha) failReviewTarget("mr-head-changed");
  return decoded;
}

/**
 * Host-vouched head check. Unknown, ambiguous, or moving proof fails closed.
 * Head drift returns `mr-head-changed` and never treats findings as current.
 */
export function assertReviewTargetHead(
  target: ReviewTargetV1,
  observation: ReviewHeadObservationV1,
  authority: ReviewHeadAuthority,
): ReviewTargetV1 {
  const bound = decodeReviewTarget(target);
  const verifier = reviewHeadAuthorities.lookup(authority);
  if (!verifier) failReviewTarget("authority-required");
  kit.assertInert(observation);
  kit.rejectCredentials(observation);
  const normalized = normalizeObservation(observation);
  const admitted = verifier.verifyCurrent(normalized);
  if (!admitted || admitted.status !== "admitted") failReviewTarget("authority-required");
  assertObservationMatchesTarget(bound, normalized);
  return bound;
}

function normalizeTargetInput(input: ReviewTargetInputV1): ReviewTargetInputV1 {
  const root = kit.object(input);
  kit.exact(root, [...TARGET_BODY_KEYS]);
  if (root.deliveryIntent !== REVIEW_DELIVERY_INTENT) failReviewTarget("unsupported-intent");
  const scmProvider = kit.enumeration(root.scmProvider, ["gitlab"] as const);
  const host = kit.identifier(root.host);
  if (host.includes("/")) failReviewTarget("invalid-value");
  const sourceBranch = kit.identifier(root.sourceBranch);
  const targetBranch = kit.identifier(root.targetBranch);
  if (sourceBranch === targetBranch) failReviewTarget("invalid-value");
  return {
    scmProvider,
    host,
    projectId: positiveInteger(root.projectId),
    mergeRequestIid: positiveInteger(root.mergeRequestIid),
    sourceBranch,
    targetBranch,
    headSha: kit.revision(root.headSha),
    trigger: kit.enumeration(root.trigger, REVIEW_TRIGGERS),
    requestIdentitySha256: kit.hash(root.requestIdentitySha256),
    workflow: kit.identifier(root.workflow),
    deliveryIntent: REVIEW_DELIVERY_INTENT,
    logicalRequestId: kit.identifier(root.logicalRequestId),
  };
}

function normalizeTargetInputV2(input: ReviewTargetInputV2): ReviewTargetInputV2 {
  const root = kit.object(input);
  const scmProvider = kit.enumeration(root.scmProvider, REVIEW_SCM_PROVIDERS);
  const sharedKeys = TARGET_BODY_KEYS_V2.filter(
    (key) =>
      ![
        "projectId",
        "mergeRequestIid",
        "sourceFork",
        "repositoryId",
        "headRepositoryId",
        "pullRequestNumber",
      ].includes(key),
  );
  kit.exact(root, [
    ...sharedKeys,
    ...(scmProvider === "gitlab"
      ? ["projectId", "mergeRequestIid", "sourceFork"]
      : ["repositoryId", "headRepositoryId", "pullRequestNumber"]),
  ]);
  if (root.deliveryIntent !== REVIEW_DELIVERY_INTENT) failReviewTarget("unsupported-intent");
  const host = kit.identifier(root.host);
  const sourceBranch = kit.identifier(root.sourceBranch);
  const targetBranch = kit.identifier(root.targetBranch);
  const common: ReviewTargetInputV2Common = {
    sourceBranch,
    targetBranch,
    baseSha: kit.revision(root.baseSha),
    headSha: kit.revision(root.headSha),
    trigger: kit.enumeration(root.trigger, REVIEW_TRIGGERS),
    requestIdentitySha256: kit.hash(root.requestIdentitySha256),
    workflow: kit.identifier(root.workflow),
    deliveryIntent: REVIEW_DELIVERY_INTENT,
    logicalRequestId: kit.identifier(root.logicalRequestId),
    changeSourceSha256: kit.hash(root.changeSourceSha256),
  };
  if (scmProvider === "gitlab") {
    if (
      root.repositoryId !== undefined ||
      root.headRepositoryId !== undefined ||
      root.pullRequestNumber !== undefined ||
      typeof root.sourceFork !== "boolean"
    )
      failReviewTarget("invalid-shape");
    if (host.includes("/")) failReviewTarget("invalid-value");
    return {
      scmProvider,
      host,
      projectId: positiveInteger(root.projectId),
      mergeRequestIid: positiveInteger(root.mergeRequestIid),
      sourceFork: root.sourceFork === true,
      ...common,
    };
  }
  if (
    root.projectId !== undefined ||
    root.mergeRequestIid !== undefined ||
    root.sourceFork !== undefined ||
    host !== "github.com"
  )
    failReviewTarget("invalid-value");
  return {
    scmProvider,
    host: "github.com",
    repositoryId: positiveInteger(root.repositoryId),
    headRepositoryId:
      root.headRepositoryId === null ? null : positiveInteger(root.headRepositoryId),
    pullRequestNumber: positiveInteger(root.pullRequestNumber),
    ...common,
  };
}

function normalizeObservation(value: unknown): ReviewHeadObservationV1 {
  const root = kit.object(value);
  kit.exact(root, [
    "scmProvider",
    "host",
    "projectId",
    "mergeRequestIid",
    "observedHeadSha",
    "sourceBranch",
    "targetBranch",
    "proofStatus",
  ]);
  const host = kit.identifier(root.host);
  if (host.includes("/")) failReviewTarget("invalid-value");
  return {
    scmProvider: kit.enumeration(root.scmProvider, ["gitlab"] as const),
    host,
    projectId: positiveInteger(root.projectId),
    mergeRequestIid: positiveInteger(root.mergeRequestIid),
    observedHeadSha: root.observedHeadSha === null ? null : kit.revision(root.observedHeadSha),
    sourceBranch: root.sourceBranch === null ? null : kit.identifier(root.sourceBranch),
    targetBranch: root.targetBranch === null ? null : kit.identifier(root.targetBranch),
    proofStatus: kit.enumeration(root.proofStatus, REVIEW_HEAD_PROOF_STATES),
  };
}

function assertObservationMatchesTarget(
  target: ReviewTargetV1,
  observation: ReviewHeadObservationV1,
): void {
  if (
    observation.scmProvider !== target.scmProvider ||
    observation.host !== target.host ||
    observation.projectId !== target.projectId ||
    observation.mergeRequestIid !== target.mergeRequestIid
  ) {
    failReviewTarget("unknown-target");
  }
  if (observation.proofStatus === "unknown") failReviewTarget("unknown-target");
  if (observation.proofStatus === "ambiguous") failReviewTarget("ambiguous-target");
  if (observation.proofStatus === "moving") failReviewTarget("moving-target");
  if (
    observation.observedHeadSha === null ||
    observation.sourceBranch === null ||
    observation.targetBranch === null
  ) {
    failReviewTarget("incomplete-proof");
  }
  if (observation.observedHeadSha !== target.headSha) failReviewTarget("mr-head-changed");
  if (
    observation.sourceBranch !== target.sourceBranch ||
    observation.targetBranch !== target.targetBranch
  ) {
    failReviewTarget("moving-target");
  }
}

function hostedReportUrlFrom(value: unknown): string {
  try {
    return assertHostedReportUrl(value);
  } catch {
    failReviewTarget("invalid-value");
  }
}

function normalizeResultInput(
  target: ReviewTargetV1 | ReviewTargetV2,
  input: ReviewResultInputV1,
  candidate = false,
  providerV2 = false,
): Omit<ReviewResultV1, "schemaVersion" | "kind" | "resultSha256"> {
  const root = kit.object(input);
  kit.exact(root, [...RESULT_INPUT_KEYS], [...RESULT_INPUT_OPTIONAL]);
  const locatorSha256 = kit.nullableHash(root.locatorSha256);
  if (target.scmProvider === "gitlab" && (providerV2 || (!candidate && locatorSha256 !== null))) {
    const expectedLocator = digestGitlabMrReviewLocator({
      host: target.host,
      projectId: target.projectId,
      mergeRequestIid: target.mergeRequestIid,
    });
    if (locatorSha256 !== expectedLocator) failReviewTarget("digest-mismatch");
  }
  if (providerV2 && target.scmProvider === "github" && locatorSha256 !== null)
    failReviewTarget("digest-mismatch");
  if (candidate && locatorSha256 !== null) failReviewTarget("digest-mismatch");
  const skippedPaths = normalizeSkippedPaths(root.skippedPaths);
  const reviewScope = normalizeReviewCoverage(root.reviewScope);
  const findings = uniqueById(kit.array(root.findings).map(normalizeFinding).sort(byId));
  assertTemplateSuggestionLinks(reviewScope, findings);
  return {
    taskId: kit.identifier(root.taskId),
    runIdSha256: kit.hash(root.runIdSha256),
    targetSha256: target.targetSha256,
    reviewedHeadSha: target.headSha,
    findings,
    checks: uniqueById(kit.array(root.checks).map(normalizeCheck).sort(byId)),
    unresolvedQuestions: uniqueById(
      kit.array(root.unresolvedQuestions).map(normalizeQuestion).sort(byId),
    ),
    affectedPaths: normalizePaths(root.affectedPaths),
    patchLocator: normalizePatchLocator(root.patchLocator),
    locatorSha256,
    ...(skippedPaths ? { skippedPaths } : {}),
    ...(reviewScope ? { reviewScope } : {}),
  };
}

/**
 * Closed-shape check for the optional coverage block: every key present, a
 * safe scope label, non-negative integer counts, a reviewed-plus-deferred
 * total that fits inside the corpus count when one is given, at most
 * `REVIEW_COVERAGE_MAX_DEFERRED` distinct deferred Markdown pages spelled so a
 * comma-joined `target=` list stays parseable, and a null or well-formed canon
 * digest.
 */
function normalizeReviewCoverage(value: unknown): ReviewCoverageV1 | undefined {
  if (value === undefined) return undefined;
  const root = kit.object(value);
  kit.exact(root, [
    ...REVIEW_COVERAGE_KEYS,
    ...(Object.hasOwn(root, "continuationLocator") ? ["continuationLocator"] : []),
    ...(Object.hasOwn(root, "templateCoverage") ? ["templateCoverage"] : []),
  ]);
  const scope = kit.string(root.scope);
  if (!SAFE_CODE.test(scope)) failReviewTarget("invalid-value");
  const reviewedCount = nonNegativeInteger(root.reviewedCount);
  const deferredPaths = kit.array(root.deferredPaths).map(deferredPagePath);
  if (deferredPaths.length > REVIEW_COVERAGE_MAX_DEFERRED) failReviewTarget("invalid-value");
  kit.unique(deferredPaths);
  const anchorPaths = kit.array(root.anchorPaths).map(deferredPagePath);
  kit.unique(anchorPaths);
  if (anchorPaths.some((path) => !deferredPaths.includes(path))) failReviewTarget("invalid-value");
  if (reviewedCount === 0 && deferredPaths.length === 0) failReviewTarget("invalid-value");
  const corpusFileCount =
    root.corpusFileCount === null ? null : nonNegativeInteger(root.corpusFileCount);
  if (corpusFileCount !== null && corpusFileCount < reviewedCount + deferredPaths.length) {
    failReviewTarget("invalid-value");
  }
  const accountingRoot = kit.object(root.accounting);
  kit.exact(accountingRoot, [
    "radiusSha256",
    "radiusPageCount",
    "listedPageCount",
    "unlistedPageCount",
    "unreviewableNeighbourCount",
    "changedPathCount",
    "continuationCharacterLimit",
  ]);
  const accounting = {
    radiusSha256: kit.hash(accountingRoot.radiusSha256),
    radiusPageCount: nonNegativeInteger(accountingRoot.radiusPageCount),
    listedPageCount: nonNegativeInteger(accountingRoot.listedPageCount),
    unlistedPageCount: nonNegativeInteger(accountingRoot.unlistedPageCount),
    unreviewableNeighbourCount: nonNegativeInteger(accountingRoot.unreviewableNeighbourCount),
    changedPathCount:
      accountingRoot.changedPathCount === null
        ? null
        : nonNegativeInteger(accountingRoot.changedPathCount),
    continuationCharacterLimit: nonNegativeInteger(accountingRoot.continuationCharacterLimit),
  };
  if (
    accounting.listedPageCount !== reviewedCount + deferredPaths.length ||
    accounting.radiusPageCount !== accounting.listedPageCount + accounting.unlistedPageCount ||
    (corpusFileCount !== null && corpusFileCount < accounting.radiusPageCount) ||
    accounting.continuationCharacterLimit < CONTINUATION_MIN ||
    accounting.continuationCharacterLimit > CONTINUATION_MAX
  )
    failReviewTarget("invalid-value");
  const continuationLocator =
    root.continuationLocator === undefined ? undefined : kit.string(root.continuationLocator);
  if (
    continuationLocator !== undefined &&
    !/^cas:[a-f0-9]{32}:[a-f0-9]{64}$/u.test(continuationLocator)
  )
    failReviewTarget("invalid-value");
  const templateCoverage = normalizeTemplateCoverage(root.templateCoverage, reviewedCount);
  return {
    scope,
    reviewedCount,
    corpusFileCount,
    deferredPaths,
    anchorPaths,
    scopeSha256: kit.hash(root.scopeSha256),
    reviewRevision: kit.revision(root.reviewRevision),
    accounting,
    canonSha256: kit.nullableHash(root.canonSha256),
    ...(continuationLocator === undefined ? {} : { continuationLocator }),
    ...(templateCoverage === undefined ? {} : { templateCoverage }),
  };
}

function normalizeTemplateCoverage(
  value: unknown,
  reviewedCount: number,
): ReviewTemplateCoverageV1 | undefined {
  if (value === undefined) return undefined;
  const root = kit.object(value);
  kit.exact(root, ["reportDigest", "pages"]);
  const pages = kit.array(root.pages).map((value) => {
    const page = kit.object(value);
    kit.exact(page, [
      "path",
      "mapping",
      "applicability",
      "reason",
      "templateId",
      "conformance",
      "rules",
      "suggestionIds",
      "rubric",
    ]);
    const mapping = kit.enumeration(page.mapping, ["mapped", "unmapped", "unknown"] as const);
    const applicability = kit.enumeration(page.applicability, [
      "applicable",
      "not-applicable",
      "unknown",
    ] as const);
    const conformance = kit.enumeration(page.conformance, [
      "passed",
      "failed",
      "not-applicable",
      "unknown",
    ] as const);
    const templateId = page.templateId === null ? null : kit.identifier(page.templateId);
    if (
      (mapping === "mapped") !== (templateId !== null) ||
      (mapping === "mapped" && applicability !== "applicable") ||
      (mapping !== "mapped" && applicability === "applicable") ||
      (applicability === "not-applicable") !== (conformance === "not-applicable") ||
      (applicability === "unknown") !== (conformance === "unknown")
    )
      failReviewTarget("invalid-value");
    const rules = kit.array(page.rules).map((value) => {
      const rule = kit.object(value);
      kit.exact(rule, ["rule", "severity", "expected", "line"]);
      return {
        rule: kit.enumeration(rule.rule, [
          "missing-required-heading",
          "duplicate-h1",
          "wrong-section-order",
          "unresolved-template-placeholder",
        ] as const),
        severity: kit.enumeration(rule.severity, ["error", "warning", "info"] as const),
        expected: boundedSummary(rule.expected),
        line: rule.line === null ? null : positiveInteger(rule.line),
      };
    });
    const suggestionIds = kit.array(page.suggestionIds).map(kit.identifier);
    kit.unique(suggestionIds);
    if (mapping !== "mapped" && (rules.length > 0 || suggestionIds.length > 0))
      failReviewTarget("invalid-value");
    // The template validator reports warning-only findings with passed status.
    // Only error findings distinguish failed from passed conformance.
    if (
      (conformance === "failed") !== rules.some((rule) => rule.severity === "error") ||
      (rules.length === 0 && suggestionIds.length > 0)
    )
      failReviewTarget("invalid-value");
    const rubric = kit.object(page.rubric);
    kit.exact(rubric, ["status", "reason"]);
    if (rubric.status !== "unknown") failReviewTarget("invalid-value");
    return {
      path: relativePath(page.path),
      mapping,
      applicability,
      reason: boundedSummary(page.reason),
      templateId,
      conformance,
      rules,
      suggestionIds,
      rubric: { status: "unknown" as const, reason: boundedSummary(rubric.reason) },
    };
  });
  if (pages.length !== reviewedCount) failReviewTarget("invalid-value");
  kit.unique(pages.map((page) => page.path));
  const reportDigest = kit.nullableHash(root.reportDigest);
  if (reportDigest === null && pages.some((page) => page.mapping !== "unknown"))
    failReviewTarget("invalid-value");
  return { reportDigest, pages };
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    failReviewTarget("invalid-value");
  }
  return value;
}

/**
 * A deferred page is a bounded repository-relative spelling the note's
 * continue command can carry: no absolute, `~`, or backslash form, no empty,
 * `.` or `..` segment, and none of the characters that would break a
 * comma-joined `target=` list inside a code span. Whether the page satisfies
 * the Slack `target=` grammar is the host renderer's call; a page it refuses
 * is counted there, not named. A `home/` or `Users/` segment is an ordinary
 * tracked page and is admitted.
 */
function deferredPagePath(value: unknown): string {
  const path = relativePath(value);
  // Control characters are part of the class on purpose; they are spelled as
  // escapes so this file stays text.
  if (/[\s,`\x00-\x1f\x7f]/u.test(path)) failReviewTarget("invalid-value");
  return path;
}

function normalizeDecodedResult(
  root: Record<string, unknown>,
): Omit<ReviewResultV1, "schemaVersion" | "kind" | "resultSha256"> {
  const findings = kit.array(root.findings).map(normalizeFinding).sort(byId);
  const checks = kit.array(root.checks).map(normalizeCheck).sort(byId);
  const unresolvedQuestions = kit.array(root.unresolvedQuestions).map(normalizeQuestion).sort(byId);
  kit.unique(findings.map((entry) => entry.id));
  kit.unique(checks.map((entry) => entry.id));
  kit.unique(unresolvedQuestions.map((entry) => entry.id));
  const skippedPaths = normalizeSkippedPaths(root.skippedPaths);
  const reviewScope = normalizeReviewCoverage(root.reviewScope);
  assertTemplateSuggestionLinks(reviewScope, findings);
  return {
    taskId: kit.identifier(root.taskId),
    runIdSha256: kit.hash(root.runIdSha256),
    targetSha256: kit.hash(root.targetSha256),
    reviewedHeadSha: kit.revision(root.reviewedHeadSha),
    findings,
    checks,
    unresolvedQuestions,
    affectedPaths: normalizePaths(root.affectedPaths),
    patchLocator: normalizePatchLocator(root.patchLocator),
    locatorSha256: kit.nullableHash(root.locatorSha256),
    ...(skippedPaths ? { skippedPaths } : {}),
    ...(reviewScope ? { reviewScope } : {}),
  };
}

function assertTemplateSuggestionLinks(
  scope: ReviewCoverageV1 | undefined,
  findings: readonly ReviewFindingV1[],
): void {
  const byId = new Map(findings.map((finding) => [finding.id, finding]));
  for (const page of scope?.templateCoverage?.pages ?? []) {
    for (const id of page.suggestionIds) {
      const finding = byId.get(id);
      if (
        !finding ||
        finding.path !== page.path ||
        !finding.evidence ||
        !finding.recommendation ||
        !page.rules.some((rule) => finding.code === `template:${rule.rule}`)
      )
        failReviewTarget("invalid-value");
    }
  }
}

function normalizeFinding(value: unknown): ReviewFindingV1 {
  const root = kit.object(value);
  kit.exact(root, [...FINDING_KEYS], [...FINDING_OPTIONAL]);
  const code = kit.string(root.code);
  if (!SAFE_CODE.test(code)) failReviewTarget("invalid-value");
  const finding: ReviewFindingV1 = {
    id: kit.identifier(root.id),
    severity: kit.enumeration(root.severity, REVIEW_FINDING_SEVERITIES),
    code,
    summary: boundedSummary(root.summary),
    path: root.path === null ? null : relativePath(root.path),
  };
  if (Object.hasOwn(root, "origin")) {
    finding.origin = kit.enumeration(root.origin, REVIEW_FINDING_ORIGINS);
  }
  if (Object.hasOwn(root, "line")) {
    finding.line = positiveInteger(root.line);
  }
  if (Object.hasOwn(root, "evidence")) {
    finding.evidence = boundedSummary(root.evidence);
  }
  if (Object.hasOwn(root, "recommendation")) {
    finding.recommendation = boundedSummary(root.recommendation);
  }
  if (finding.origin === "agent" && (!finding.evidence || !finding.recommendation)) {
    failReviewTarget("invalid-value");
  }
  return finding;
}

/** Target-neutral strict normalizer for findings lifted from sealed skill JSON. */
export function normalizeReviewFinding(value: unknown): ReviewFindingV1 {
  assertReviewFindingDisclosure(value);
  return normalizeFinding(value);
}

/**
 * Refuse a non-inert value or credential material before any projection or
 * truncation, with the same credential screen the seal applies, so a finding
 * that would fail the seal is dropped here instead of failing the result.
 */
export function assertReviewFindingDisclosure(value: unknown): void {
  kit.assertInert(value);
  if (!egressValue(value, NO_HOST_ROOTS).ok) failReviewTarget("credential-material");
}

function normalizeSkippedPaths(value: unknown): ReviewSkippedPathV1[] | undefined {
  if (value === undefined) return undefined;
  const paths = kit.array(value).map(normalizeSkippedPath);
  const sorted = [...paths].sort((left, right) => kit.compare(left.path, right.path));
  kit.unique(sorted.map((entry) => entry.path));
  return sorted.length > 0 ? sorted : undefined;
}

function normalizeSkippedPath(value: unknown): ReviewSkippedPathV1 {
  const root = kit.object(value);
  kit.exact(root, ["path", "reason"]);
  return { path: relativePath(root.path), reason: boundedSummary(root.reason) };
}

function normalizeCheck(value: unknown): ReviewCheckV1 {
  const root = kit.object(value);
  kit.exact(root, ["id", "name", "status"]);
  const name = boundedSummary(root.name);
  return {
    id: kit.identifier(root.id),
    name,
    status: kit.enumeration(root.status, REVIEW_CHECK_STATUSES),
  };
}

function normalizeQuestion(value: unknown): ReviewQuestionV1 {
  const root = kit.object(value);
  kit.exact(root, ["id", "summary"]);
  return { id: kit.identifier(root.id), summary: boundedSummary(root.summary) };
}

function normalizePatchLocator(value: unknown): ReviewPatchLocatorV1 | null {
  if (value === null) return null;
  const root = kit.object(value);
  kit.exact(root, ["kind", "digestSha256"]);
  if (root.kind !== "artifact-digest") failReviewTarget("invalid-value");
  return { kind: "artifact-digest", digestSha256: kit.hash(root.digestSha256) };
}

function normalizePaths(value: unknown): string[] {
  const paths = kit.array(value).map(relativePath).sort(kit.compare);
  kit.unique(paths);
  return paths;
}

function boundedSummary(value: unknown): string {
  const result = kit.string(value);
  if (result.length === 0 || result.length > SUMMARY_MAX || /^\s|\s$/u.test(result)) {
    failReviewTarget("invalid-value");
  }
  if (PATCH_MARKERS.test(result)) failReviewTarget("invalid-value");
  kit.rejectCredentials({ summary: result });
  return result;
}

function byId<T extends { id: string }>(left: T, right: T): number {
  return kit.compare(left.id, right.id);
}

function uniqueById<T extends { id: string }>(entries: T[]): T[] {
  kit.unique(entries.map((entry) => entry.id));
  return entries;
}

/**
 * Replace this host's roots in a result body. Credential material refuses it
 * as `credential-material`. A structure the screen cannot walk, or two keys
 * that merge once their roots are replaced, refuses it as `invalid-shape`.
 */
function replaceHostRoots<T extends ReviewResultInputV1>(
  input: T,
  options: ReviewResultEgressOptionsV1,
): T {
  const projected = egressValue(input, options.hostRoots ?? processHostRootSet());
  if (!projected.ok) {
    failReviewTarget(
      projected.code === "credential-material" ? "credential-material" : "invalid-shape",
    );
  }
  return projected.value as T;
}
