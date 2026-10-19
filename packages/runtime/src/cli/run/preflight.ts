// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { internalContentPath } from "../../config/internal-content.js";
import { isAbsolute, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { assertDocsFabProjectConfig, DOCSFAB_PROJECT_CONFIG_FILE } from "../../init.js";
import { MAX_CONFIG_BYTES } from "../../init/types.js";
import { loadAuthorizedDocImprovementWriteTask } from "../../doc-improvement-cli.js";
import {
  createCorpusLiveExecutionAuthorizer,
  parseLivingDocumentationDataset,
} from "../../quality-evaluation/corpus.js";
import { readStrictJson } from "../../quality-evaluation/corpus-files.js";
import {
  isNonInferenceRuntimeConfig,
  ModelRuntimeRequiredOperatorError,
} from "../../config/runtime-loader.js";
import { loadTrackedDocsFabProjectConfig } from "../../project-config-preflight.js";
import {
  buildContentIndex,
  contentIndexLimitations,
  describeContentIndexLimitation,
} from "../../content-ir/index.js";
import type { ContentIndexV1 } from "../../content-ir/contracts.js";
import { LocalImpactPostflightService } from "../../impact/index.js";
import { createModelEvidence } from "../../model/profile-evidence.js";
import { assertConfiguredModelEvidence } from "../../model/profile-inspection.js";
import {
  listTrackedRepositoryEntries,
  readTrackedRepositoryFile,
} from "../../repository/workspace/tracked-read.js";
import {
  RepositoryWorkspaceReadError,
  type RepositoryWorkspace,
} from "../../repository/workspace/contracts.js";
import {
  loadIaPlanReviewerPolicyFile,
  localIaRepositoryIdentity,
  type IaAnalysisExecutionAuthorizer,
  type IaPlanReviewerPolicy,
} from "../../ia/index.js";
import {
  loadSiteBootstrapApplicationBundle,
  type SiteBootstrapApplicationBundle,
} from "../../site-bootstrap/index.js";
import { getWorkflow } from "../../workflow-registry/catalog.js";
import { FileRunStore } from "../../records/file-store.js";
import { ensurePrivateRunDirectory } from "../../records/file-store.js";
import { createIndexedFileRunStore } from "../../records/run-index-store.js";
import { resolveDocsFabPublicationRoots } from "../../config/host-paths.js";
import type { CliRunInvocation } from "./request.js";
import type { RunRecord } from "../../records/contracts.js";
import type { WorkflowTaskInput } from "../../workflow-contracts/contracts.js";
import type { RstCapabilityAdmissionV1 } from "../../rst-authoring/capability-admission.js";
import { prepareRstCapabilityPreflight } from "./rst-capability-preflight.js";

export interface RunPreflight {
  readonly workflow: ReturnType<typeof getWorkflow>;
  /** Canonical task loaded from the authorized campaign before request interpretation. */
  readonly task?: WorkflowTaskInput;
  readonly iaRepositoryIdentity?: string;
  readonly releaseDefaultBranch?: string;
  readonly reviewerPolicy?: IaPlanReviewerPolicy;
  readonly siteBundle?: SiteBootstrapApplicationBundle;
  readonly analysisExecutionAuthorizer?: IaAnalysisExecutionAuthorizer;
  readonly repositoryContentDigestSha256?: string;
  /** Exact pre-write index retained for reader evidence admission. */
  readonly contentIndex?: ContentIndexV1;
  readonly impactPostflight?: LocalImpactPostflightService;
  /** The tracked `.docsfab.json` `documentationRoots` a write job read. */
  readonly documentationRoots?: readonly string[];
  /**
   * The `documentationRoots` entries the revision tracks as regular files,
   * from the same listing: each is a file root, never a directory.
   */
  readonly documentationRootFiles?: readonly string[];
  /** Every path the revision tracks, from the same listing, for a bare file name the request names. */
  readonly trackedPaths?: readonly string[];
  /** Existing regular Sphinx RST pages, subject to exact request and plan binding. */
  readonly rstUpdatePaths?: readonly string[];
  /** Internal capability result passed to the central runner admission boundary. */
  readonly rstCapabilityAdmission?: RstCapabilityAdmissionV1;
}

export interface RunPreflightStop {
  readonly workflow: RunPreflight["workflow"];
  readonly stoppedRecord: RunRecord;
  readonly code: "reviewer-policy-rejected" | "application-rejected";
}

/** Performs host-controlled validation before any runner or host operation is assembled. */
export async function prepareRunPreflight(
  invocation: CliRunInvocation,
  workspace: RepositoryWorkspace,
): Promise<RunPreflight | RunPreflightStop> {
  const { request, config, output } = invocation;
  const workflow = getWorkflow(request.workflow);
  const task =
    request.workflow === "update-documentation" && request.docImprovementCampaignPath
      ? await loadAuthorizedDocImprovementWriteTask(
          request.docImprovementCampaignPath,
          request.docImprovementReviewerPolicyPath!,
          workspace.sourcePath,
        )
      : request.task;
  const iaRepositoryIdentity =
    request.workflow === "ia-analysis" || request.workflow === "ia-plan"
      ? await localIaRepositoryIdentity(workspace.sourcePath)
      : undefined;
  let releaseDefaultBranch: string | undefined;
  if (request.workflow === "release-documentation-readiness") {
    const projectConfig = await loadTrackedDocsFabProjectConfig({
      sourcePath: workspace.sourcePath,
      readTrackedBytes: () =>
        readTrackedRepositoryFile(workspace, DOCSFAB_PROJECT_CONFIG_FILE, MAX_CONFIG_BYTES),
      surface: "release-documentation-readiness",
    });
    releaseDefaultBranch = projectConfig.gitlab.defaultBranch;
  }

  let reviewerPolicy: IaPlanReviewerPolicy | undefined;
  let siteBundle: SiteBootstrapApplicationBundle | undefined;
  let analysisExecutionAuthorizer: IaAnalysisExecutionAuthorizer | undefined;
  if (request.workflow === "ia-analysis" && request.runId) {
    if (isNonInferenceRuntimeConfig(config)) {
      throw new ModelRuntimeRequiredOperatorError();
    }
    if (
      !request.corpusExecutionAuthorizationPath ||
      !request.corpusReviewerPolicyPath ||
      !request.corpusCaseId ||
      !request.corpusTestedRevision
    ) {
      throw new Error("IA corpus execution authorization is incomplete.");
    }
    // Same evidence rule and situation as `profile inspect`, checked before any
    // corpus file is read: the authorizer binds this profile digest.
    const modelEvidence = createModelEvidence(config.model);
    assertConfiguredModelEvidence(modelEvidence, "policy");
    const profileSha256 = modelEvidence.profile.sha256;
    // Admit the synchronous content capability before starting sibling reads.
    const datasetPath = resolve(
      config.projectRoot,
      "../..",
      internalContentPath("livingDocumentationDataset"),
    );
    const [authorization, datasetValue, corpusReviewerPolicy] = await Promise.all([
      readStrictJson(request.corpusExecutionAuthorizationPath, { ownerOnly: true }),
      readStrictJson(datasetPath),
      loadIaPlanReviewerPolicyFile(request.corpusReviewerPolicyPath),
    ]);
    analysisExecutionAuthorizer = createCorpusLiveExecutionAuthorizer({
      authorization,
      dataset: parseLivingDocumentationDataset(datasetValue),
      reviewerPolicy: corpusReviewerPolicy,
      expectedTestedRevision: request.corpusTestedRevision,
      caseId: request.corpusCaseId,
      model: {
        provider: modelEvidence.provider,
        model: modelEvidence.model,
        profileSha256,
      },
    });
  }
  if (request.workflow === "site-bootstrap") {
    const runStore = createIndexedFileRunStore(config.stateDirectory);
    const reviewerPolicyPath =
      request.reviewerPolicyPath ?? process.env.DOCSFAB_IA_REVIEWER_POLICY_PATH?.trim();
    if (!reviewerPolicyPath) {
      const stoppedRecord = await persistSiteBootstrapPreflightFailure(
        invocation,
        workspace,
        runStore,
        "reviewer-policy-rejected",
      );
      return { workflow, stoppedRecord, code: "reviewer-policy-rejected" };
    }
    try {
      reviewerPolicy = await loadIaPlanReviewerPolicyFile(resolve(reviewerPolicyPath));
    } catch {
      const stoppedRecord = await persistSiteBootstrapPreflightFailure(
        invocation,
        workspace,
        runStore,
        "reviewer-policy-rejected",
      );
      return { workflow, stoppedRecord, code: "reviewer-policy-rejected" };
    }
    try {
      if (!request.planPath) throw new Error("missing application");
      siteBundle = await loadSiteBootstrapApplicationBundle(request.planPath, {
        now: new Date(),
        reviewerPolicy,
      });
    } catch {
      const stoppedRecord = await persistSiteBootstrapPreflightFailure(
        invocation,
        workspace,
        runStore,
        "application-rejected",
      );
      return { workflow, stoppedRecord, code: "application-rejected" };
    }
  }

  const writeCapable = workflow.steps.some((step) => step.mode === "write");
  if (writeCapable && request.draftMr === true) {
    await prepareDraftMrPublicationRoots(config.stateDirectory, workspace.path);
  }
  let repositoryContentDigestSha256: string | undefined;
  let contentIndex: ContentIndexV1 | undefined;
  let impactPostflight: LocalImpactPostflightService | undefined;
  let documentationRoots: readonly string[] | undefined;
  let documentationRootFiles: readonly string[] | undefined;
  let trackedPaths: readonly string[] | undefined;
  let rstUpdatePaths: readonly string[] | undefined;
  let rstCapabilityAdmission: RstCapabilityAdmissionV1 | undefined;
  if (writeCapable) {
    const includePaths = await documentationRootsForWriteJob(workspace);
    documentationRoots = includePaths;
    const trackedEntries = await listTrackedRepositoryEntries(workspace);
    const rstPreflight = await prepareRstCapabilityPreflight({
      request,
      task,
      workspace,
      documentationRoots: includePaths,
      trackedEntries,
    });
    rstUpdatePaths = rstPreflight.rstUpdatePaths;
    rstCapabilityAdmission = rstPreflight.rstCapabilityAdmission;
    trackedPaths = Object.freeze(
      trackedEntries.flatMap((entry) => (entry.path !== undefined ? [entry.path] : [])),
    );
    // Exact path and letter case: an untracked file, a link, or a directory
    // named like a page is never a file root.
    const trackedFiles = new Set(
      trackedEntries.flatMap((entry) =>
        entry.kind === "regular" && entry.path !== undefined ? [entry.path] : [],
      ),
    );
    documentationRootFiles = includePaths?.filter((root) => trackedFiles.has(root));
    // The export leaves tracked symlinks out; the index still needs to know
    // that a symlinked default docs directory exists.
    const trackedAliasPaths = trackedEntries
      .filter((entry) => entry.kind === "symlink" && entry.path !== undefined)
      .map((entry) => entry.path!);
    // The pages the request names. An anchor the index cannot admit stops the
    // run only on one of these.
    const targetPaths = [
      request.contextTarget?.sourcePath,
      request.contextTarget?.candidateParentPath,
    ].filter((path): path is string => path !== undefined);
    const beforeIndex = await buildContentIndex({
      repositoryPath: workspace.path,
      repositoryRevision: workspace.revision,
      ...(includePaths ? { includePaths } : {}),
      ...(trackedAliasPaths.length > 0 ? { trackedAliasPaths } : {}),
      ...(targetPaths.length > 0 ? { targetPaths } : {}),
    });
    // Navigation, stray symlinks, and anchors on pages the request does not
    // name are not content the job needs: name what the index recorded
    // instead of stopping, and continue.
    for (const limitation of contentIndexLimitations(beforeIndex)) {
      invocation.output.error(
        `Content index notice: ${describeContentIndexLimitation(limitation)}`,
      );
    }
    repositoryContentDigestSha256 = beforeIndex.repository.contentDigest;
    contentIndex = beforeIndex;
    impactPostflight = new LocalImpactPostflightService(beforeIndex, {
      ...(includePaths ? { includePaths } : {}),
      ...(trackedAliasPaths.length > 0 ? { trackedAliasPaths } : {}),
    });
  }
  return {
    workflow,
    ...(task ? { task } : {}),
    ...(iaRepositoryIdentity ? { iaRepositoryIdentity } : {}),
    ...(releaseDefaultBranch ? { releaseDefaultBranch } : {}),
    ...(reviewerPolicy ? { reviewerPolicy } : {}),
    ...(siteBundle ? { siteBundle } : {}),
    ...(analysisExecutionAuthorizer ? { analysisExecutionAuthorizer } : {}),
    ...(repositoryContentDigestSha256 ? { repositoryContentDigestSha256 } : {}),
    ...(contentIndex ? { contentIndex } : {}),
    ...(impactPostflight ? { impactPostflight } : {}),
    ...(documentationRoots ? { documentationRoots } : {}),
    ...(documentationRootFiles && documentationRootFiles.length > 0
      ? { documentationRootFiles }
      : {}),
    ...(trackedPaths ? { trackedPaths } : {}),
    ...(rstUpdatePaths ? { rstUpdatePaths } : {}),
    ...(rstCapabilityAdmission ? { rstCapabilityAdmission } : {}),
  };
}

/**
 * Draft-MR writes must fail before model execution when a sandbox or host
 * policy cannot provide the private roots that delivery will later use.
 */
async function prepareDraftMrPublicationRoots(
  stateDirectory: string,
  repositoryPath: string,
): Promise<void> {
  let roots: ReturnType<typeof resolveDocsFabPublicationRoots>;
  try {
    roots = resolveDocsFabPublicationRoots(process.env, stateDirectory);
    const paths = [roots.stateDirectory, roots.deliveryRoot, roots.receiptRoot];
    if (!paths.every((path) => isAbsolute(path) && !/[\0\r\n]/u.test(path))) {
      throw new Error("Private publication roots must be absolute and control-free.");
    }
    if (
      paths.some((path, index) =>
        paths.some((other, otherIndex) => otherIndex > index && overlaps(path, other)),
      ) ||
      overlaps(repositoryPath, roots.stateDirectory) ||
      overlaps(repositoryPath, roots.deliveryRoot) ||
      overlaps(repositoryPath, roots.receiptRoot)
    ) {
      throw new Error(
        "Private publication roots must be disjoint from one another and the repository.",
      );
    }
    await Promise.all(paths.map((path) => ensurePrivateRunDirectory(path)));
  } catch {
    throw new Error(
      "Draft-MR publication preflight failed: the effective state, delivery, or receipt root is not writable as an owner-private directory.",
    );
  }
}

function overlaps(left: string, right: string): boolean {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  return (
    left === right ||
    (!leftToRight.startsWith("..") && !isAbsolute(leftToRight)) ||
    (!rightToLeft.startsWith("..") && !isAbsolute(rightToLeft))
  );
}

async function persistSiteBootstrapPreflightFailure(
  invocation: CliRunInvocation,
  workspace: RepositoryWorkspace,
  store: FileRunStore,
  code: "reviewer-policy-rejected" | "application-rejected",
): Promise<RunRecord> {
  const timestamp = new Date().toISOString();
  const record: RunRecord = {
    schemaVersion: 2,
    id: invocation.request.runId ?? randomUUID(),
    workflow: invocation.request.workflow,
    repository: {
      sourcePath: workspace.sourcePath,
      requestedRevision: workspace.requestedRevision,
      revision: workspace.revision,
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "failed",
    error: `preflight-${code}`,
    createdAt: timestamp,
    startedAt: timestamp,
    completedAt: timestamp,
    durationMs: 0,
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [],
  };
  await store.save(record);
  return record;
}

async function documentationRootsForWriteJob(
  workspace: RepositoryWorkspace,
): Promise<readonly string[] | undefined> {
  let bytes: Buffer;
  try {
    bytes = await readTrackedRepositoryFile(
      workspace,
      DOCSFAB_PROJECT_CONFIG_FILE,
      MAX_CONFIG_BYTES,
    );
  } catch (error) {
    if (error instanceof RepositoryWorkspaceReadError && error.code === "not-tracked") {
      return undefined;
    }
    throw error;
  }
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  assertDocsFabProjectConfig(parsed);
  return parsed.documentationRoots;
}
