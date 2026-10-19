// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

import { DurableArtifactStore } from "../../artifacts/index.js";
import { readIndexedRunDiagnosis } from "../../diagnosis/record.js";
import type { RunRecord } from "../../records/contracts.js";
import {
  buildRunResultV1,
  canonicalizeJsonEvidence,
  collectRunResultNextSteps,
  defaultRunRecordPath,
  formatRunSummary,
  isContractErrorLike,
  loadReviewPresentation,
  projectHumanReviewFindings,
  serializeRunResultV1,
  type JsonEvidenceValue,
  type RunResultV1,
  type RunSummaryContext,
} from "../../operator/index.js";
import {
  formatRunFailureDiagnosticLines,
  staleRevisionRecovery,
  type RunSummaryPublicationOutcome,
} from "../../operator/run-summary.js";
import { projectRunEditorialOutcome } from "../../operator/run-result.js";
import { lookupSavedRunRetainedDelivery } from "../../operator/run-publication-lookup.js";
import type { WorkflowOutcomeDecodeOptionsV1 } from "../../workflow-contracts/outcome.js";
import { buildRepositoryDiscoveryInventory } from "../../repository/inventory.js";
import {
  QualityReportProjectionError,
  inspectQualityReportFromRun,
  persistHostedQualityReport,
  projectQualityReportFromRun,
} from "../../evaluation-report/index.js";
import {
  HostedQualityReportError,
  type HostedQualityReportMetadataV1,
} from "../../evaluation-report/hosted-report.js";
import { type ProjectedReviewFindingsV1 } from "../../review/index.js";
import type { EgressValueRefusalCode } from "../../security/egress.js";
import { formatSecurityScanCliMessages } from "../../security/scan-cli.js";
import { formatIaPlanContinuation } from "../ia-format.js";
import {
  EmptyPublishableWriteError,
  mintHostJobEnvelope,
  submitAfterSucceededRun,
} from "../../autonomy/managed-publish-host.js";
import {
  DeliveryWorktreeError,
  LocalUserPublicationPreflightError,
} from "../../delivery/contracts.js";
import { GitPublisherError } from "../../delivery/git-publisher.js";
import { LocalUserGitLabPublisherError } from "../../delivery/publisher.js";
import { PublicationResultContractError } from "../../delivery/publication-result.js";
import { RunDeliveryIndexContractError } from "../../delivery/run-delivery-index.js";
import {
  CommentExistingMrHeadChangedError,
  parseCommentMrTarget,
  postCommentExistingMrReviewSummary,
} from "../comment-existing-mr.js";
import type { RepositoryWorkspace } from "../../repository/workspace/contracts.js";
import type { CliRunDeliveryOutcome, CliRunInvocation } from "./request.js";
import type { RunPreflight } from "./preflight.js";
import type { ExecutedCliRun } from "./execution.js";
import { formatStudyPlane } from "../../records/study-event.js";
import { readPatchFileStats } from "./patch-file-stats.js";
import {
  collectRunLimitOverflowEvidence,
  mergeRunLimitOverflowEvidence,
  persistRunLimitOverflowSidecar,
} from "../../operator/run-limit-overflow.js";

export async function deliverCliRunResult(
  invocation: CliRunInvocation,
  workspace: RepositoryWorkspace,
  preflight: RunPreflight,
  execution: ExecutedCliRun,
): Promise<RunRecord> {
  const { request, config, options, output } = invocation;
  const { record } = execution;
  const json = options.json ?? request.json;
  const quiet = Boolean(options.quiet) && !json;
  const reportError = inspectQualityReportFromRun(record).error;
  const exitCode = reportError ? 1 : execution.exitCode;
  const recordPath = defaultRunRecordPath(config.stateDirectory, record.id);
  const iaContinuation =
    request.workflow === "ia-plan"
      ? formatIaPlanContinuation(record, request.task, workspace.sourcePath)
      : undefined;
  let releaseScorecard: RunSummaryContext["releaseScorecard"];
  if (record.releaseDocumentationReadiness) {
    if (!preflight.releaseDefaultBranch)
      throw new Error("Release repository authority is missing.");
    releaseScorecard = {
      defaultBranch: preflight.releaseDefaultBranch,
      inventory: await buildRepositoryDiscoveryInventory({ workspace }),
    };
  }

  // The `--draft-mr` attempt runs before the footer is composed so publication
  // is its own PUBLICATION plane, not a sentence after a footer that already
  // claimed success. Default human output fails closed through
  // `process.exitCode = 1`; `--json` / `--quiet` rethrow because they omit
  // PUBLICATION.
  let publication: RunSummaryPublicationOutcome = { status: "not-requested" };
  let publicationError: unknown;
  let draftMrConfirmation: string | undefined;
  let deliveryOutcome: CliRunDeliveryOutcome = {
    status: "settled",
    mode: "none",
    locator: null,
    publicationResult: null,
  };
  if (request.draftMr === true && verifiesNoChange(record, execution.editorialDecodeOptions)) {
    // A verified no-change has nothing to publish, so no draft MR is
    // attempted and the PUBLICATION plane records that none was needed. No
    // delivery is settled either: a knowledge continuation keeps its
    // completed phase instead of recording a draft MR it never opened.
    publication = { status: "not-needed" };
  } else if (request.draftMr === true) {
    const envelope = mintHostJobEnvelope(record.id, {
      source: "cli-argv",
      allowWrite: request.allowWrite,
      draftMr: true,
    });
    try {
      const published = await (options.submitAfterSucceededRun ?? submitAfterSucceededRun)(
        record,
        envelope,
        {
          cwd: process.cwd(),
          repositoryPath: request.repositoryPath,
          stateDirectory: config.stateDirectory,
          ...(execution.editorialDecodeOptions
            ? { editorialDecodeOptions: execution.editorialDecodeOptions }
            : {}),
          ...(request.remoteName ? { remoteName: request.remoteName } : {}),
          ...(request.gitlabTargetAtRunStart?.branch
            ? { targetBranch: request.gitlabTargetAtRunStart.branch }
            : {}),
          log: (message) => {
            // The run coordinator owns final output; publisher activity must
            // not leak ahead of the settled result or into machine JSON.
            void message;
          },
        },
      );
      const mergeRequestUrl = published?.mergeRequest?.url;
      if (mergeRequestUrl !== undefined) {
        const publicationResult = published?.publicationResult;
        if (
          options.onDeliveryOutcome &&
          (publicationResult === undefined ||
            request.gitlabTargetAtRunStart?.branch === undefined ||
            publicationResult.targetBranch !== request.gitlabTargetAtRunStart.branch ||
            publicationResult.mergeRequest.url !== mergeRequestUrl)
        ) {
          throw new PublicationResultContractError();
        }
        publication = { status: "succeeded", mergeRequestUrl };
        deliveryOutcome = publicationResult
          ? {
              status: "settled",
              mode: "draft-mr",
              locator: mergeRequestUrl,
              publicationResult,
            }
          : { status: "settled", mode: "none", locator: null, publicationResult: null };
        // Keep a quiet-safe URL confirmation, but emit it only with the final
        // settled result below.
        draftMrConfirmation = `Draft merge request: ${mergeRequestUrl}`;
      } else {
        publicationError = new Error("Draft merge request publication completed without a URL.");
        publication = {
          status: "failed",
          failureCode: "publication-result-missing",
          detail: (publicationError as Error).message,
        };
        deliveryOutcome = {
          status: "failed",
          mode: "draft-mr",
          failureCode: "publication-result-missing",
        };
      }
    } catch (error) {
      publication = decodeFailedPublicationOutcome(undefined, error);
      publicationError = error;
      deliveryOutcome = {
        status: "failed",
        mode: "draft-mr",
        failureCode:
          publication.status === "failed"
            ? publication.failureCode
            : "publication-reconciliation-failed",
      };
    }
    options.onDeliveryOutcome?.(deliveryOutcome);
  } else if (request.commentMrBinding === undefined) {
    options.onDeliveryOutcome?.(deliveryOutcome);
  }

  const reviewPresentation =
    record.workflow === "review-documentation"
      ? await loadReviewPresentation(
          record,
          new DurableArtifactStore(resolve(dirname(config.stateDirectory), "artifacts")),
        )
      : undefined;
  let reviewFindingsProjection = projectHumanReviewFindings(record, reviewPresentation?.findings);
  let reportWithheld: HostedReportEgressRefusal | undefined;
  const htmlReport =
    record.workflow === "review-documentation"
      ? await persistReviewHtmlReport(
          record,
          config.stateDirectory,
          reviewFindingsProjection!,
        ).catch((error: unknown) => {
          reportWithheld = hostedReportEgressRefusal(error);
          return null;
        })
      : null;
  if (reportWithheld && reviewFindingsProjection) {
    reviewFindingsProjection = withLimitation(
      reviewFindingsProjection,
      `hosted-report-withheld:${reportWithheld}`,
    );
  }

  let commentConfirmation: string | undefined;
  if (request.commentMrBinding !== undefined && exitCode === 0) {
    const port = options.commentExistingMr;
    if (!port) {
      throw new Error("docsfab run --comment-mr requires a host review-summary port.");
    }
    const parsed = parseCommentMrTarget(
      request.commentMr ?? String(request.commentMrBinding.target.mergeRequestIid),
    );
    let posted;
    try {
      posted = await postCommentExistingMrReviewSummary(
        port,
        request.commentMrBinding,
        record,
        parsed,
        request.repositoryPath,
        request.commentMrRetry === true,
        htmlReport?.url,
        request.commentMrCanonSha256,
      );
    } catch (error) {
      // The outer invocation retries one changed head with a fresh binding.
      // Every terminal comment failure still has a saved run to present.
      if (error instanceof CommentExistingMrHeadChangedError && request.commentMrRetry !== true) {
        throw error;
      }
      options.onDeliveryOutcome?.({
        status: "failed",
        mode: "comment-mr",
        failureCode:
          error instanceof Error && "code" in error && typeof error.code === "string"
            ? error.code
            : "comment-publication-failed",
      });
      publication = {
        status: "failed",
        failureCode: "comment-publication-failed",
        ...(error instanceof Error && error.message.length > 0 ? { detail: error.message } : {}),
      };
      publicationError = error;
    }
    if (posted) {
      options.onDeliveryOutcome?.({
        status: "settled",
        mode: "comment-mr",
        locator: String(posted.mergeRequestIid),
        publicationResult: null,
      });
      commentConfirmation =
        `Review summary ${posted.mutation} on MR !${posted.mergeRequestIid} ` +
        `at ${posted.reviewedHeadSha}`;
    }
  }

  const patchFileStats = json ? undefined : await readPatchFileStats(record);
  const limitOverflowEvidence = mergeRunLimitOverflowEvidence(
    collectRunLimitOverflowEvidence(record),
    execution.limitOverflowEvidence,
  );
  await persistRunLimitOverflowSidecar({
    recordPath,
    runId: record.id,
    evidence: limitOverflowEvidence,
  });

  const diagnosis =
    !json && !quiet && record.status === "failed"
      ? await readIndexedRunDiagnosis(record, recordPath)
      : undefined;
  const retainedDelivery =
    publication.status === "failed"
      ? await lookupSavedRunRetainedDelivery({
          environment: process.env,
          stateDirectory: config.stateDirectory,
          record,
        })
      : undefined;
  const summaryContext: RunSummaryContext = {
    record,
    recordPath,
    exitCode,
    ...(retainedDelivery ? { retainedDelivery } : {}),
    repositoryPath: request.repositoryPath,
    ...(diagnosis ? { diagnosis } : {}),
    task: request.task,
    showScan: request.showScan,
    verbose: options.verbose ?? request.verbose,
    quiet,
    publication,
    ...(execution.editorialDecodeOptions
      ? { editorialDecodeOptions: execution.editorialDecodeOptions }
      : {}),
    ...(patchFileStats ? { patchFileStats } : {}),
    ...(iaContinuation ? { iaContinuation } : {}),
    ...(releaseScorecard ? { releaseScorecard } : {}),
    ...(reviewFindingsProjection ? { reviewFindingsProjection } : {}),
    ...(reviewPresentation?.evidence
      ? { reviewEvidenceProjection: reviewPresentation.evidence }
      : {}),
    ...(preflight.repositoryContentDigestSha256
      ? {
          repositoryContentDigestSha256: preflight.repositoryContentDigestSha256,
        }
      : {}),
    ...(limitOverflowEvidence ? { limitOverflowEvidence } : {}),
    ...(htmlReport?.reportAvailable
      ? {
          htmlReportUrl: htmlReport.url,
          htmlReportPath: htmlReport.path,
          markdownReportPath: htmlReport.markdownPath,
          markdownReportAvailable: htmlReport.markdownAvailable,
          ...(htmlReport.markdownUnavailableReason
            ? { markdownReportUnavailableReason: htmlReport.markdownUnavailableReason }
            : {}),
          reportServeCommand: htmlReport.serveCommand,
        }
      : {
          ...(record.workflow === "review-documentation"
            ? {
                reportUnavailableReason: reportWithheld
                  ? `report withheld (${reportWithheld})`
                  : htmlReport?.reportUnavailableReason
                    ? `retained report unavailable (${htmlReport.reportUnavailableReason})`
                    : "no retained evaluator report",
              }
            : {}),
        }),
  };
  // `--json` wins over `--quiet`. Internal `silent` callers get a no-op
  // `output`, not a skipped computation.
  if (json) {
    output.log(
      serializeRunResultCliJson(
        buildRunResultV1({
          record,
          recordPath,
          exitCode,
          repositoryPath: request.repositoryPath,
          ...(execution.editorialDecodeOptions
            ? { editorialDecodeOptions: execution.editorialDecodeOptions }
            : {}),
          nextSteps: collectRunResultNextSteps(summaryContext),
          ...(retainedDelivery ? { retainedDelivery } : {}),
          htmlReport: htmlReport?.reportAvailable
            ? { url: htmlReport.url, path: htmlReport.path, digestSha256: htmlReport.digestSha256 }
            : null,
          ...(reviewFindingsProjection ? { reviewFindingsProjection } : {}),
          ...(reviewPresentation?.evidence
            ? { reviewEvidenceProjection: reviewPresentation.evidence }
            : {}),
          ...(preflight.repositoryContentDigestSha256
            ? {
                repositoryContentDigestSha256: preflight.repositoryContentDigestSha256,
              }
            : {}),
          ...(limitOverflowEvidence ? { limitOverflowEvidence } : {}),
        }),
        record,
      ).trimEnd(),
    );
  } else {
    for (const line of formatRunSummary(summaryContext)) output.log(line);
    if (draftMrConfirmation !== undefined) output.log(draftMrConfirmation);
    const studySummary = invocation.studySession?.summary();
    if (request.study === true && studySummary) {
      for (const line of formatStudyPlane(studySummary)) output.log(line);
    }
    if (commentConfirmation !== undefined) output.log(commentConfirmation);
    // The `--quiet` footer stops after `RECORD` and omits `FAILURE`, so its
    // diagnostic lines go to stderr and a failed run still states why.
    if (quiet && record.status === "failed") {
      for (const line of formatRunFailureDiagnosticLines(record)) output.error(line);
    }
  }
  for (const message of formatSecurityScanCliMessages(record, {
    showScan: request.showScan,
  })) {
    if (message.stream !== "stdout") output.error(message.text);
  }
  if (exitCode !== 0) process.exitCode = exitCode;
  if (publicationError !== undefined) {
    // `--json` and `--quiet` omit PUBLICATION, so the throw is the visible
    // failure. Default output already printed it in PUBLICATION.
    if (quiet && publication.status === "failed" && publication.validationFailure) {
      output.error(`Validation: ${publication.validationFailure.reasonCode}`);
      for (const result of publication.validationFailure.results ?? []) {
        output.error(`Check ${result.id}: ${result.status}`);
      }
    }
    if (json || quiet) throw publicationError;
    process.exitCode = 1;
  }
  return record;
}

/** Whether the run verified that no documentation change is needed. */
function verifiesNoChange(
  record: RunRecord,
  editorialDecodeOptions: WorkflowOutcomeDecodeOptionsV1 | undefined,
): boolean {
  return (
    projectRunEditorialOutcome(record, editorialDecodeOptions ?? {}).outcome ===
    "verified-no-change"
  );
}

/**
 * Projects typed publisher failures into the PUBLICATION plane. Pre-log throws
 * keep their typed code: only an empty documentation patch is
 * `publication-not-attempted`. Every outcome here is `post-write`: this path
 * runs only after a succeeded write produced a patch. The first argument stays
 * for source compatibility with older callers; it is never inspected.
 */
export function decodeFailedPublicationOutcome(
  _legacyLogLine: string | undefined,
  error?: unknown,
): RunSummaryPublicationOutcome {
  if (error instanceof EmptyPublishableWriteError) {
    return { status: "failed", failureCode: error.failureCode, phase: "post-write" };
  }
  if (error instanceof LocalUserPublicationPreflightError) {
    return {
      status: "failed",
      failureCode: error.code,
      detail: error.message,
      phase: "post-write",
    };
  }
  if (error instanceof DeliveryWorktreeError || error instanceof GitPublisherError) {
    return {
      status: "failed",
      failureCode: error.code,
      detail: error.message,
      ...(error instanceof DeliveryWorktreeError && error.validation
        ? { validationFailure: error.validation }
        : {}),
      phase: "post-write",
    };
  }
  if (error instanceof LocalUserGitLabPublisherError) {
    return {
      status: "failed",
      failureCode: error.code,
      ...(error.recoveryCommand ? { recoveryCommand: error.recoveryCommand } : {}),
      phase: "post-write",
    };
  }
  if (error instanceof RunDeliveryIndexContractError) {
    return {
      status: "failed",
      failureCode: error.code,
      recoveryCommand: error.recoveryCommand,
      phase: "post-write",
    };
  }
  if (isContractErrorLike(error)) {
    return {
      status: "failed",
      failureCode: error.code,
      ...(error.message.length > 0 ? { detail: error.message } : {}),
      phase: "post-write",
    };
  }
  if (error instanceof Error && error.message.length > 0) {
    return {
      status: "failed",
      failureCode: "publication-failed",
      detail: error.message,
      phase: "post-write",
    };
  }
  return { status: "failed", failureCode: "publication-failed", phase: "post-write" };
}

/**
 * Re-label a `--draft-mr` freshness failure as `pre-write`. It surfaces
 * through the operator error envelope, not the run footer, so its `action` is
 * replaced with the shared phase-specific recovery the footer would render.
 */
export function markPreWriteFreshnessFailure(error: unknown, repositoryPath: string): unknown {
  if (!(error instanceof LocalUserPublicationPreflightError)) return error;
  if (error.code !== "stale-revision") return error;
  const recovery = staleRevisionRecovery({ phase: "pre-write", repositoryPath });
  (error as { action: string }).action = `${recovery.reason} Run \`${recovery.command}\`.`;
  // The generic sentence would give the post-write recovery. This one states
  // the phase only and stays clear of the patterns `inferRemediationId` matches.
  (error as { message: string }).message =
    `Local-user GitLab publication freshness failed (${error.code}). ` +
    "GitLab's target branch moved before the write started and no run was created.";
  return error;
}

export function canonicalEvaluatorSummary(record: RunRecord): string | null {
  const evaluator = [...record.steps]
    .reverse()
    .find(
      (step) =>
        step.id === "evaluate-document-quality" &&
        step.skill === "evaluate-document-quality" &&
        (step.status === "succeeded" ||
          (step.status === "failed" &&
            record.qualityArtifactValidation !== undefined &&
            record.qualityArtifactValidation.status !== "passed" &&
            record.qualityArtifactValidation.failureCode !== null &&
            step.error ===
              `Quality artifact validation failed: ${record.qualityArtifactValidation.failureCode}.`)) &&
        typeof step.summary === "string",
    );
  return typeof evaluator?.summary === "string" && evaluator.summary.trim() !== ""
    ? evaluator.summary
    : null;
}

async function persistReviewHtmlReport(
  record: RunRecord,
  stateDirectory: string,
  review: ProjectedReviewFindingsV1,
): Promise<HostedQualityReportMetadataV1 | null> {
  const evaluatorSummary = canonicalEvaluatorSummary(record);
  if (evaluatorSummary === null) return null;
  let quality = null;
  try {
    quality = projectQualityReportFromRun(record);
  } catch (error) {
    if (!(error instanceof QualityReportProjectionError)) throw error;
  }
  return persistHostedQualityReport({
    stateDirectory,
    runId: record.id,
    quality,
    markdown: evaluatorSummary,
    reviewFindings: review.findings.map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      code: finding.code,
      summary: finding.summary,
      path: finding.path,
      ...(finding.origin !== undefined ? { origin: finding.origin } : {}),
      ...(finding.line !== undefined ? { line: finding.line } : {}),
      ...(finding.evidence !== undefined ? { evidence: finding.evidence } : {}),
      ...(finding.recommendation !== undefined ? { recommendation: finding.recommendation } : {}),
    })),
    findingLimitations: [
      `review-findings-availability:${review.availability}`,
      `review-findings-projector:${review.projector}`,
      ...(review.artifactLocator ? [`review-findings-artifact:${review.artifactLocator}`] : []),
      ...review.limitations,
    ],
  });
}

const HOSTED_REPORT_EGRESS_REFUSALS = {
  "credential-material": true,
  "egress-key-collision": true,
  "egress-unwalkable-value": true,
} as const satisfies Record<EgressValueRefusalCode, true>;

type HostedReportEgressRefusal = keyof typeof HOSTED_REPORT_EGRESS_REFUSALS;

/**
 * The egress refusal that withholds the hosted report; the run's output goes on
 * without it. Any other failure is rethrown.
 */
function hostedReportEgressRefusal(error: unknown): HostedReportEgressRefusal {
  if (
    error instanceof HostedQualityReportError &&
    Object.hasOwn(HOSTED_REPORT_EGRESS_REFUSALS, error.code)
  ) {
    return error.code as HostedReportEgressRefusal;
  }
  throw error;
}

function withLimitation(
  projection: ProjectedReviewFindingsV1,
  limitation: string,
): ProjectedReviewFindingsV1 {
  return Object.freeze({
    ...projection,
    limitations: Object.freeze([...new Set([...projection.limitations, limitation])].sort()),
  });
}

/** CLI JSON envelope: attach the sealed work-unit machine contracts when persist succeeded. */
export function serializeRunResultCliJson(result: RunResultV1, record: RunRecord): string {
  if (record.workUnitMachineContracts === undefined) return serializeRunResultV1(result);
  const { resultSha256: _digest, ...body } = result;
  const extended = {
    ...body,
    workUnitMachineContracts: record.workUnitMachineContracts,
  };
  return serializeRunResultV1({
    ...extended,
    resultSha256: createHash("sha256")
      .update(canonicalizeJsonEvidence(extended as unknown as JsonEvidenceValue), "utf8")
      .digest("hex"),
  });
}
