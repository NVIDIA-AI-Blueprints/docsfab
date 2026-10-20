// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DocsFabConfig } from "../config/runtime-loader.js";
import { assertWorkflowActive } from "../execution/cancellation.js";
import { resolve } from "node:path";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import { deliveryPlanPublishes, resolveInteractiveDeliveryGrants } from "./delivery-grants.js";
import { workflowDeliveryCapabilities } from "../workflow-contracts/delivery.js";
import { getWorkflow } from "../workflow-registry/catalog.js";
import { formatSectionHeader, indentCliBody } from "../operator/cli-format.js";
import {
  withOutputCoordinator,
  writeRenderedPresentation,
  type PresentationProgressHandle,
} from "../operator/index.js";
import { renderCliPreview, workflowPreviewFacts } from "./preview-presentation.js";
import { runPreviewNextArguments } from "./run-preview-arguments.js";
import { RunInvocationOutputCoordinator } from "./run/invocation-output-coordinator.js";
import {
  withLocalWorkflowRun,
  type RunRequestWithPublishProjection,
} from "./run/local-workflow.js";
import type { CliRunOptions } from "./run/request.js";
import { deliverCliRunResult, markPreWriteFreshnessFailure } from "./run/delivery.js";
import {
  ensureLocalUserPublicationFreshness,
  type LocalUserPublicationGitLabTargetSnapshot,
} from "../delivery/freshness.js";
import {
  CommentExistingMrHeadChangedError,
  bindCommentExistingMrTarget,
  parseCommentMrTarget,
} from "./comment-existing-mr.js";
import { loadDefaultCommentExistingMrPort } from "./comment-existing-mr-host.js";
import {
  reportCompletedKnowledgeContinuation,
  reportKnowledgeContinuationStop,
} from "./run/knowledge-continuation.js";
import { reportRequestIntentStop } from "./run/request-intent-stop.js";
import { buildRunResultV1 } from "../operator/run-result.js";
import { serializeRunResultCliJson } from "./run/delivery.js";
import {
  formatFreshGitLabReviewPreview,
  previewFreshGitLabReviewDelivery,
} from "./review-delivery.js";

export type { RunRequestWithPublishProjection } from "./run/request.js";
export { serializeRunResultCliJson } from "./run/delivery.js";

/** CLI compatibility wrapper for the shared local workflow adapter. */
export async function executeRunRequest(
  request: RunRequestWithPublishProjection,
  config?: DocsFabConfig,
  options: CliRunOptions = {},
) {
  assertWorkflowActive(options.signal);
  const jsonRequested = options.json ?? request.json ?? false;
  const quietRequested = (options.quiet ?? request.quiet ?? false) && !jsonRequested;
  const silentRequested = options.silent ?? false;
  const effectiveOptions: CliRunOptions = {
    ...options,
    quiet: quietRequested,
    silent: silentRequested,
  };
  const coordinator = new RunInvocationOutputCoordinator((stream, message) => {
    if (silentRequested) return;
    if (stream === "stderr") console.error(message);
    else console.log(message);
  }, options.verbose ?? request.verbose);
  const initialProgress =
    jsonRequested || quietRequested || silentRequested || request.dryRun
      ? undefined
      : { phase: "started" as const, message: "Starting workflow." };
  try {
    return await withOutputCoordinator(
      coordinator,
      (_outputCoordinator, progress) =>
        executeCoordinatedRunRequest(
          request,
          config,
          options,
          effectiveOptions,
          jsonRequested,
          quietRequested,
          silentRequested,
          coordinator,
          progress,
        ),
      initialProgress,
    );
  } catch (error) {
    if (
      error instanceof CommentExistingMrHeadChangedError &&
      request.commentMr !== undefined &&
      request.commentMrRetry !== true
    ) {
      return executeRunRequest(
        {
          ...request,
          revision: "HEAD",
          commentMrRetry: true,
        },
        config,
        {
          ...options,
          commentExistingMr: effectiveOptions.commentExistingMr,
        },
      );
    }
    throw error;
  }
}

async function executeCoordinatedRunRequest(
  request: RunRequestWithPublishProjection,
  config: DocsFabConfig | undefined,
  options: CliRunOptions,
  effectiveOptions: CliRunOptions,
  jsonRequested: boolean,
  quietRequested: boolean,
  silentRequested: boolean,
  coordinator: RunInvocationOutputCoordinator,
  progress: PresentationProgressHandle | undefined,
) {
  if (request.dryRun) {
    await printDryRun(request, coordinator, silentRequested, jsonRequested, quietRequested);
    return undefined;
  }
  effectiveOptions.onProgress = (event, workflow) => {
    if (!jsonRequested && !quietRequested && !silentRequested) {
      coordinator.forwardProgressEvent(progress, event, workflow);
    }
    options.onProgress?.(event, workflow);
  };
  const bound = await bindCommentExistingMrRequest(request, effectiveOptions);
  const output = silentRequested
    ? {
        log: (_message: string): void => undefined,
        error: (_message: string): void => undefined,
      }
    : {
        log: (message: string): void => {
          coordinator.writeMessage("stdout", message);
        },
        error: (message: string): void => {
          coordinator.writeMessage("stderr", message);
        },
      };
  let preflightHeaderWritten = false;
  const onStatus = (message: string): void => {
    if (effectiveOptions.quiet || effectiveOptions.silent) return;
    const format = { tty: Boolean(process.stderr.isTTY) };
    if (!preflightHeaderWritten) {
      coordinator.writeMessage("stderr", formatSectionHeader("PREFLIGHT", format));
      preflightHeaderWritten = true;
    }
    coordinator.writeMessage("stderr", indentCliBody(message));
  };
  return withLocalWorkflowRun(
    bound.request,
    config,
    {
      ...bound.options,
      output,
      onStatus,
      prepareRequest: (selectedRequest) =>
        prepareCliPublicationRequest(selectedRequest, bound.options, onStatus),
    },
    async (context) => {
      const { invocation, workspace, preflight, execution } = context;
      if (context.preflightStopCode) {
        const recordPath = resolve(invocation.config.stateDirectory, `${execution.record.id}.json`);
        if (jsonRequested) {
          invocation.output.log(
            serializeRunResultCliJson(
              buildRunResultV1({
                record: execution.record,
                recordPath,
                exitCode: 1,
                repositoryPath: invocation.request.repositoryPath,
                nextSteps: [],
                htmlReport: null,
              }),
              execution.record,
            ).trimEnd(),
          );
        } else {
          invocation.output.error(
            context.preflightStopCode === "reviewer-policy-rejected"
              ? "Site bootstrap rejected the host reviewer policy before mutation."
              : "Site bootstrap rejected the application artifact before mutation.",
          );
          invocation.output.log(`Record: ${recordPath}`);
        }
        process.exitCode = 1;
        return { value: undefined };
      }
      if (context.disposition === "intent-stopped") {
        return {
          value: reportRequestIntentStop(
            invocation,
            execution.record,
            execution.exitCode === 2 ? 2 : 1,
          ),
        };
      }
      if (context.disposition === "stopped") {
        return {
          value: reportKnowledgeContinuationStop(invocation, execution.record),
        };
      }
      if (context.disposition === "already-completed" && !context.deliveryRequired) {
        return {
          value: reportCompletedKnowledgeContinuation(
            invocation,
            execution.record,
            context.completedAttempt!,
          ),
        };
      }
      let deliveryOutcome: import("./run/request.js").CliRunDeliveryOutcome | undefined;
      const value = await deliverCliRunResult(
        {
          ...invocation,
          options: {
            ...invocation.options,
            onDeliveryOutcome: (outcome) => {
              deliveryOutcome = outcome;
              invocation.options.onDeliveryOutcome?.(outcome);
            },
          },
        },
        workspace,
        preflight,
        execution,
      );
      if (execution.reviewDeliveryBinding && value.status === "succeeded") {
        const preview = await previewFreshGitLabReviewDelivery({
          stateDirectory: invocation.config.stateDirectory,
          runId: value.id,
          binding: execution.reviewDeliveryBinding,
        });
        invocation.options.onReviewDeliveryPreview?.(preview);
        invocation.output.error(formatFreshGitLabReviewPreview(preview));
      }
      return { value, ...(deliveryOutcome ? { deliveryOutcome } : {}) };
    },
  );
}

async function prepareCliPublicationRequest(
  request: RunRequestWithPublishProjection,
  options: CliRunOptions,
  status: (message: string) => void,
): Promise<RunRequestWithPublishProjection> {
  if (request.draftMr !== true) return request;
  const ensure = options.ensurePublicationFreshness ?? ensureLocalUserPublicationFreshness;
  const target = await ensurePreWriteFreshness(ensure, request, status);
  if (!target) {
    throw new Error("Draft merge-request freshness did not return a target snapshot.");
  }
  return { ...request, gitlabTargetAtRunStart: target };
}

/**
 * Await the `--draft-mr` freshness port and stamp the pre-write phase on its
 * refusal, so the operator error envelope renders the pre-write recovery. A
 * `try`, not a rejection handler, so a port that throws synchronously is marked
 * too.
 */
async function ensurePreWriteFreshness(
  ensure:
    | NonNullable<CliRunOptions["ensurePublicationFreshness"]>
    | typeof ensureLocalUserPublicationFreshness,
  request: RunRequestWithPublishProjection,
  status: (message: string) => void,
): Promise<LocalUserPublicationGitLabTargetSnapshot | undefined> {
  try {
    return await ensure({
      repositoryPath: request.repositoryPath,
      revision: request.revision,
      ...(request.revisionPolicy ? { revisionPolicy: request.revisionPolicy } : {}),
      ...(request.remoteName ? { remoteName: request.remoteName } : {}),
      status,
    });
  } catch (error) {
    throw markPreWriteFreshnessFailure(error, request.repositoryPath);
  }
}

async function bindCommentExistingMrRequest(
  request: RunRequestWithPublishProjection,
  options: CliRunOptions,
): Promise<{
  request: RunRequestWithPublishProjection;
  options: CliRunOptions;
}> {
  if (request.commentMr === undefined) return { request, options };
  const parsed = parseCommentMrTarget(request.commentMr);
  // Injection is the only way to obtain a host projector; the default throws.
  const port =
    options.commentExistingMr ?? (await loadDefaultCommentExistingMrPort(request.repositoryPath));
  const observed = await port.observe({
    target: parsed,
    repositoryPath: request.repositoryPath,
  });
  if (request.revision !== "HEAD" && request.revision !== observed.headSha) {
    throw new Error(
      "docsfab run --comment-mr binds the observed MR head; --revision must match that head.",
    );
  }
  return {
    request: {
      ...request,
      revision: observed.headSha,
      commentMrBinding: bindCommentExistingMrTarget(
        observed,
        request.workflow,
        request.commentMrRetry === true ? 1 : 0,
      ),
    },
    options: { ...options, commentExistingMr: port },
  };
}

async function printDryRun(
  request: RunRequestWithPublishProjection,
  coordinator: RunInvocationOutputCoordinator,
  silent: boolean,
  json: boolean,
  quiet: boolean,
): Promise<void> {
  // The preview's action removes --dry-run, so project effects from that exact
  // next invocation. An explicit composition defaults to a local patch unless
  // the operator selects --draft-mr on the next run.
  const nextGrants = resolveInteractiveDeliveryGrants({
    workflow: request.workflow,
    dryRun: false,
    patchOnly: false,
    draftMrFlag: false,
    allowWriteFlag: false,
    commentMr: false,
    routeOnly: false,
    explicitComposition: request.compositionId !== undefined,
  });
  const wouldWrite =
    nextGrants.allowWrite && workflowDeliveryCapabilities(getWorkflow(request.workflow)).patchOnly;
  const wouldPublish = deliveryPlanPublishes({
    workflow: request.workflow,
    grants: nextGrants,
    commentMr: false,
    dryRun: false,
  });
  if (json) {
    if (silent) return;
    await coordinator.writeMessage(
      "stdout",
      canonicalizeJsonEvidence({
        schemaVersion: 1,
        kind: "docsfab-dry-run",
        workflow: request.workflow,
        wouldWrite,
        wouldPublish,
        ...(request.githubPrReview
          ? { plannedPrBasis: { state: "unresolved", url: request.githubPrReview.url } }
          : {}),
      } as unknown as JsonEvidenceValue),
    );
    return;
  }
  const rendered = renderCliPreview(
    workflowPreviewFacts({
      workflow: request.workflow,
      repositoryPath: request.githubPrReview
        ? `Unresolved GitHub PR: ${request.githubPrReview.url}`
        : request.repositoryPath,
      wouldWrite,
      wouldPublish,
      title: `Dry run: ${request.workflow}`,
      nextActionLabel: "Run this selection",
      nextArguments: runPreviewNextArguments({ ...request, quiet }),
    }),
    quiet ? "quiet" : "normal",
  );
  if (!silent) {
    await writeRenderedPresentation(coordinator, {
      stdout: rendered.stdout.trimEnd(),
      stderr: rendered.stderr.trimEnd(),
    });
  }
}
