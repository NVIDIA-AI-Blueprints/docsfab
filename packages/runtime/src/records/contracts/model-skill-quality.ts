// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Model, skill, and quality evidence captured with a run.

import type { ModelProfileApiFormat } from "../../model/configuration.js";

export interface ModelEvidence {
  provider: string;
  model: string;
  profile?: ModelProfileEvidence;
}
export interface ModelProfileEvidence {
  schemaVersion: 1 | 2;
  status: "current" | "stale" | "unknown";
  configuredContextWindow: number;
  effectiveContextWindow: number;
  configuredMaxInputTokens?: number;
  effectiveMaxInputTokens?: number;
  configuredMaxOutputTokens: number;
  effectiveMaxOutputTokens: number;
  effectiveLimitReason: "none" | "metadata-unknown" | "metadata-stale" | "composition-candidate";
  apiFormat: ModelProfileApiFormat;
  reasoning: boolean;
  input: Array<"text" | "image">;
  compatibility: {
    supportsDeveloperRole: boolean;
    supportsReasoningEffort: boolean;
    apiFormats: ModelProfileApiFormat[];
  };
  requestPolicy: { minimumOutputTokens: number; reservedContextTokens: number };
  costPerMillionTokens: {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
  };
  pricing: "known" | "unknown";
  approvedSourceSha256?: string;
  effectiveDate?: string;
  reviewAfter?: string;
  sha256: string;
}
export interface SkillEvidence {
  id: string;
  contentSha256: string;
  bundleSha256?: string;
  version?: string;
  license?: string;
  provenanceStatus?: "docsfab-local" | "docsfab-adapted-import";
  source?: { repository: string; revision: string; path: string };
  inputs?: SkillInterfaceField[];
  outputs?: SkillInterfaceField[];
  toolPolicy?: SkillToolPolicy;
  evaluation?: SkillEvaluationEvidence;
  roadmapPack?: RoadmapSkillPackEvidence;
}
export interface RoadmapSkillPackBundleEvidence {
  id: string;
  bundleSha256: string;
  repository: string;
  revision: string;
  path: string;
  version: string;
  license: string;
}
export interface RoadmapSkillPackAdaptationEvidence {
  version: string;
  sha256: string;
  mappingSha256: string;
}
export interface RoadmapSkillPackEvidence {
  schemaVersion: 1;
  contractSha256: string;
  upstreamBundles: RoadmapSkillPackBundleEvidence[];
  adaptation: RoadmapSkillPackAdaptationEvidence;
}
export interface SkillEvaluationEvidence {
  id: string;
  version: number;
  path: string;
  sha256: string;
}
export interface SkillInterfaceField {
  name: string;
  description: string;
}
export interface SkillToolPolicy {
  /**
   * Canonical DocsFab tool ids. A name absent from `granted` never resolves at
   * the wire; the agent loop answers it with a synthetic "tool not found".
   * Catalog skills are checked against this when the crate loads.
   */
  declared: string[];
  granted: string[];
  withheld: string[];
}
export interface QualityPackEvidenceV1 {
  schemaVersion: 1;
  id: "docsfab-default";
  version: "1.0.0";
  manifestSha256: string;
  bindingSha256: string;
  skillLockSha256: string;
  qualityLockSha256: string;
  qualityBundleSha256: string;
  barIds: string[];
  /** Resources the run binds from the pack; absent on records from before the declaration. */
  resolvedResources?: ResolvedResourceSetV1;
}
/** One resource a run binds, with the layer that supplied it. */
export interface ResolvedResourceV1 {
  kind: "style-profile" | "evaluation-profile";
  /** The quality bar id, such as `profile:nvidia-technical-documentation`. */
  id: string;
  layer: "product";
  version: string;
  /** sha256-lines over the resource's locked files in path order. */
  sha256: string;
}
/**
 * The resolved resource set. Only the product layer is built, so the
 * organization, target, and request layers are always listed as unresolved.
 */
export interface ResolvedResourceSetV1 {
  schemaVersion: 1;
  declarationPath: "profiles/product-default.json";
  declarationSha256: string;
  resources: ResolvedResourceV1[];
  unresolvedLayers: ["organization", "target", "request"];
}
export interface QualityProfileSelectionReceiptV1 {
  schemaVersion: 1;
  kind: "docsfab-quality-profile-selection-receipt";
  workflow: "review-documentation" | "create-documentation" | "update-documentation";
  selectorId:
    | "review-documentation:docsfab-documentation-quality:v1"
    | "create-documentation:docsfab-documentation-quality:v1"
    | "update-documentation:docsfab-documentation-quality:v1";
  workflowSourceSha256: string;
  repositoryIdentitySha256: string;
  repositoryRevision: string;
  inventorySha256: string;
  targetScope: "documentation-set";
  targetScopeSha256: string;
  targetPathSetSha256: string;
  applicabilitySha256: string;
  documentCount: number;
  qualityPackManifestSha256: string;
  qualityPackBindingSha256: string;
  skillLockSha256: string;
  qualityLockSha256: string;
  qualityBundleSha256: string;
  profileBarId: "profile:docsfab-documentation-quality";
  profileAssetPath: "profiles/docsfab-documentation-quality/profile.json";
  profilePayloadSha256: string;
  profileId: "docsfab-documentation-quality";
  profileVersion: "v0.1";
  profileModel: "documentation-quality-model-v0.2";
  profileStatus: "experimental";
  releaseGateEligible: false;
  selectionSha256: string;
}
export interface QualityArtifactDigestBindingV1 {
  recordSha256: string;
  payloadSha256: string;
}
export interface QualityValidatorInvocationReceiptV1 {
  schemaVersion: 1;
  kind: "docsfab-quality-validator-invocation-receipt";
  validator: "evaluation" | "quality-score" | "report-binding";
  program: "python3";
  scriptSha256: string;
  inputPayloadSha256s: string[];
  outcome: "passed" | "failed" | "unavailable";
  exitCode: number | null;
  stdoutSha256: string;
  stderrSha256: string;
  receiptSha256: string;
}
export interface QualityHostDerivationCountsV1 {
  schemaVersion: 1;
  kind: "docsfab-quality-host-derivation-counts";
  hostMetadataFieldsChanged: number;
  ruleDerivedFieldsChanged: number;
  duplicateLimitationsRemoved: number;
  coherenceLabelsCount: number;
}
export interface QualityEvaluatedCandidateV1 {
  readonly workflow: "create-documentation" | "update-documentation";
  readonly targetPaths: readonly string[];
  readonly patchSha256: string;
  readonly workspaceSnapshotSha256: string;
  readonly candidateOrdinal: 0 | 1 | null;
  readonly candidateDigest: string | null;
}
export interface QualityArtifactValidationBindingV1 {
  /** Absent on legacy read-only review bindings. Host-owned final authored bytes. */
  evaluatedCandidate?: QualityEvaluatedCandidateV1;
  schemaVersion: 1;
  kind: "docsfab-quality-artifact-validation-binding";
  runId: string;
  repositoryRevision: string;
  selectionSha256: string;
  qualityPackBindingSha256: string;
  evaluatorIdentitySha256: string;
  status: "passed" | "failed" | "incomplete";
  failureCode:
    | "candidate-invalid"
    | "target-scope-mismatch"
    | "evaluation-invalid"
    | "quality-score-invalid"
    | "report-binding-invalid"
    | "validator-unavailable"
    | "validator-integrity-invalid"
    | "artifact-integrity-invalid"
    | "technical-trace-incomplete"
    | null;
  artifacts: {
    evaluation: QualityArtifactDigestBindingV1 | null;
    qualityScore: QualityArtifactDigestBindingV1 | null;
    candidateReport: QualityArtifactDigestBindingV1 | null;
    finalReport: QualityArtifactDigestBindingV1 | null;
  };
  validatorAssets: {
    /** Optional so previously sealed quality validation bindings remain readable. */
    qualityRuleModuleSha256?: string;
    evaluationScriptSha256: string;
    evaluationSchemaSha256: string;
    qualityScoreScriptSha256: string;
    reportScriptSha256: string;
  };
  validators: {
    evaluation: QualityValidatorInvocationReceiptV1 | null;
    qualityScore: QualityValidatorInvocationReceiptV1 | null;
    reportBinding: QualityValidatorInvocationReceiptV1 | null;
  };
  /** Present only when host derivation completed; counts are retained even when zero. */
  hostDerivationCounts?: QualityHostDerivationCountsV1;
  bindingSha256: string;
}
