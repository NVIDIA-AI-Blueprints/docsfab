// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ModelCatalogField,
  ModelCatalogFieldValue,
  ModelCatalogFieldEvidenceV1,
  ModelCatalogObservationV1,
  ModelCatalogObservationSetV1,
  ModelProfileProposalV1,
  ModelCatalogProposalFieldV1,
  ModelProfilePurpose,
} from "../catalog-contracts.js";
import type {
  ModelCatalogObservationProvenanceV1,
  ModelCatalogProposalProvenanceV1,
} from "../catalog-provenance.js";
import type { ModelCatalogReconciliationDecisionV1 } from "../catalog-reconciliation.js";
import type { ModelProfileEvidence } from "../../records/contracts.js";

export const MODEL_PROFILE_INSPECTION_SCHEMA_VERSION = 1 as const;

type SafeValue = ModelCatalogFieldValue;

type EvidenceCell =
  | { state: "known"; value: SafeValue }
  | { state: "unknown"; reason: string }
  | { state: "conflicting"; candidates: SafeValue[]; selected?: SafeValue }
  | { state: "unsupported"; reason: string }
  | { state: "redacted"; reason: "sensitive-boundary-redacted" };

export interface ModelProfileInspectionFieldV1 {
  field: ModelCatalogField;
  configured: EvidenceCell;
  effective: EvidenceCell;
  observed: Array<{
    source: "inference" | "metadata";
    observationSha256: string;
    provenanceSha256: string;
    evidence: EvidenceCell;
  }>;
  proposed: EvidenceCell;
  approved: EvidenceCell;
  drift: {
    status: "aligned" | "different" | "conflicting" | "unknown";
    reasons: string[];
  };
}

export interface ModelProfileInspectionSourceV1 {
  source: "inference" | "metadata";
  status: "not-requested" | "observed" | "unavailable";
  code: string | null;
  evidence: {
    observation: ModelCatalogObservationV1;
    provenance: ModelCatalogObservationProvenanceV1;
  } | null;
}

export interface ModelProfileInspectionV1 {
  schemaVersion: typeof MODEL_PROFILE_INSPECTION_SCHEMA_VERSION;
  kind: "docsfab-model-profile-inspection";
  purpose: ModelProfilePurpose;
  generatedAt: string;
  subject: {
    provider: string;
    model: string;
    apiFormat: "chat_completions" | "messages";
    apiDisposition: "supported";
  };
  runtime: {
    profileEvidence: ModelProfileEvidence;
    profileStatus: "current" | "stale" | "unknown";
    effectiveLimitReason: "none" | "metadata-unknown" | "metadata-stale";
    fallbackApplied: boolean;
    configuredApprovalClaim: "present" | "absent";
    configuredClaim: {
      freshness: "current" | "stale" | "unknown";
      approvedSourceSha256: string | null;
      effectiveDate: string | null;
      reviewAfter: string | null;
      verification: "not-performed";
    };
    verifiedApproval: "unknown";
  };
  catalog: {
    requested: boolean;
    sources: ModelProfileInspectionSourceV1[];
    reconciliation: {
      status: "proposed" | "blocked";
      input: {
        observationSetId: string;
        observationSetCompletedAt: string;
        proposalId: string;
        proposalCreatedAt: string;
        decisionId: string;
      };
      observationSet: ModelCatalogObservationSetV1;
      proposal: ModelProfileProposalV1 | null;
      proposalProvenance: ModelCatalogProposalProvenanceV1 | null;
      decision: ModelCatalogReconciliationDecisionV1;
    } | null;
  };
  fields: ModelProfileInspectionFieldV1[];
  reasons: string[];
  remediation: string[];
  sha256: string;
}

export interface InspectModelProfileOptions {
  purpose?: ModelProfilePurpose;
  catalog?: boolean;
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  clock?: () => Date;
}

export interface ModelProfileInspectionPreflightV1 {
  schemaVersion: 1;
  kind: "docsfab-model-profile-inspection-preflight";
  purpose: ModelProfilePurpose;
  generatedAt: string;
  disposition: "unsupported";
  apiDisposition: "unsupported";
  reason: "unsupported-api-format";
  field: "MODEL_API_FORMAT" | "JUDGE_API_FORMAT";
  remediation: "Configure chat_completions and include it in the compatible API formats before inspection.";
  sha256: string;
}

export type { SafeValue, EvidenceCell };
