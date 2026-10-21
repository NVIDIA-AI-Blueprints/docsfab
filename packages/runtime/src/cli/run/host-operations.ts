// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dirname, resolve } from "node:path";

import { DurableArtifactStore } from "../../artifacts/index.js";
import { FoundationHostOperation } from "../../foundation/index.js";
import {
  IaPlanningHostOperation,
  LocalIaPlanningInputProvider,
  resolveIaPlanningProvisionNextCommand,
} from "../../ia/index.js";
import { artifactReference } from "../progress.js";
import { importDocumentationCanonBinding } from "../canon-snapshot.js";
import {
  assertResumeMatchesOriginal,
  readOriginalTaskBinding,
  type RequestedPageIntent,
} from "../knowledge-resume.js";
import { admittedFirstPassRequestIntent } from "../first-pass.js";
import { FoundationToPatchHostOperation } from "../../foundation/to-patch.js";
import { prepareTemplateSet, type TemplateSetCapability } from "../../templates/load.js";
import { TemplateAuditHostOperation } from "../../templates/audit-operation.js";
import {
  prepareSiteBootstrapApprovalGrant,
  prepareStandardSiteBootstrapChecks,
  SiteBootstrapHostOperation,
  SiteBootstrapRunner,
  type SiteBootstrapRunRecord,
} from "../../site-bootstrap/index.js";
import type { HostOperationExecutor } from "../../execution/contracts.js";
import type { KnowledgeResumeReceiptV1 } from "../../canon/from-knowledge-snapshot.js";
import type { RepositoryEvidenceCollector } from "../../repository/contracts.js";
import type { WorkflowTaskInput } from "../../workflow-contracts/contracts.js";
import type { RepositoryWorkspace } from "../../repository/workspace/contracts.js";
import type { CliRunInvocation } from "./request.js";
import type { RunPreflight } from "./preflight.js";
import { WorkflowChecksHostOperation } from "../../workflow-execution/workflow-checks.js";
import { createPrReviewCheckAdmission } from "../../workflow-execution/pr-review-check-admission.js";

export interface HostOperationAssembly {
  readonly task?: WorkflowTaskInput;
  readonly hostOperations?: HostOperationExecutor;
  readonly knowledgeResumeReceipt?: KnowledgeResumeReceiptV1;
  /** The verified template set an authoring workflow's planner and writer read. */
  readonly templateSet?: TemplateSetCapability;
}

/** Builds workflow-specific host operations independently of the generic runner. */
export async function assembleHostOperations(
  invocation: CliRunInvocation,
  workspace: RepositoryWorkspace,
  evidence: RepositoryEvidenceCollector,
  preflight: RunPreflight,
): Promise<HostOperationAssembly> {
  const { request, config } = invocation;
  let hostOperations: HostOperationExecutor | undefined;
  let task = preflight.task ?? request.task;
  let knowledgeResumeReceipt: KnowledgeResumeReceiptV1 | undefined;
  let templateSet: TemplateSetCapability | undefined;
  if (
    request.workflow === "review-documentation" ||
    AUTHORING_WORKFLOWS.includes(request.workflow)
  ) {
    templateSet = await authoringTemplateSet(config.projectRoot);
  }
  if (["review-documentation", ...AUTHORING_WORKFLOWS].includes(request.workflow)) {
    hostOperations = new WorkflowChecksHostOperation(workspace, "lint-documentation", {
      ...(templateSet ? { templates: templateSet } : {}),
      ...(invocation.githubPrBasis
        ? { prReviewAdmission: createPrReviewCheckAdmission(invocation.githubPrBasis) }
        : {}),
    });
  }
  if (request.canonSnapshotPath) {
    if (
      request.workflow !== "create-documentation" &&
      request.workflow !== "update-documentation"
    ) {
      throw new Error(
        "A --canon-snapshot is only valid with create-documentation or update-documentation.",
      );
    }
    const originalTask = await readOriginalTaskBinding(workspace.path);
    if (originalTask !== undefined) {
      assertResumeMatchesOriginal({
        workflow: request.workflow,
        instruction: request.instruction,
        original: originalTask,
      });
    }
    const binding = await importDocumentationCanonBinding(
      request.canonSnapshotPath,
      request.workflow,
      request.instruction,
      request.acceptCandidateSnapshot && request.canonSnapshotAuthorityId
        ? { authorityId: request.canonSnapshotAuthorityId }
        : undefined,
      canonSnapshotPageIntent(invocation, workspace.revision),
    );
    task = binding.task;
    knowledgeResumeReceipt = binding.knowledgeResumeReceipt;
  }
  if (request.workflow === "ia-plan") {
    if (task?.kind !== "ia-plan") throw new Error("ia-plan requires a fixed IA task.");
    const identity = preflight.iaRepositoryIdentity!;
    const missingPackageNextCommand = await resolveIaPlanningProvisionNextCommand({
      analysisOutputRoot: resolve(dirname(config.stateDirectory), "ia-analysis-outputs", identity),
      repositoryPath: workspace.path,
      repositoryRevision: workspace.revision,
      repositoryIdentity: identity,
      commandRepositoryPath: workspace.sourcePath,
      task,
      now: new Date(),
    });
    hostOperations = new IaPlanningHostOperation({
      artifactStore: new DurableArtifactStore(resolve(dirname(config.stateDirectory), "artifacts")),
      inputProvider: new LocalIaPlanningInputProvider({
        packageRoot: resolve(dirname(config.stateDirectory), "ia-inputs", identity),
        repositoryRevision: workspace.revision,
        repositoryIdentity: identity,
        packageDigest: request.inputDigest,
        missingPackageNextCommand,
      }),
    });
  } else if (request.workflow === "audit-documentation") {
    hostOperations = new TemplateAuditHostOperation(
      workspace,
      await prepareTemplateSet(config.projectRoot),
    );
  } else if (request.workflow === "foundation") {
    hostOperations = new FoundationHostOperation({
      artifactStore: new DurableArtifactStore(resolve(dirname(config.stateDirectory), "artifacts")),
    });
  } else if (request.workflow === "foundation-to-patch") {
    hostOperations = new FoundationToPatchHostOperation();
  } else if (request.workflow === "site-bootstrap") {
    if (!preflight.siteBundle)
      throw new Error("site-bootstrap requires a sealed application plan.");
    task = { kind: "site-bootstrap", plan: artifactReference(preflight.siteBundle.plan) };
    const templates = await prepareTemplateSet(config.projectRoot);
    const checks = await prepareStandardSiteBootstrapChecks();
    const approval = prepareSiteBootstrapApprovalGrant({
      bundle: preflight.siteBundle,
      reviewerPolicy: preflight.reviewerPolicy!,
      evaluationTime: new Date(),
    });
    const operationRunner = new SiteBootstrapRunner({
      store: { save: async (_record: SiteBootstrapRunRecord) => undefined },
      repositoryEvidence: evidence,
      reviewerPolicy: preflight.reviewerPolicy!,
      postMutationFinalization: "caller",
    });
    hostOperations = new SiteBootstrapHostOperation(operationRunner, {
      allowWrite: true,
      workspace,
      repository: {
        sourcePath: workspace.sourcePath,
        requestedRevision: workspace.requestedRevision,
        revision: workspace.revision,
      },
      bundle: preflight.siteBundle,
      approval,
      templates,
      checks,
    });
  }
  return {
    ...(task ? { task } : {}),
    ...(hostOperations ? { hostOperations } : {}),
    ...(knowledgeResumeReceipt ? { knowledgeResumeReceipt } : {}),
    ...(templateSet ? { templateSet } : {}),
  };
}

const AUTHORING_WORKFLOWS: readonly string[] = [
  "create-documentation",
  "update-documentation",
  "restructure-documentation",
];

/**
 * The verified template set for authoring guidance and the existing advisory
 * template audit, or `undefined` when it cannot be verified. Review coverage
 * then stays explicitly unknown rather than inventing a template mapping.
 */
async function authoringTemplateSet(
  projectRoot: string,
): Promise<TemplateSetCapability | undefined> {
  try {
    return await prepareTemplateSet(projectRoot);
  } catch {
    // hygiene: refusal — guidance is optional; authoring proceeds without it.
    return undefined;
  }
}

/**
 * The admitted pages a --canon-snapshot import checks support for: a
 * continuation's are the ones its stopped run stored (its own reading is the
 * `continuation` outcome, which admits nothing); a fresh run's are its own
 * admitted reading's. With neither, the import reads the request words.
 */
function canonSnapshotPageIntent(
  invocation: CliRunInvocation,
  revision: string,
): RequestedPageIntent | undefined {
  if (invocation.continuationPageIntent) return invocation.continuationPageIntent;
  const admitted = admittedFirstPassRequestIntent(invocation.request, revision);
  return admitted ? { writeTargets: admitted.writeTargets } : undefined;
}
