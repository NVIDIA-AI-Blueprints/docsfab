// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Hosted assembly of the existing approved-plan executor; task data grants nothing. */
import { validateArtifactReference } from "../artifacts/index.js";
import { canonicalJson } from "../content-ir/index.js";
import { deepFreeze } from "../contract-kit/index.js";
import type { RepositoryEvidenceCollector } from "../repository/contracts.js";
import type { RepositoryWorkspace } from "../repository/workspace/contracts.js";
import type { SiteBootstrapTaskInput } from "../workflow-contracts/contracts.js";
import type { IaPlanReviewerPolicy } from "../ia/plan-review.js";
import type { RepositoryCheckCapability } from "../templates/checks.js";
import type { TemplateSetCapability } from "../templates/load.js";
import { validateSiteBootstrapApplicationBundle } from "./bundle.js";
import type { SiteBootstrapApplicationBundle, SiteBootstrapRunStore } from "./contracts.js";
import { SiteBootstrapHostOperation } from "./host-operation.js";
import { prepareSiteBootstrapApprovalGrant, SiteBootstrapRunner } from "./runner.js";
import { SiteBootstrapRunnerError } from "./runner-error.js";

export interface HostedSiteBootstrapDependencies {
  /** Selected from project custody, independently of caller-supplied task fields. */
  readonly bundle: unknown;
  /** Protected host policy, never the policy claimed by an input bundle. */
  readonly reviewerPolicy: IaPlanReviewerPolicy;
  readonly templates: TemplateSetCapability;
  readonly checks: RepositoryCheckCapability;
  /** The host must retain the real operation record before private cleanup. */
  readonly store: SiteBootstrapRunStore;
}

export function assembleHostedSiteBootstrap(input: {
  task: SiteBootstrapTaskInput;
  workspace: RepositoryWorkspace;
  evidence: RepositoryEvidenceCollector;
  dependencies: HostedSiteBootstrapDependencies;
  /** Separate operation-specific host authorization, already checked by the assembler. */
  allowWrite: boolean;
  runId: string;
  now?: () => Date;
}): { task: SiteBootstrapTaskInput; hostOperations: SiteBootstrapHostOperation } {
  const now = input.now ?? (() => new Date());
  const bundle = verifyHostedSiteBootstrapSelection({
    task: input.task,
    bundle: input.dependencies.bundle,
    reviewerPolicy: input.dependencies.reviewerPolicy,
    repositoryRevision: input.workspace.revision,
    now: now(),
  });
  const task = deepFreeze(structuredClone(input.task));
  const approval = prepareSiteBootstrapApprovalGrant({
    bundle,
    reviewerPolicy: input.dependencies.reviewerPolicy,
    evaluationTime: now(),
  });
  const runner = new SiteBootstrapRunner({
    store: input.dependencies.store,
    repositoryEvidence: input.evidence,
    reviewerPolicy: input.dependencies.reviewerPolicy,
    postMutationFinalization: "caller",
    now,
    id: () => input.runId,
  });
  return {
    task,
    hostOperations: new SiteBootstrapHostOperation(runner, {
      allowWrite: input.allowWrite,
      workspace: input.workspace,
      repository: {
        sourcePath: input.workspace.sourcePath,
        requestedRevision: input.workspace.requestedRevision,
        revision: input.workspace.revision,
      },
      bundle,
      approval,
      templates: input.dependencies.templates,
      checks: input.dependencies.checks,
    }),
  };
}

/**
 * Trusted-host preselection seam for an already-signed approved application.
 * A custody caller may use this proof before disclosing an approved bundle to
 * another authorized actor. The policy is protected host state, never task data.
 */
export function verifyHostedSiteBootstrapSelection(input: {
  task: SiteBootstrapTaskInput;
  bundle: unknown;
  reviewerPolicy: IaPlanReviewerPolicy;
  repositoryRevision: string;
  now: Date;
}): SiteBootstrapApplicationBundle {
  const bundle = validateSiteBootstrapApplicationBundle(input.bundle, {
    reviewerPolicy: input.reviewerPolicy,
    now: input.now,
  });
  const plan = validateArtifactReference(input.task.plan, { expectedKind: "ia-plan" });
  const expectedTask = {
    kind: "site-bootstrap" as const,
    plan: {
      kind: bundle.plan.kind,
      schemaVersion: bundle.plan.schemaVersion,
      digest: bundle.plan.digest,
      repositoryRevision: bundle.plan.repository.revision,
      repositoryContentDigest: bundle.plan.repository.contentDigest,
    },
  };
  if (canonicalJson(input.task) !== canonicalJson(expectedTask) || plan.kind !== "ia-plan")
    throw new SiteBootstrapRunnerError("invalid-bundle");
  if (bundle.repository.revision !== input.repositoryRevision)
    throw new SiteBootstrapRunnerError("stale-repository");
  return bundle;
}
