// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RunRecord } from "../records/contracts.js";
import { createContractKit, deepFreeze } from "../contract-kit/index.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REVIEWER_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/u;

const SITE_CREATE_TASK = Object.freeze({
  kind: "ia-plan" as const,
  scope: "site" as const,
  mode: "create" as const,
});

export interface IaBootstrapCyclePackageReceipt {
  repositoryIdentity: string;
  repositoryRevision: string;
  inputDigest: string;
  expiresAt: string;
}

export interface IaBootstrapCycleReviewerCommand {
  reviewerPolicyPath: string;
  reviewerId: string;
  privateKeyPath: string;
}

export interface IaSiteBootstrapCycleReceiptV1 {
  schemaVersion: 1;
  kind: "docsfab-ia-site-bootstrap-cycle";
  disposition: "needs-human-decision";
  repositoryIdentity: string;
  repositoryRevision: string;
  analysis: { runId: string; inputDigest: string };
  planning: { runId: string; inputDigest: string; iaPlanDigest: string };
  expiresAt: string;
  writesAuthorized: false;
  nextCommand: string;
}

export interface IaSiteBootstrapCycleDependencies {
  provisionAnalysis(input: {
    repositoryIdentity: string;
    repositoryRevision: string;
    expiresAt: string;
    task: typeof SITE_CREATE_TASK;
  }): Promise<IaBootstrapCyclePackageReceipt>;
  runAnalysis(input: {
    repositoryIdentity: string;
    repositoryRevision: string;
    task: typeof SITE_CREATE_TASK;
    inputDigest: string;
  }): Promise<RunRecord>;
  provisionPlanning(input: {
    repositoryIdentity: string;
    repositoryRevision: string;
    task: typeof SITE_CREATE_TASK;
    analysisRunId: string;
    analysisInputDigest: string;
    analysisExpiresAt: string;
  }): Promise<IaBootstrapCyclePackageReceipt>;
  runPlanning(input: {
    repositoryIdentity: string;
    repositoryRevision: string;
    expiresAt: string;
    task: typeof SITE_CREATE_TASK;
    inputDigest: string;
  }): Promise<RunRecord>;
}

export class IaSiteBootstrapCycleError extends Error {
  public constructor(
    public readonly code:
      | "invalid-request"
      | "invalid-provision"
      | "invalid-run"
      | "migration-required",
  ) {
    super(`IA site bootstrap cycle rejected: ${code}.`);
    this.name = "IaSiteBootstrapCycleError";
  }
}

function fail(code: IaSiteBootstrapCycleError["code"]): never {
  throw new IaSiteBootstrapCycleError(code);
}

const { assertInert } = createContractKit({
  fail,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-run",
    invalidValue: "invalid-run",
    digestMismatch: "invalid-run",
    credentialMaterial: "invalid-run",
    schemaMismatch: "migration-required",
  },
});

/**
 * Harness-neutral read-only coordinator for the fixed site/create IA cycle.
 * It prepares the human approval command but never reads reviewer material,
 * approves a plan, grants writes, or invokes site-bootstrap.
 */
export class IaSiteBootstrapCycleCoordinator {
  public constructor(private readonly dependencies: IaSiteBootstrapCycleDependencies) {}

  public async run(input: {
    repositoryIdentity: string;
    repositoryRevision: string;
    expiresAt: string;
    commandRepositoryPath: string;
    reviewer: IaBootstrapCycleReviewerCommand;
  }): Promise<IaSiteBootstrapCycleReceiptV1> {
    validateRequest(input);
    const base = {
      repositoryIdentity: input.repositoryIdentity,
      repositoryRevision: input.repositoryRevision,
      expiresAt: input.expiresAt,
      task: SITE_CREATE_TASK,
    };
    const analysisInput = await this.dependencies.provisionAnalysis(base);
    validateProvision(analysisInput, input, "invalid-provision");
    const analysis = await this.dependencies.runAnalysis({
      ...base,
      inputDigest: analysisInput.inputDigest,
    });
    validateRun(analysis, "ia-analysis", input, false);

    const planningInput = await this.dependencies.provisionPlanning({
      ...base,
      analysisRunId: analysis.id,
      analysisInputDigest: analysisInput.inputDigest,
      analysisExpiresAt: analysisInput.expiresAt,
    });
    validateProvision(planningInput, input, "invalid-provision");
    const planning = await this.dependencies.runPlanning({
      ...base,
      inputDigest: planningInput.inputDigest,
    });
    const iaPlanDigest = validateRun(planning, "ia-plan", input, true);

    return deepFreeze({
      schemaVersion: 1,
      kind: "docsfab-ia-site-bootstrap-cycle",
      disposition: "needs-human-decision",
      repositoryIdentity: input.repositoryIdentity,
      repositoryRevision: input.repositoryRevision,
      analysis: { runId: analysis.id, inputDigest: analysisInput.inputDigest },
      planning: { runId: planning.id, inputDigest: planningInput.inputDigest, iaPlanDigest },
      expiresAt: analysisInput.expiresAt,
      writesAuthorized: false,
      nextCommand: approvalCommand(
        input.commandRepositoryPath,
        input.repositoryRevision,
        planning.id,
        input.reviewer,
      ),
    });
  }
}

function validateRequest(input: {
  repositoryIdentity: string;
  repositoryRevision: string;
  expiresAt: string;
  commandRepositoryPath: string;
  reviewer: IaBootstrapCycleReviewerCommand;
}): void {
  if (
    !SHA256.test(input.repositoryIdentity) ||
    !REVISION.test(input.repositoryRevision) ||
    !canonicalTimestamp(input.expiresAt) ||
    !nonempty(input.commandRepositoryPath) ||
    !nonempty(input.reviewer.reviewerPolicyPath) ||
    !nonempty(input.reviewer.privateKeyPath) ||
    !REVIEWER_ID.test(input.reviewer.reviewerId)
  ) {
    fail("invalid-request");
  }
}

function validateProvision(
  receipt: IaBootstrapCyclePackageReceipt,
  input: { repositoryIdentity: string; repositoryRevision: string; expiresAt: string },
  code: "invalid-provision",
): void {
  assertInert(receipt);
  if (
    receipt.repositoryIdentity !== input.repositoryIdentity ||
    receipt.repositoryRevision !== input.repositoryRevision ||
    receipt.expiresAt !== input.expiresAt ||
    !canonicalTimestamp(receipt.expiresAt) ||
    !SHA256.test(receipt.inputDigest)
  ) {
    fail(code);
  }
}

function validateRun(
  record: RunRecord,
  workflow: "ia-analysis" | "ia-plan",
  input: { repositoryIdentity: string; repositoryRevision: string },
  requirePlan: boolean,
): string {
  assertInert(record);
  if (
    !RUN_ID.test(record.id) ||
    record.workflow !== workflow ||
    record.status !== "succeeded" ||
    record.repository.revision !== input.repositoryRevision ||
    record.task?.kind !== "ia-plan" ||
    record.task.scope !== "site" ||
    record.task.mode !== "create"
  ) {
    fail("invalid-run");
  }
  const plans = (record.artifacts ?? []).filter(
    (artifact) =>
      artifact.role === "output" &&
      artifact.reference.kind === "ia-plan" &&
      artifact.reference.repositoryRevision === input.repositoryRevision &&
      SHA256.test(artifact.reference.digest),
  );
  if (!requirePlan) return "";
  if (plans.length !== 1) fail("invalid-run");
  return plans[0]!.reference.digest;
}

function approvalCommand(
  repositoryPath: string,
  revision: string,
  planningRunId: string,
  reviewer: IaBootstrapCycleReviewerCommand,
): string {
  return `docsfab ia approve --repo ${shellWord(repositoryPath)} --revision ${revision} --scope site --mode create --run-id ${shellWord(planningRunId)} --reviewer-policy ${shellWord(reviewer.reviewerPolicyPath)} --reviewer-id ${shellWord(reviewer.reviewerId)} --private-key ${shellWord(reviewer.privateKeyPath)}`;
}

function shellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
