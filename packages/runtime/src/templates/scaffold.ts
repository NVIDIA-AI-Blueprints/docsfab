// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { IaEvaluationArtifact, IaPlanArtifact } from "../artifacts/index.js";
import { canonicalDigest, type ContentIndexV1 } from "../content-ir/index.js";
import type { EvaluateIaCandidateInput } from "../ia/evaluator.js";
import { acquireRepositoryWorkspaceLease } from "../repository/workspace/lease.js";
import { verifyActiveRepositoryWorkspace } from "../repository/workspace/tracked-read.js";
import type { RepositoryWorkspace } from "../repository/workspace/contracts.js";
import { authorizeTemplateScaffold } from "./authorization.js";
import {
  runRepositoryChecks,
  type RepositoryCheckCapability,
  type RepositoryCheckReport,
} from "./checks.js";
import type { TemplatePreviewTopic, TemplateSitePreview } from "./contracts.js";
import { resolveTemplateSet, TEMPLATE_CATALOG_POLICY, type TemplateSetCapability } from "./load.js";
import { preflightTemplatePaths } from "./paths.js";
import { previewSite } from "./preview.js";
import {
  applyTemplateTransaction,
  TemplateTransactionError,
  type TemplateTransactionSummary,
} from "./transaction.js";
import { validatePage, type TemplatePageValidation } from "./validate.js";
import {
  captureTemplateWorkspaceManifest,
  expectedTemplateWorkspaceManifest,
} from "./workspace-manifest.js";

export interface TemplateScaffoldInput {
  /** Opaque host-verified template set authority. */
  templates: TemplateSetCapability;
  /** Opaque active capability for a disposable, Git-free repository export. */
  workspace: RepositoryWorkspace;
  index: ContentIndexV1;
  plan: IaPlanArtifact;
  evaluation: IaEvaluationArtifact;
  evaluationInput: EvaluateIaCandidateInput;
  topics: TemplatePreviewTopic[];
  checks: RepositoryCheckCapability;
}

export interface TemplateScaffoldSummary {
  schemaVersion: 1;
  operation: "site" | "page";
  repository: { revision: string; contentDigest: string };
  planDigest: string;
  previewDigest: string;
  catalogDigest: string;
  outputs: Array<{
    path: string;
    format: "gfm" | "myst";
    contentSha256: string;
    template: TemplateSitePreview["outputs"][number]["template"];
    schema: TemplateSitePreview["outputs"][number]["schema"];
    evidenceGapCount: number;
    evidenceGaps: Array<{ code: string; field: string }>;
    todoCount: number;
    todos: Array<{ code: string; field: string }>;
  }>;
  validations: TemplatePageValidation[];
  transaction: TemplateTransactionSummary;
  repositoryChecks: RepositoryCheckReport;
  digest: string;
}

export class TemplateScaffoldError extends Error {
  public constructor(
    public readonly code:
      | "workspace-mismatch"
      | "invalid-evidence"
      | "authorization-expired"
      | "workspace-check-drift"
      | "page-count-mismatch"
      | "validation-failed"
      | "repository-check-failed",
    public readonly report?: RepositoryCheckReport,
  ) {
    super(`Template scaffold failed: ${code}.`);
    this.name = "TemplateScaffoldError";
  }
}

/**
 * Authorize, preview, validate, create, and check an approved site in a
 * disposable workspace. Repository checks run inside the transaction's
 * rollback boundary, so a failed check leaves no scaffold output behind.
 */
export async function scaffoldSite(input: TemplateScaffoldInput): Promise<TemplateScaffoldSummary> {
  return scaffold(input, "site");
}

/** Same governed operation, constrained to exactly one approved page. */
export async function scaffoldPage(input: TemplateScaffoldInput): Promise<TemplateScaffoldSummary> {
  if (input.topics.length !== 1) throw new TemplateScaffoldError("page-count-mismatch");
  return scaffold(input, "page");
}

async function scaffold(
  input: TemplateScaffoldInput,
  operation: "site" | "page",
): Promise<TemplateScaffoldSummary> {
  let release: (() => void) | undefined;
  let invalidateWorkspace = false;
  try {
    release = await acquireRepositoryWorkspaceLease(input.workspace);
  } catch {
    throw new TemplateScaffoldError("workspace-mismatch");
  }
  try {
    return await scaffoldWithLease(input, operation);
  } catch (error) {
    invalidateWorkspace =
      (error instanceof TemplateScaffoldError && error.code === "workspace-check-drift") ||
      (error instanceof TemplateTransactionError && error.code === "rollback-failed");
    throw error;
  } finally {
    release();
    if (invalidateWorkspace) await input.workspace.dispose();
  }
}

async function scaffoldWithLease(
  input: TemplateScaffoldInput,
  operation: "site" | "page",
): Promise<TemplateScaffoldSummary> {
  await assertWorkspaceRevision(input);
  assertEvidenceNodes(input);
  const authorizationTime = new Date();
  let bundle;
  try {
    bundle = resolveTemplateSet(input.templates);
  } catch {
    throw new TemplateScaffoldError("workspace-mismatch");
  }
  const authorized = authorizeTemplateScaffold({
    index: input.index,
    plan: input.plan,
    evaluation: input.evaluation,
    evaluationInput: input.evaluationInput,
    topics: input.topics,
    templateCatalog: {
      ...TEMPLATE_CATALOG_POLICY,
      digest: input.templates.catalogDigest,
    },
    repositoryChecks: {
      id: input.checks.id,
      version: input.checks.version,
      digest: input.checks.digest,
    },
    now: authorizationTime,
  });
  const preview = previewSite({
    bundle,
    plan: authorized,
    evaluationTime: authorizationTime.toISOString(),
    topics: input.topics,
  });
  const validations = preview.outputs.map((page) => validatePage({ bundle, page }));
  if (validations.some((report) => report.status === "failed")) {
    throw new TemplateScaffoldError("validation-failed");
  }
  const baselineManifest = await captureTemplateWorkspaceManifest(input.workspace.path);
  const pathPlan = await preflightTemplatePaths({
    workspacePath: input.workspace.path,
    outputs: preview.outputs.map((output) => ({
      templateName: output.slug.split("/").at(-1)!,
      relativePath: output.path,
    })),
  });
  let repositoryChecks: RepositoryCheckReport | undefined;
  let workspaceCheckDrift = false;
  let transaction: TemplateTransactionSummary;
  try {
    transaction = await applyTemplateTransaction(
      {
        plan: pathPlan,
        rendered: preview.outputs.map((output) => ({
          relativePath: output.path,
          content: output.content,
        })),
      },
      {
        beforeExclusiveWrite: async () => {
          await verifyActiveRepositoryWorkspace(input.workspace);
          assertAuthorizationEffective(authorized, new Date());
        },
        afterAllWrites: async () => {
          await verifyActiveRepositoryWorkspace(input.workspace);
          repositoryChecks = await runRepositoryChecks({
            workspacePath: input.workspace.path,
            capability: input.checks,
          });
          await verifyActiveRepositoryWorkspace(input.workspace);
          const expectedManifest = expectedTemplateWorkspaceManifest(
            baselineManifest,
            preview.outputs.map((output) => ({
              path: output.path,
              contentSha256: output.contentSha256,
              byteLength: Buffer.byteLength(output.content),
            })),
          );
          const actualManifest = await captureTemplateWorkspaceManifest(input.workspace.path);
          if (actualManifest.digest !== expectedManifest.digest) {
            workspaceCheckDrift = true;
            throw new TemplateScaffoldError("workspace-check-drift");
          }
          if (repositoryChecks.status !== "passed") {
            throw new TemplateScaffoldError("repository-check-failed", repositoryChecks);
          }
        },
      },
    );
  } catch (error) {
    if (repositoryChecks?.status === "failed") {
      throw new TemplateScaffoldError("repository-check-failed", repositoryChecks);
    }
    if (workspaceCheckDrift) throw new TemplateScaffoldError("workspace-check-drift");
    throw error;
  }
  if (!repositoryChecks) throw new TemplateScaffoldError("repository-check-failed");
  const value = {
    schemaVersion: 1 as const,
    operation,
    repository: { ...input.index.repository },
    planDigest: authorized.digest,
    previewDigest: preview.digest,
    catalogDigest: preview.catalogDigest,
    outputs: preview.outputs.map((output) => ({
      path: output.path,
      format: output.format,
      contentSha256: output.contentSha256,
      template: { ...output.template },
      schema: { ...output.schema },
      evidenceGapCount: output.evidenceGaps.length,
      evidenceGaps: output.evidenceGaps.map(({ code, field }) => ({ code, field })),
      todoCount: output.todos.length,
      todos: output.todos.map(({ code, field }) => ({ code, field })),
    })),
    validations,
    transaction,
    repositoryChecks,
  };
  return { ...value, digest: canonicalDigest(value) };
}

function assertEvidenceNodes(input: TemplateScaffoldInput): void {
  const known = new Set(input.index.nodes.map((node) => node.id));
  if (input.topics.some((topic) => topic.evidenceNodeIds.some((nodeId) => !known.has(nodeId)))) {
    throw new TemplateScaffoldError("invalid-evidence");
  }
}

function assertAuthorizationEffective(
  plan: ReturnType<typeof authorizeTemplateScaffold>,
  now: Date,
): void {
  const timestamp = now.toISOString();
  if (timestamp < plan.approval.approvedAt || timestamp >= plan.expiresAt) {
    throw new TemplateScaffoldError("authorization-expired");
  }
}

async function assertWorkspaceRevision(input: TemplateScaffoldInput): Promise<void> {
  try {
    await verifyActiveRepositoryWorkspace(input.workspace);
  } catch {
    throw new TemplateScaffoldError("workspace-mismatch");
  }
  if (
    input.workspace.revision !== input.index.repository.revision ||
    input.evaluationInput.index.repository.revision !== input.workspace.revision ||
    input.evaluationInput.index.repository.contentDigest !== input.index.repository.contentDigest
  ) {
    throw new TemplateScaffoldError("workspace-mismatch");
  }
}
