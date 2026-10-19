// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { IaEvaluationArtifact, IaPlanArtifact, PolicyBinding } from "../artifacts/index.js";
import type { ContentIndexV1 } from "../content-ir/contracts.js";
import type { ChangeEvidence } from "../impact/contracts.js";
import type { RepositoryTarget } from "../repository/contracts.js";
import type { EvaluateIaCandidateInput } from "../ia/evaluator.js";
import type { IaPlanReviewArtifact } from "../ia/plan-review.js";
import type {
  ImpactChangeRegion,
  ImpactPolicyBinding,
  ImpactRepositoryBinding,
} from "../impact/index.js";
import type { TemplatePreviewTopic } from "../templates/contracts.js";
import type { TemplateScaffoldSummary } from "../templates/scaffold.js";

export interface SiteBootstrapApplicationBundle {
  schemaVersion: 1;
  kind: "site-bootstrap-application";
  repository: {
    revision: string;
    contentDigest: string;
    indexDigest: string;
  };
  plan: IaPlanArtifact;
  review: IaPlanReviewArtifact;
  reviewerPolicy: PolicyBinding;
  evaluation: IaEvaluationArtifact;
  evaluationInput: EvaluateIaCandidateInput;
  topics: TemplatePreviewTopic[];
  templateCatalogPolicy: PolicyBinding;
  repositoryCheckPolicy: PolicyBinding;
  digest: string;
}

export type SiteBootstrapErrorCode =
  | "write-not-authorized"
  | "invalid-bundle"
  | "invalid-approval"
  | "stale-repository"
  | "policy-mismatch"
  | "scaffold-failed"
  | "interrupted"
  | "patch-persistence-failed"
  | "unexpected-changes"
  | "impact-postflight-failed"
  | "terminal-record-failed";

export type SiteBootstrapImpactPostflightEvidence =
  | {
      schemaVersion: 1;
      status: "completed";
      mode: "incremental";
      policy: ImpactPolicyBinding;
      beforeRepository: ImpactRepositoryBinding;
      afterRepository: ImpactRepositoryBinding;
      analysisDigest: string;
      changedPaths: string[];
      changedRegions: ImpactChangeRegion[];
      affectedNodeIds: string[];
    }
  | {
      schemaVersion: 1;
      status: "no-change";
      policy: ImpactPolicyBinding;
      repository: ImpactRepositoryBinding;
    }
  | {
      schemaVersion: 1;
      status: "failed";
      reason: "analysis-failed";
    };

export interface SiteBootstrapRunRecord {
  schemaVersion: 1;
  id: string;
  operation: "site-bootstrap";
  repository: RepositoryTarget;
  workspace: { strategy: "tracked-export"; disposable: true };
  plan: {
    kind: "ia-plan";
    schemaVersion: 1;
    digest: string;
    repositoryRevision: string;
    repositoryContentDigest: string;
  };
  status: "queued" | "running" | "succeeded" | "failed";
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  mutationBoundaryEntered: boolean;
  scaffold?: TemplateScaffoldSummary;
  impactPostflight?: SiteBootstrapImpactPostflightEvidence;
  changes?: ChangeEvidence;
  error?: SiteBootstrapErrorCode;
}

export interface SiteBootstrapRunStore {
  save(record: SiteBootstrapRunRecord): Promise<void>;
}

export interface SiteBootstrapCurrentIndexBuilder {
  build(workspacePath: string, repositoryRevision: string): Promise<ContentIndexV1>;
}
