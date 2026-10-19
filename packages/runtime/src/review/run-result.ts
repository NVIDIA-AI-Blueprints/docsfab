// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { digestGitlabMrReviewLocator } from "../inputs/gitlab-mr-locator.js";
import { failChangeSource, type ChangeSourceV1 } from "../inputs/change-source.js";
import type { RunRecord } from "../records/contracts.js";
import { decodeSuccessfulReviewRunRecord } from "../delivery/run-record.js";
import {
  QualityReportProjectionError,
  projectQualityReportFromRun,
  rejectQualityReportProjection,
  type QualityReportProjection,
} from "../evaluation-report/index.js";
import type { HostRootSet } from "../security/egress.js";
import { processHostRootSet } from "../security/host-roots.js";
import {
  createReviewResult,
  createReviewResultV5,
  type ReviewCheckV1,
  type ReviewCoverageV1,
  type ReviewFindingV1,
  type ReviewResultInputV1,
  type ReviewResultInputV2,
  type ReviewResultInputV3,
  type ReviewResultInputV5,
  type ReviewIssueV3,
  type ReviewIssueV4,
  type ReviewSkippedPathV1,
  type ReviewTargetV1,
  type ReviewTargetV2,
  type ReviewResultV4,
  type ReviewResultV5,
} from "./contracts.js";
import { projectReviewIssueGraphFromRun } from "./findings.js";
import { reviewTemplateCoverageFromRun } from "./template-coverage.js";
import { createReviewResultV2 } from "./target-migration.js";
import { sha256 } from "../content-ir/canonical.js";
import { QUALITY_REPORT_DECLINE_STEM } from "../workflow-execution/quality-correction-round.js";

const SHA256_HEX = /^[a-f0-9]{64}$/u;
const SAFE_RELATIVE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._][A-Za-z0-9._\/-]{0,511}$/u;

/** Frozen target input required by the pure run-to-review-result projection. */
export type ReviewRunBinding =
  | { readonly target: ReviewTargetV1; readonly source?: never }
  | { readonly target: ReviewTargetV2; readonly source: ChangeSourceV1 };

/**
 * Opt-in presentation for the hosted MR review note. The local CLI passes
 * nothing and keeps the defaults.
 */
export interface ReviewRunProjectionOptionsV1 {
  /**
   * `"label"`: a review whose quality report this run cannot prove (no unique
   * structured summary, or no validated quality evidence) projects without a
   * quality section and with one skipped check that says so, instead of
   * refusing the whole review. Neither setting projects an unvalidated score.
   * Default `"refuse"`.
   */
  readonly unprovenQualityReport?: "refuse" | "label";
  /** Gaps the caller already knows about, each projected as one skipped check. */
  readonly skippedChecks?: readonly { readonly id: string; readonly name: string }[];
  /** Explicit fixture-only proof; production callers omit this and retain V3 advice. */
  readonly fixtureRichProjection?: true;
}

/** The skipped check a labelled projection adds in place of the quality section. */
export function unprovenQualityReportCheck(code: QualityReportProjectionError["code"]): {
  readonly id: string;
  readonly name: string;
} {
  return {
    id: "check:quality-report-unavailable",
    name: `Quality report unavailable: this hosted run carries no validated quality evidence (${code})`,
  };
}

export class ReviewRunHeadChangedError extends Error {
  readonly code = "mr-head-changed" as const;
  readonly actualRevision: string;

  constructor(actualRevision: string) {
    super("Review result revision does not match the frozen MR review target.");
    this.name = "ReviewRunHeadChangedError";
    this.actualRevision = actualRevision;
  }
}

/** Project one already verified runtime run into its canonical review result. */
export function reviewResultFromRun(
  record: RunRecord,
  binding: ReviewRunBinding,
  hostedReportUrl?: string,
  canonSha256?: string,
  continuationLocator?: string,
  options: ReviewRunProjectionOptionsV1 = {},
): ReturnType<typeof createReviewResult> | ReviewResultV4 | ReviewResultV5 {
  const input = reviewResultInputFromRun(
    record,
    binding,
    hostedReportUrl,
    canonSha256,
    continuationLocator,
    options,
  );
  const egress = { hostRoots: reviewResultHostRoots(record) };
  if (binding.target.schemaVersion === 2) {
    if (options.fixtureRichProjection)
      throw new Error("The rich projection fixture proves only a V1 review target.");
    if (!binding.source)
      throw new Error("Provider V2 review binding requires its sealed change source.");
    return createReviewResultV2(binding.target, binding.source, input, egress);
  }
  if (options.fixtureRichProjection)
    return createReviewResultV5(binding.target, input as ReviewResultInputV5, egress);
  return createReviewResult(binding.target, input, egress);
}

/**
 * The roots replaced in a review result built from `record`: its checkout, any
 * further `workspaceRoots`, HOME, and the tmpdir, less `DOCSFAB_PUBLIC_ROOTS`.
 */
export function reviewResultHostRoots(
  record: RunRecord,
  workspaceRoots: readonly string[] = [],
): HostRootSet {
  return processHostRootSet({
    workspaceRoots: [...new Set([record.repository.sourcePath, ...workspaceRoots])],
  });
}

/**
 * Pages this run's own scope computation named but deferred before any step
 * ran, each with the deferral reason the scope already recorded (today,
 * always `over-budget`: `applyReviewScopeBudget` walks the requested pages
 * in order and defers every page from the first one that would push its
 * running byte, tool-call, or wall-clock total past the review's budget,
 * onward -- a cumulative-budget cutoff, not a property of any one page).
 * Distinct from a step-level context degrade: these pages were never sent
 * to any step's context preflight at all, so the run record already
 * carries their exact paths, unlike a packet-binding gap.
 */
export function skippedPathsFromRun(record: RunRecord): ReviewSkippedPathV1[] | undefined {
  const scope = record.reviewScope;
  if (!scope || scope.deferredPaths.length === 0) return undefined;
  return scope.deferredPaths.map((path) => ({
    path,
    reason:
      "Deferred before review: the review's own page budget (size, tool calls, and time) " +
      "ran out before reaching this page.",
  }));
}

export function reviewCoverageFromRun(
  record: RunRecord,
  canonSha256?: string,
  continuationLocator?: string,
  findings: readonly ReviewFindingV1[] = [],
): ReviewCoverageV1 | undefined {
  const scope = record.reviewScope;
  if (!scope) return undefined;
  if (canonSha256 !== undefined && !SHA256_HEX.test(canonSha256)) {
    throw new Error("The review coverage canon digest must be 64 lowercase hex characters.");
  }
  return {
    scope: scope.scope,
    reviewedCount: scope.targetPaths.length,
    corpusFileCount: scope.corpusFileCount,
    deferredPaths: [...scope.deferredPaths],
    anchorPaths: (scope.anchorPaths ?? []).filter((path) => scope.deferredPaths.includes(path)),
    scopeSha256: scope.scopeSha256,
    reviewRevision: record.repository.revision,
    accounting: scope.accounting ?? {
      radiusSha256: scope.scopeSha256,
      radiusPageCount: scope.targetPaths.length + scope.deferredPaths.length,
      listedPageCount: scope.targetPaths.length + scope.deferredPaths.length,
      unlistedPageCount: 0,
      unreviewableNeighbourCount: 0,
      changedPathCount: null,
      continuationCharacterLimit: 2_048,
    },
    canonSha256: canonSha256 ?? null,
    ...(continuationLocator ? { continuationLocator } : {}),
    ...(record.workflow === "review-documentation"
      ? {
          templateCoverage: reviewTemplateCoverageFromRun({
            record,
            targetPaths: scope.targetPaths,
            findings,
          }),
        }
      : {}),
  };
}

export function reviewResultInputFromRun(
  record: RunRecord,
  binding: ReviewRunBinding,
  hostedReportUrl?: string,
  canonSha256?: string,
  continuationLocator?: string,
  options: ReviewRunProjectionOptionsV1 = {},
): ReviewResultInputV1 | ReviewResultInputV2 | ReviewResultInputV3 | ReviewResultInputV5 {
  if (options.fixtureRichProjection) record = decodeSuccessfulReviewRunRecord(record);
  if (binding.target.schemaVersion === 2) {
    if (!binding.source) failChangeSource("change-source-record-unbound");
    assertRunContainsBoundSource(record, binding.source);
  }
  if (record.workflow !== binding.target.workflow) {
    throw new Error("Review result workflow does not match the frozen MR review target.");
  }
  if (record.repository.revision !== binding.target.headSha) {
    throw new ReviewRunHeadChangedError(record.repository.revision);
  }
  const paths = uniqueRelativePaths(record.changes?.files.map((file) => file.path) ?? []);
  const digest = record.changes?.patch?.sha256;
  const labelUnproven = options.unprovenQualityReport === "label";
  let qualityReport: QualityReportProjection | null;
  let unprovenQuality: QualityReportProjectionError["code"] | null = null;
  try {
    qualityReport = projectQualityReportFromRun(record);
  } catch (error) {
    if (!labelUnproven || !(error instanceof QualityReportProjectionError)) throw error;
    qualityReport = null;
    unprovenQuality = error.code;
  }
  // A declined evaluate-document-quality step (quality-correction-round.ts)
  // is a known, disclosed absence, not the unexplained one this rejection
  // guards: the review result still posts, carrying every other step's
  // findings, with no quality section rather than none at all.
  const qualityDeclined = [...record.steps]
    .reverse()
    .find((step) => step.skill === "evaluate-document-quality" && step.status === "succeeded")
    ?.summary?.includes(QUALITY_REPORT_DECLINE_STEM);
  if (
    record.workflow === "review-documentation" &&
    !qualityReport &&
    !qualityDeclined &&
    unprovenQuality === null
  ) {
    if (labelUnproven) unprovenQuality = "missing-report";
    else rejectQualityReportProjection("missing-report");
  }
  const stepChecks: ReviewCheckV1[] = record.steps.map((step) => ({
    id: `check:${step.id}`,
    name: step.title,
    status:
      step.status === "succeeded" ? "passed" : step.status === "failed" ? "failed" : "skipped",
  }));
  const skippedChecks: ReviewCheckV1[] = [
    ...(unprovenQuality === null ? [] : [unprovenQualityReportCheck(unprovenQuality)]),
    ...(options.skippedChecks ?? []),
  ].map((check) => ({ id: check.id, name: check.name, status: "skipped" }));
  const projectedReviewFindings = projectReviewIssueGraphFromRun(record);
  if (projectedReviewFindings.canonicalTechnicalInvalid) {
    throw new Error("Review result canonical technical evidence is invalid or unavailable.");
  }
  const reviewScope = reviewCoverageFromRun(
    record,
    canonSha256,
    continuationLocator,
    projectedReviewFindings.findings,
  );
  const skippedPaths = skippedPathsFromRun(record);
  const result: ReviewResultInputV1 = {
    taskId: `task:${record.id}`,
    runIdSha256: sha256(record.id),
    findings:
      projectedReviewFindings.findings.length > 0
        ? projectedReviewFindings.findings
        : (record.workflowOutcome?.findings ?? []).map((finding, index) => ({
            id: `finding:${index + 1}`,
            severity:
              finding.severity === "blocking"
                ? "error"
                : finding.severity === "warning"
                  ? "warning"
                  : "info",
            code: finding.code,
            summary: `Workflow finding: ${finding.code}.`,
            path: null,
          })),
    checks: [...stepChecks, ...skippedChecks],
    unresolvedQuestions: (record.workflowOutcome?.openDecisions ?? []).map((decision, index) => ({
      id: `question:${index + 1}`,
      summary: `Open decision: ${decision.id}.`,
    })),
    affectedPaths: paths,
    patchLocator:
      typeof digest === "string" && SHA256_HEX.test(digest)
        ? { kind: "artifact-digest", digestSha256: digest }
        : null,
    locatorSha256:
      "projectId" in binding.target
        ? digestGitlabMrReviewLocator({
            host: binding.target.host,
            projectId: binding.target.projectId,
            mergeRequestIid: binding.target.mergeRequestIid,
          })
        : null,
    ...(skippedPaths ? { skippedPaths } : {}),
    ...(reviewScope ? { reviewScope } : {}),
  };
  if (projectedReviewFindings.sourceContexts.length > 0) {
    const richProjection = options.fixtureRichProjection
      ? richIssuesFromRetainedCorrection(
          record,
          projectedReviewFindings.issues,
          projectedReviewFindings.sourceContexts,
        )
      : null;
    return {
      ...result,
      issues: richProjection?.issues ?? projectedReviewFindings.issues,
      sourceContexts: richProjection?.sourceContexts ?? projectedReviewFindings.sourceContexts,
      qualityReport,
      ...(hostedReportUrl ? { hostedReportUrl } : {}),
    };
  }
  if (options.fixtureRichProjection)
    throw new Error("The rich projection fixture requires the retained technical issue graph.");
  return qualityReport
    ? ({
        ...result,
        qualityReport,
        ...(hostedReportUrl ? { hostedReportUrl } : {}),
      } satisfies ReviewResultInputV2)
    : result;
}

function richIssuesFromRetainedCorrection(
  record: RunRecord,
  issues: readonly ReviewIssueV3[],
  contexts: readonly import("./contracts.js").ReviewSourceContextV3[],
): {
  issues: ReviewIssueV4[];
  sourceContexts: import("./contracts.js").ReviewSourceContextV3[];
} {
  const corrections = record.steps.filter(
    (step) => step.technicalCorrectionEvidence?.schemaVersion === 4,
  );
  if (corrections.length === 0)
    throw new Error("The rich projection fixture requires a validated V4 correction step.");
  const provisionalProducerIds = new Set(
    record.steps
      .filter((step) => step.provisionalRichCandidateEvidence !== undefined)
      .map((step) => step.id),
  );
  const provisionalContextIds = new Set(
    issues
      .filter((issue) => provisionalProducerIds.has(issue.producerStepId))
      .map((issue) => issue.sourceContextId),
  );
  const used = new Set<string>();
  const projected = issues
    .filter((issue) => !provisionalProducerIds.has(issue.producerStepId))
    .map((issue): ReviewIssueV4 => {
      const step = corrections.find((candidate) => candidate.id === issue.producerStepId);
      const evidence = step?.technicalCorrectionEvidence;
      if (!step || evidence?.schemaVersion !== 4)
        return { ...issue, rich: { status: "unavailable", reason: "candidate-absent" } };
      const row = evidence.richIssues.find((candidate) => candidate.issueId === issue.originalId);
      if (!row) throw new Error("Rich correction issue is absent from the retained V4 evidence.");
      used.add(`${step.id}:${row.issueId}`);
      if (row.status === "admitted") {
        const context = contexts.find((entry) => entry.id === issue.sourceContextId);
        if (!context)
          throw new Error("Rich correction source context for this retained issue is absent.");
        const linked = issue.factRefs.map(
          ({ dimensionIndex, factIndex }) => context.dimensions[dimensionIndex]?.facts[factIndex],
        );
        if (
          linked.some((fact) => !fact) ||
          linked.length !== row.grounding.length ||
          [...linked.map((fact) => fact!.id)].sort().join("\0") !==
            [...row.grounding.map((ground) => ground.factId)].sort().join("\0") ||
          row.grounding.some((ground) => {
            const fact = linked.find((candidate) => candidate?.id === ground.factId);
            return (
              !fact ||
              fact.uncertainty !== ground.qualification ||
              ground.sourceLocators.some((locator) => !fact.sourceLocators.includes(locator))
            );
          })
        )
          throw new Error(
            "Rich correction grounding disagrees with the retained issue fact graph.",
          );
      }
      const { issueId: _issueId, ...rich } = row;
      return { ...issue, rich };
    });
  for (const step of corrections) {
    if (
      step.technicalCorrectionEvidence?.schemaVersion === 4 &&
      step.technicalCorrectionEvidence.richIssues.some(
        (row) => !used.has(`${step.id}:${row.issueId}`),
      )
    )
      throw new Error("Rich correction evidence contains an issue missing from the projection.");
  }
  return {
    issues: projected,
    sourceContexts: contexts.filter((context) => !provisionalContextIds.has(context.id)),
  };
}

function assertRunContainsBoundSource(record: RunRecord, source: ChangeSourceV1): void {
  const entry = record.changeSources?.find(
    (candidate) => candidate.changeSourceSha256 === source.changeSourceSha256,
  );
  if (
    !entry ||
    record.changeSources?.filter(
      (candidate) => candidate.changeSourceSha256 === source.changeSourceSha256,
    ).length !== 1 ||
    entry.sourceKind !== source.source.kind ||
    entry.provenance !==
      ("provenance" in source.source ? source.source.provenance : "local-verified") ||
    entry.repository.kind !== source.revision.repository.kind ||
    entry.repository.identitySha256 !== source.revision.repository.identitySha256 ||
    entry.objectFormat !== source.objectFormat ||
    entry.rangeSemantics !== source.rangeSemantics ||
    entry.base !== (source.revision.base ?? null) ||
    entry.head !== source.revision.head ||
    entry.mergeBase !== source.mergeBase ||
    entry.diffFrom !== source.diffFrom
  )
    failChangeSource("change-source-record-unbound");
}

function uniqueRelativePaths(paths: readonly string[]): string[] {
  return [
    ...new Set(paths.filter((path) => SAFE_RELATIVE.test(path) && !path.includes("//"))),
  ].sort();
}
