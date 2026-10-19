// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Pure compatibility views between the historical GitLab contracts and provider V2. */
import { canonicalJson, deepFreeze } from "../contract-kit/index.js";
import {
  decodeChangeSourceV1,
  type ChangeSourceV1,
  type GitLabMergeRequestSourceV1,
} from "../inputs/change-source.js";
import type { GithubPullRequestSourceV1 } from "../inputs/change-source/github-member.js";
import type { QualityReportProjection } from "../evaluation-report/index.js";
import {
  assertReviewResultMatchesTarget,
  createReviewResultV2Record,
  createReviewResultV6Record,
  sealReviewTargetV2,
  decodeReviewResult,
  decodeReviewResultV2,
  decodeReviewTarget,
  decodeReviewTargetV2,
  failReviewTarget,
  reviewTargetKey,
  type ReviewCheckV1,
  type ReviewFindingV1,
  type ReviewIssueV3,
  type ReviewIssueV4,
  type ReviewQuestionV1,
  type ReviewCoverageV1,
  type ReviewSkippedPathV1,
  type ReviewResult,
  type ReviewResultInputV1,
  type ReviewResultInputV2,
  type ReviewResultInputV3,
  type ReviewResultInputV4,
  type ReviewResultInputV6,
  type ReviewResultEgressOptionsV1,
  type ReviewSourceContextV3,
  type ReviewTargetInputV2,
  type ReviewTargetKeyV1,
  type ReviewTargetV1,
  type ReviewTargetV2,
} from "./contracts.js";

/** Seal a provider target only when its locator and revisions match the source record. */
export function createReviewTargetV2(
  input: ReviewTargetInputV2,
  source: ChangeSourceV1,
): ReviewTargetV2 {
  const target = sealReviewTargetV2(input);
  assertReviewTargetV2Source(target, source);
  return target;
}

/** Check provider locator identity and pinned revisions against the sealed source. */
export function assertReviewTargetV2Source(
  target: ReviewTargetV2,
  sourceValue: ChangeSourceV1,
): ChangeSourceV1 {
  const sourceRecord = decodeChangeSourceV1(sourceValue);
  if (sourceRecord.changeSourceSha256 !== target.changeSourceSha256)
    failReviewTarget("digest-mismatch");
  if (target.scmProvider === "gitlab") {
    const source = sourceRecord.source as GitLabMergeRequestSourceV1;
    if (
      source.kind !== "gitlab-merge-request" ||
      source.host !== target.host ||
      source.projectId !== target.projectId ||
      source.iid !== target.mergeRequestIid ||
      source.fork !== target.sourceFork ||
      source.diffRefs.base !== target.baseSha ||
      source.diffRefs.head !== target.headSha
    )
      failReviewTarget("unknown-target");
  } else {
    const source = sourceRecord.source as GithubPullRequestSourceV1;
    if (
      source.kind !== "github-pull-request" ||
      source.host !== target.host ||
      source.repositoryId !== target.repositoryId ||
      source.headRepositoryId !== target.headRepositoryId ||
      source.number !== target.pullRequestNumber ||
      sourceRecord.revision.base !== target.baseSha ||
      sourceRecord.revision.head !== target.headSha
    )
      failReviewTarget("unknown-target");
  }
  return sourceRecord;
}

/** Create a result bound to a provider target and its sealed source record. */
export function createReviewResultV2(
  target: ReviewTargetV2,
  source: ChangeSourceV1,
  input:
    | ReviewResultInputV1
    | ReviewResultInputV2
    | ReviewResultInputV3
    | ReviewResultInputV4
    | ReviewResultInputV6,
  options: ReviewResultEgressOptionsV1 = {},
) {
  assertReviewTargetV2Source(target, source);
  return createReviewResultV2Record(target, input, options);
}

/** Explicit rich provider result, including the valid empty-issue case. */
export function createReviewResultV6(
  target: ReviewTargetV2,
  source: ChangeSourceV1,
  input: ReviewResultInputV6,
  options: ReviewResultEgressOptionsV1 = {},
) {
  assertReviewTargetV2Source(target, source);
  return createReviewResultV6Record(target, input, options);
}

export interface ReviewTargetMigrationV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-review-target-migration";
  readonly legacyTarget: ReviewTargetV1;
  readonly legacyTargetCanonicalJson: string;
  readonly legacyTargetSha256: string;
  readonly legacyDeliveryKey: ReviewTargetKeyV1;
  readonly sourceSha256: string;
  readonly targetProjection: ReviewTargetV2;
}

/**
 * Add a provider V2 view to a historical GitLab target without changing its
 * digest or retry key. Branch names are copied as host observations: the
 * ChangeSource record carries pinned revisions and locator identity, not refs.
 */
export function migrateReviewTargetToV2(
  targetValue: ReviewTargetV1,
  sourceValue: ChangeSourceV1,
): ReviewTargetMigrationV1 {
  const legacyTarget = decodeReviewTarget(targetValue);
  const source = decodeChangeSourceV1(sourceValue);
  if (source.source.kind !== "gitlab-merge-request") failReviewTarget("unknown-target");
  const sourceBranch = legacyTarget.sourceBranch;
  const targetBranch = legacyTarget.targetBranch;
  const input: ReviewTargetInputV2 = {
    scmProvider: "gitlab",
    host: legacyTarget.host,
    projectId: legacyTarget.projectId,
    mergeRequestIid: legacyTarget.mergeRequestIid,
    sourceFork: source.source.fork,
    sourceBranch,
    targetBranch,
    baseSha: source.source.diffRefs.base,
    headSha: legacyTarget.headSha,
    trigger: legacyTarget.trigger,
    requestIdentitySha256: legacyTarget.requestIdentitySha256,
    workflow: legacyTarget.workflow,
    deliveryIntent: legacyTarget.deliveryIntent,
    logicalRequestId: legacyTarget.logicalRequestId,
    changeSourceSha256: source.changeSourceSha256,
  };
  const targetProjection = createReviewTargetV2(input, source);
  return deepFreeze({
    schemaVersion: 1 as const,
    kind: "docsfab-review-target-migration" as const,
    legacyTarget,
    legacyTargetCanonicalJson: canonicalJson(legacyTarget),
    legacyTargetSha256: legacyTarget.targetSha256,
    legacyDeliveryKey: reviewTargetKey(legacyTarget),
    sourceSha256: source.changeSourceSha256,
    targetProjection,
  });
}

export interface ReviewResultProjectionV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-review-result-projection";
  readonly scmProvider: "gitlab" | "github";
  /** A view only. For a migrated result, this differs from resultTargetSha256. */
  readonly targetProjection: ReviewTargetV1 | ReviewTargetV2;
  readonly resultTargetSha256: string;
  readonly reviewedHeadSha: string;
  readonly originalSchemaVersion: 1 | 2 | 3 | 4 | 5 | 6;
  readonly originalResultSha256: string;
  readonly originalResultCanonicalJson: string;
  readonly originalResult: ReviewResult;
  readonly taskId: string;
  readonly runIdSha256: string;
  readonly findings: readonly ReviewFindingV1[];
  readonly checks: readonly ReviewCheckV1[];
  readonly unresolvedQuestions: readonly ReviewQuestionV1[];
  readonly affectedPaths: readonly string[];
  readonly patchLocator: ReviewResult["patchLocator"];
  readonly locatorSha256: string | null;
  readonly skippedPaths?: readonly ReviewSkippedPathV1[];
  readonly reviewScope?: ReviewCoverageV1;
  /** Undefined means absent from the original version; null remains explicit. */
  readonly qualityReport?: QualityReportProjection | null;
  readonly hostedReportUrl?: string;
  /** Undefined means the source graph was absent; an empty array stays empty. */
  readonly issues?: readonly (ReviewIssueV3 | ReviewIssueV4)[];
  readonly sourceContexts?: readonly ReviewSourceContextV3[];
}

/** Project either result generation into shared review semantics without resealing it. */
export function projectReviewResultV1(
  resultValue: unknown,
  targetValue: ReviewTargetV1 | ReviewTargetV2 | ReviewTargetMigrationV1,
): ReviewResultProjectionV1 {
  const migration = isMigration(targetValue) ? targetValue : undefined;
  let targetProjection: ReviewTargetV1 | ReviewTargetV2;
  if (migration) targetProjection = migration.targetProjection;
  else {
    const targetCandidate = targetValue as ReviewTargetV1 | ReviewTargetV2;
    targetProjection = isTargetV2(targetCandidate)
      ? decodeReviewTargetV2(targetCandidate)
      : decodeReviewTarget(targetCandidate);
  }
  const result =
    typeof resultValue === "object" &&
    resultValue !== null &&
    [4, 6].includes((resultValue as { schemaVersion?: number }).schemaVersion ?? 0)
      ? decodeReviewResultV2(resultValue)
      : decodeReviewResult(resultValue);
  if (migration) {
    const migratedTarget = decodeReviewTargetV2(migration.targetProjection);
    if (result.schemaVersion === 4 || result.schemaVersion === 6) {
      if (result.targetSha256 !== migratedTarget.targetSha256) failReviewTarget("digest-mismatch");
      if (result.reviewedHeadSha !== migratedTarget.headSha) failReviewTarget("mr-head-changed");
    } else {
      const legacyResult = assertReviewResultMatchesTarget(result, migration.legacyTarget);
      if (legacyResult.targetSha256 !== migration.legacyTargetSha256)
        failReviewTarget("digest-mismatch");
    }
    if (migration.legacyTargetCanonicalJson !== canonicalJson(migration.legacyTarget))
      failReviewTarget("digest-mismatch");
    if (migration.legacyTargetSha256 !== migration.legacyTarget.targetSha256)
      failReviewTarget("digest-mismatch");
    if (
      canonicalJson(migration.legacyDeliveryKey) !==
      canonicalJson(reviewTargetKey(migration.legacyTarget))
    )
      failReviewTarget("digest-mismatch");
    if (
      migration.sourceSha256 !== migratedTarget.changeSourceSha256 ||
      migratedTarget.scmProvider !== "gitlab" ||
      migratedTarget.host !== migration.legacyTarget.host ||
      migratedTarget.projectId !== migration.legacyTarget.projectId ||
      migratedTarget.mergeRequestIid !== migration.legacyTarget.mergeRequestIid ||
      migratedTarget.headSha !== migration.legacyTarget.headSha ||
      migratedTarget.sourceBranch !== migration.legacyTarget.sourceBranch ||
      migratedTarget.targetBranch !== migration.legacyTarget.targetBranch ||
      migratedTarget.trigger !== migration.legacyTarget.trigger ||
      migratedTarget.requestIdentitySha256 !== migration.legacyTarget.requestIdentitySha256 ||
      migratedTarget.workflow !== migration.legacyTarget.workflow ||
      migratedTarget.deliveryIntent !== migration.legacyTarget.deliveryIntent ||
      migratedTarget.logicalRequestId !== migration.legacyTarget.logicalRequestId
    )
      failReviewTarget("unknown-target");
  } else if (targetProjection.schemaVersion === 2) {
    if (
      (result.schemaVersion !== 4 && result.schemaVersion !== 6) ||
      result.targetSha256 !== targetProjection.targetSha256
    )
      failReviewTarget("digest-mismatch");
  } else {
    assertReviewResultMatchesTarget(result, targetProjection);
  }
  const source = result as ReviewResult;
  return deepFreeze({
    schemaVersion: 1 as const,
    kind: "docsfab-review-result-projection" as const,
    scmProvider: targetProjection.scmProvider,
    targetProjection,
    resultTargetSha256: source.targetSha256,
    reviewedHeadSha: source.reviewedHeadSha,
    originalSchemaVersion: source.schemaVersion,
    originalResultSha256: source.resultSha256,
    originalResultCanonicalJson: canonicalJson(source),
    originalResult: source,
    taskId: source.taskId,
    runIdSha256: source.runIdSha256,
    findings: source.findings,
    checks: source.checks,
    unresolvedQuestions: source.unresolvedQuestions,
    affectedPaths: source.affectedPaths,
    patchLocator: source.patchLocator,
    locatorSha256: source.locatorSha256,
    ...(source.skippedPaths === undefined ? {} : { skippedPaths: source.skippedPaths }),
    ...(source.reviewScope === undefined ? {} : { reviewScope: source.reviewScope }),
    ...("qualityReport" in source ? { qualityReport: source.qualityReport } : {}),
    ...("hostedReportUrl" in source && source.hostedReportUrl !== undefined
      ? { hostedReportUrl: source.hostedReportUrl }
      : {}),
    ...("issues" in source ? { issues: source.issues } : {}),
    ...("sourceContexts" in source ? { sourceContexts: source.sourceContexts } : {}),
  });
}

function isMigration(value: unknown): value is ReviewTargetMigrationV1 {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "docsfab-review-target-migration"
  );
}

function isTargetV2(value: ReviewTargetV1 | ReviewTargetV2): value is ReviewTargetV2 {
  return value.schemaVersion === 2;
}
