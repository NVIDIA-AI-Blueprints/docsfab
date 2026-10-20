// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const TEMPLATE_FORMATS = ["gfm", "myst"] as const;
export type TemplateFormat = (typeof TEMPLATE_FORMATS)[number];

export const TEMPLATE_VARIABLES = ["title", "slug", "productName", "summary", "evidence"] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

export interface GovernedBundleEvidence {
  id: string;
  version: string;
  license: string;
  bundleSha256: string;
  source: {
    repository: string;
    revision: string;
    path: string;
  };
  files: Array<{ path: string; sha256: string }>;
}

export interface TemplateRenderSchema {
  schemaVersion: 1;
  format: TemplateFormat;
  variables: Array<{
    name: TemplateVariable;
    required: boolean;
  }>;
  minimumEvidenceNodes: number;
}

export interface GovernedTemplateDefinition {
  id: string;
  version: string;
  format: TemplateFormat;
  template: {
    path: string;
    sha256: string;
    content: string;
  };
  schema: {
    path: string;
    version: string;
    sha256: string;
    content: string;
  };
}

export interface GovernedTemplateBundle {
  evidence: GovernedBundleEvidence;
  manifest: {
    schemaVersion: 1;
    templates: GovernedTemplateDefinition[];
  };
}

export interface TemplateFileProvenance {
  sourceRepository: string;
  sourceRevision: string;
  sourcePath: string;
  version: string;
  license: string;
  sha256: string;
}

export interface TemplateCatalogEntry {
  id: string;
  version: string;
  format: TemplateFormat;
  template: TemplateFileProvenance;
  schema: TemplateFileProvenance;
}

export interface TemplateCatalog {
  schemaVersion: 1;
  bundle: {
    id: string;
    version: string;
    license: string;
    bundleSha256: string;
    sourceRepository: string;
    sourceRevision: string;
    sourcePath: string;
  };
  templates: TemplateCatalogEntry[];
  digest: string;
}

export interface TemplateListInput {
  bundle: GovernedTemplateBundle;
  format?: TemplateFormat;
}

export interface VerifiedTemplateFilesInput {
  evidence: GovernedBundleEvidence;
  /** Exact UTF-8 bytes decoded as strings after governed-bundle verification. */
  files: Record<string, string>;
  formats?: TemplateFormat[];
}

export interface ApprovedTemplatePlan {
  schemaVersion: 1;
  kind: "ia-plan";
  digest: string;
  repository: {
    revision: string;
    contentDigest: string;
  };
  planId: string;
  candidateId: string;
  iaEvaluation: {
    kind: "ia-evaluation";
    digest: string;
    repositoryRevision: string;
    repositoryContentDigest: string;
    eligible: true;
  };
  templateSelectionDigest: string;
  templateCatalogDigest: string;
  repositoryCheckPolicy: { id: string; version: string; digest: string };
  approval: {
    status: "approved";
    requirement: "maintainer" | "product-owner";
    approvedBy: string;
    approvedAt: string;
  };
  expiresAt: string;
  outputs: Array<{
    path: string;
    operation: "create";
  }>;
}

export interface TemplatePreviewTopic {
  id: string;
  slug: string;
  title: string;
  templateId: string;
  outputPath: string;
  productName?: string;
  summary?: string;
  evidenceNodeIds: string[];
}

export interface TemplatePreviewSiteInput {
  bundle: GovernedTemplateBundle;
  plan: ApprovedTemplatePlan;
  evaluationTime: string;
  topics: TemplatePreviewTopic[];
}

export type TemplateEvidenceGapCode =
  | "authoring-instructions-present"
  | "insufficient-node-evidence"
  | "missing-product-name"
  | "missing-required-summary"
  | "unresolved-template-placeholder";

export interface TemplateEvidenceGap {
  code: TemplateEvidenceGapCode;
  field: "evidence" | "productName" | "summary" | "template";
  message: string;
}

export interface TemplateTodo {
  code: TemplateEvidenceGapCode;
  field: "evidence" | "productName" | "summary" | "template";
  marker: string;
}

export interface TemplateOutputPreview {
  topicId: string;
  slug: string;
  path: string;
  format: TemplateFormat;
  content: string;
  contentSha256: string;
  template: TemplateFileProvenance;
  schema: TemplateFileProvenance;
  evidenceNodeIds: string[];
  evidenceGaps: TemplateEvidenceGap[];
  todos: TemplateTodo[];
}

export interface TemplateSitePreview {
  schemaVersion: 1;
  plan: {
    planId: string;
    candidateId: string;
    digest: string;
    repositoryRevision: string;
    repositoryContentDigest: string;
    iaEvaluationDigest: string;
  };
  catalogDigest: string;
  outputs: TemplateOutputPreview[];
  writesPerformed: false;
  digest: string;
}
