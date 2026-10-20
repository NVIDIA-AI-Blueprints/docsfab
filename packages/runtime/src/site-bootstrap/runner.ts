// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import { buildContentIndex } from "../content-ir/index.js";
import type { RepositoryEvidenceCollector, RepositoryTarget } from "../repository/contracts.js";
import type { RepositoryWorkspace } from "../repository/workspace/contracts.js";
import { DEFAULT_HEALING_POLICY, type ImpactPolicyBinding } from "../impact/index.js";
import type { IaPlanReviewerPolicy } from "../ia/plan-review.js";
import type { RepositoryCheckCapability } from "../templates/checks.js";
import type { TemplateSetCapability } from "../templates/load.js";
import {
  scaffoldSite,
  type TemplateScaffoldInput,
  type TemplateScaffoldSummary,
} from "../templates/scaffold.js";
import { TEMPLATE_CATALOG_POLICY } from "../templates/load.js";
import { validateSiteBootstrapApplicationBundle } from "./bundle.js";
import { runSiteBootstrapImpactPostflight } from "./impact.js";
import type {
  SiteBootstrapApplicationBundle,
  SiteBootstrapCurrentIndexBuilder,
  SiteBootstrapErrorCode,
  SiteBootstrapRunRecord,
  SiteBootstrapRunStore,
} from "./contracts.js";
import { SiteBootstrapRunnerError } from "./runner-error.js";

export { SiteBootstrapRunnerError };

declare const siteBootstrapApprovalBrand: unique symbol;
export interface SiteBootstrapApprovalGrant {
  readonly [siteBootstrapApprovalBrand]: true;
}

interface ApprovalBinding {
  bundleDigest: string;
  planDigest: string;
  reviewDigest: string;
  reviewerPolicyDigest: string;
  expiresAt: string;
}

const approvals = new WeakMap<SiteBootstrapApprovalGrant, ApprovalBinding>();

export function prepareSiteBootstrapApprovalGrant(options: {
  bundle: SiteBootstrapApplicationBundle;
  reviewerPolicy: IaPlanReviewerPolicy;
  evaluationTime: Date;
}): SiteBootstrapApprovalGrant {
  const bundle = validateSiteBootstrapApplicationBundle(options.bundle, {
    now: options.evaluationTime,
    reviewerPolicy: options.reviewerPolicy,
  });
  if (
    bundle.plan.payload.approval.status !== "approved" ||
    bundle.plan.payload.approval.requirement === "none"
  ) {
    throw new SiteBootstrapRunnerError("invalid-approval");
  }
  const grant = Object.freeze({}) as SiteBootstrapApprovalGrant;
  approvals.set(grant, {
    bundleDigest: bundle.digest,
    planDigest: bundle.plan.digest,
    reviewDigest: bundle.review.digest,
    reviewerPolicyDigest: bundle.reviewerPolicy.digest,
    expiresAt: bundle.review.expiresAt,
  });
  return grant;
}

export interface SiteBootstrapRunnerOptions {
  store: SiteBootstrapRunStore;
  repositoryEvidence: RepositoryEvidenceCollector;
  reviewerPolicy: IaPlanReviewerPolicy;
  currentIndex?: SiteBootstrapCurrentIndexBuilder;
  postflightIndex?: SiteBootstrapCurrentIndexBuilder;
  impactPolicy?: ImpactPolicyBinding;
  scaffold?: (input: TemplateScaffoldInput) => Promise<TemplateScaffoldSummary>;
  now?: () => Date;
  id?: () => string;
  /** Testable interruption seam after scaffold mutation and before patch capture. */
  afterScaffold?: () => void | Promise<void>;
  /**
   * The generic WorkflowRunner owns impact, patch, and terminal evidence in the
   * production CLI. Direct callers retain the self-finalizing default.
   */
  postMutationFinalization?: "internal" | "caller";
}

export interface SiteBootstrapRunInput {
  allowWrite: boolean;
  workspace: RepositoryWorkspace;
  repository: RepositoryTarget;
  bundle: SiteBootstrapApplicationBundle;
  approval: SiteBootstrapApprovalGrant;
  templates: TemplateSetCapability;
  checks: RepositoryCheckCapability;
}

export class SiteBootstrapRunner {
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly indexBuilder: SiteBootstrapCurrentIndexBuilder;
  private readonly postflightIndexBuilder: SiteBootstrapCurrentIndexBuilder;
  private readonly impactPolicy: ImpactPolicyBinding;
  private readonly scaffold: (input: TemplateScaffoldInput) => Promise<TemplateScaffoldSummary>;

  public constructor(private readonly options: SiteBootstrapRunnerOptions) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.indexBuilder = options.currentIndex ?? {
      build: (workspacePath, revision) =>
        buildContentIndex({
          repositoryPath: workspacePath,
          repositoryRevision: revision,
        }),
    };
    this.postflightIndexBuilder = options.postflightIndex ?? this.indexBuilder;
    this.impactPolicy = options.impactPolicy ?? {
      id: DEFAULT_HEALING_POLICY.id,
      version: DEFAULT_HEALING_POLICY.version,
      digest: DEFAULT_HEALING_POLICY.digest,
    };
    this.scaffold = options.scaffold ?? scaffoldSite;
  }

  public async run(input: SiteBootstrapRunInput): Promise<SiteBootstrapRunRecord> {
    const createdAt = this.timestamp();
    let bundle: SiteBootstrapApplicationBundle;
    try {
      bundle = validateSiteBootstrapApplicationBundle(input.bundle, {
        now: this.now(),
        reviewerPolicy: this.options.reviewerPolicy,
      });
    } catch {
      throw new SiteBootstrapRunnerError("invalid-bundle");
    }
    const record: SiteBootstrapRunRecord = {
      schemaVersion: 1,
      id: this.id(),
      operation: "site-bootstrap",
      repository: { ...input.repository },
      workspace: { strategy: "tracked-export", disposable: true },
      plan: {
        kind: "ia-plan",
        schemaVersion: 1,
        digest: bundle.plan.digest,
        repositoryRevision: bundle.plan.repository.revision,
        repositoryContentDigest: bundle.plan.repository.contentDigest,
      },
      status: "queued",
      createdAt,
      mutationBoundaryEntered: false,
    };
    await this.options.store.save(record);
    if (!input.allowWrite) return this.failBeforeMutation(record, "write-not-authorized");
    const approval = approvals.get(input.approval);
    if (
      !approval ||
      approval.bundleDigest !== bundle.digest ||
      approval.planDigest !== bundle.plan.digest ||
      approval.reviewDigest !== bundle.review.digest ||
      approval.reviewerPolicyDigest !== this.options.reviewerPolicy.digest ||
      this.timestamp() >= approval.expiresAt
    ) {
      return this.failBeforeMutation(record, "invalid-approval");
    }
    if (
      input.workspace.revision !== input.repository.revision ||
      input.repository.revision !== bundle.repository.revision
    ) {
      return this.failBeforeMutation(record, "stale-repository");
    }
    if (
      bundle.templateCatalogPolicy.id !== TEMPLATE_CATALOG_POLICY.id ||
      bundle.templateCatalogPolicy.version !== TEMPLATE_CATALOG_POLICY.version ||
      bundle.templateCatalogPolicy.digest !== input.templates.catalogDigest ||
      bundle.repositoryCheckPolicy.id !== input.checks.id ||
      bundle.repositoryCheckPolicy.version !== input.checks.version ||
      bundle.repositoryCheckPolicy.digest !== input.checks.digest
    ) {
      return this.failBeforeMutation(record, "policy-mismatch");
    }
    const currentIndex = await this.indexBuilder.build(
      input.workspace.path,
      input.workspace.revision,
    );
    if (
      currentIndex.repository.revision !== bundle.repository.revision ||
      currentIndex.repository.contentDigest !== bundle.repository.contentDigest ||
      currentIndex.indexDigest !== bundle.repository.indexDigest
    ) {
      return this.failBeforeMutation(record, "stale-repository");
    }

    record.status = "running";
    record.startedAt = this.timestamp();
    await this.options.store.save(record);
    record.mutationBoundaryEntered = true;
    let summary: TemplateScaffoldSummary | undefined;
    let failure: SiteBootstrapErrorCode | undefined;
    try {
      summary = await this.scaffold({
        templates: input.templates,
        workspace: input.workspace,
        index: currentIndex,
        plan: bundle.plan,
        evaluation: bundle.evaluation,
        evaluationInput: { ...bundle.evaluationInput, index: currentIndex },
        topics: bundle.topics,
        checks: input.checks,
      });
      await this.options.afterScaffold?.();
    } catch (error) {
      failure =
        error instanceof SiteBootstrapRunnerError && error.code === "interrupted"
          ? "interrupted"
          : "scaffold-failed";
    }

    if (this.options.postMutationFinalization === "caller") {
      if (summary && !failure) record.scaffold = summary;
      record.status = failure ? "failed" : "succeeded";
      if (failure) record.error = failure;
      record.completedAt = this.timestamp();
      await this.options.store.save(record);
      return record;
    }

    try {
      const afterIndex = await this.postflightIndexBuilder.build(
        input.workspace.path,
        input.workspace.revision,
      );
      record.impactPostflight = runSiteBootstrapImpactPostflight({
        before: currentIndex,
        after: afterIndex,
        policy: this.impactPolicy,
      });
      assertExpectedImpact(record.impactPostflight, bundle, Boolean(summary));
    } catch {
      record.impactPostflight = {
        schemaVersion: 1,
        status: "failed",
        reason: "analysis-failed",
      };
      failure ??= "impact-postflight-failed";
    }

    try {
      record.changes = await this.options.repositoryEvidence.capture({
        runId: record.id,
        repository: record.repository,
        workspacePath: input.workspace.path,
        persistPatch: true,
      });
      if (!record.changes.patch) throw new Error("missing patch");
      assertExpectedChanges(record.changes, bundle, Boolean(summary));
    } catch (error) {
      failure =
        error instanceof SiteBootstrapRunnerError && error.code === "unexpected-changes"
          ? "unexpected-changes"
          : "patch-persistence-failed";
    }

    if (summary && !failure) record.scaffold = summary;
    record.status = failure ? "failed" : "succeeded";
    if (failure) record.error = failure;
    record.completedAt = this.timestamp();
    try {
      await this.options.store.save(record);
    } catch {
      throw new SiteBootstrapRunnerError("terminal-record-failed");
    }
    return record;
  }

  private async failBeforeMutation(
    record: SiteBootstrapRunRecord,
    code: SiteBootstrapErrorCode,
  ): Promise<SiteBootstrapRunRecord> {
    record.status = "failed";
    record.error = code;
    record.completedAt = this.timestamp();
    await this.options.store.save(record);
    return record;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function assertExpectedChanges(
  changes: { files: Array<{ path: string; status: string; previousPath?: string }> },
  bundle: SiteBootstrapApplicationBundle,
  completed: boolean,
): void {
  const approved = bundle.plan.payload.outputScope.map((output) => output.path).sort(compare);
  const files = changes.files.map((file) => file.path).sort(compare);
  if (
    changes.files.some((file) => file.status !== "added" || file.previousPath !== undefined) ||
    files.some((path) => !approved.includes(path)) ||
    (completed &&
      (files.length !== approved.length || files.some((path, index) => path !== approved[index])))
  ) {
    throw new SiteBootstrapRunnerError("unexpected-changes");
  }
}

function assertExpectedImpact(
  evidence: NonNullable<SiteBootstrapRunRecord["impactPostflight"]>,
  bundle: SiteBootstrapApplicationBundle,
  completed: boolean,
): void {
  if (completed && evidence.status !== "completed") {
    throw new SiteBootstrapRunnerError("impact-postflight-failed");
  }
  if (evidence.status !== "completed") return;
  const approved = bundle.plan.payload.outputScope.map((output) => output.path).sort(compare);
  const changed = [...evidence.changedPaths].sort(compare);
  if (
    changed.some((path) => !approved.includes(path)) ||
    (completed &&
      (changed.length !== approved.length ||
        changed.some((path, index) => path !== approved[index])))
  ) {
    throw new SiteBootstrapRunnerError("impact-postflight-failed");
  }
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
