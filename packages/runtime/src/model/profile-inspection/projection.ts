// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../../json-evidence.js";
import type { ModelProfileEvidence } from "../../records/contracts.js";
import type {
  ModelCatalogField,
  ModelCatalogFieldEvidenceV1,
  ModelCatalogProposalFieldV1,
  ModelProfilePurpose,
  ModelCatalogObservationV1,
} from "../catalog-contracts.js";
import type { ModelCatalogReconciliationDecisionV1 } from "../catalog-reconciliation.js";
import { MODEL_CATALOG_RECONCILIATION_REASON_CODES } from "../catalog-reconciliation.js";
import { digest } from "./primitives.js";
import type {
  EvidenceCell,
  SafeValue,
  ModelProfileInspectionFieldV1,
  ModelProfileInspectionSourceV1,
} from "./schema.js";

function inspectionField(
  field: ModelCatalogField,
  subject: { provider: string; model: string },
  profile: ModelProfileEvidence,
  sources: ModelProfileInspectionSourceV1[],
  proposal: ModelCatalogProposalFieldV1[],
): ModelProfileInspectionFieldV1 {
  const configured = configuredEvidenceCell(field, subject, profile, false);
  const effective = configuredEvidenceCell(field, subject, profile, true);
  const observed = sources.flatMap((item) =>
    item.evidence
      ? [
          {
            source: item.source,
            observationSha256: item.evidence.observation.sha256,
            provenanceSha256: item.evidence.provenance.sha256,
            evidence: catalogCell(
              field,
              item.evidence.observation.fields.find((candidate) => candidate.field === field),
            ),
          },
        ]
      : [],
  );
  const proposed = proposalCell(
    field,
    proposal.find((item) => item.field === field),
  );
  const approved: EvidenceCell = { state: "unknown", reason: "no-verified-approval-evidence" };
  const known = [configured, effective, proposed, ...observed.map((item) => item.evidence)]
    .filter((cell): cell is Extract<EvidenceCell, { state: "known" }> => cell.state === "known")
    .map((cell) => canonicalizeJsonEvidence(cell.value as JsonEvidenceValue));
  const conflicting =
    observed.some((item) => item.evidence.state === "conflicting") ||
    proposed.state === "conflicting";
  const different = new Set(known).size > 1;
  const status = conflicting
    ? "conflicting"
    : different
      ? "different"
      : known.length > 0
        ? "aligned"
        : "unknown";
  const reasons = [
    ...(conflicting ? ["source-conflict"] : []),
    ...(different ? ["field-values-differ"] : []),
    ...(known.length === 0 ? ["no-authoritative-value"] : []),
    "approval-unverified",
  ];
  return { field, configured, effective, observed, proposed, approved, drift: { status, reasons } };
}

function configuredEvidenceCell(
  field: ModelCatalogField,
  subject: { provider: string; model: string },
  profile: ModelProfileEvidence,
  effective: boolean,
): EvidenceCell {
  const contextWindow = effective
    ? profile.effectiveContextWindow
    : profile.configuredContextWindow;
  const maxInputTokens = effective
    ? profile.effectiveMaxInputTokens
    : profile.configuredMaxInputTokens;
  const maxOutputTokens = effective
    ? profile.effectiveMaxOutputTokens
    : profile.configuredMaxOutputTokens;
  const costs = profile.costPerMillionTokens;
  const values: Partial<Record<ModelCatalogField, SafeValue | null>> = {
    providerId: subject.provider,
    modelId: subject.model,
    apiFormats: [...profile.compatibility.apiFormats].sort(),
    contextWindow,
    maxInputTokens: maxInputTokens ?? null,
    maxOutputTokens,
    inputModalities: [...profile.input].sort(),
    reasoning: profile.reasoning,
    supportsDeveloperRole: profile.compatibility.supportsDeveloperRole,
    supportsReasoningEffort: profile.compatibility.supportsReasoningEffort,
    inputPrice: price(costs.input),
    outputPrice: price(costs.output),
    cacheReadPrice: price(costs.cacheRead),
    cacheWritePrice: price(costs.cacheWrite),
  };
  if (field === "origin") return { state: "redacted", reason: "sensitive-boundary-redacted" };
  const value = values[field];
  return value === undefined || value === null
    ? { state: "unknown", reason: "not-configured" }
    : { state: "known", value };
}

function catalogCell(
  field: ModelCatalogField,
  evidence: ModelCatalogFieldEvidenceV1 | undefined,
): EvidenceCell {
  if (field === "origin") return { state: "redacted", reason: "sensitive-boundary-redacted" };
  if (!evidence || evidence.state === "unknown") {
    return { state: "unknown", reason: evidence?.reason ?? "missing" };
  }
  if (evidence.state === "unsupported") return { state: "unsupported", reason: evidence.reason };
  if (evidence.state === "conflicting")
    return { state: "conflicting", candidates: evidence.candidates };
  return { state: "known", value: evidence.value };
}

function proposalCell(
  field: ModelCatalogField,
  evidence?: ModelCatalogProposalFieldV1,
): EvidenceCell {
  if (field === "origin") return { state: "redacted", reason: "sensitive-boundary-redacted" };
  if (!evidence || evidence.state === "unknown") return { state: "unknown", reason: "no-proposal" };
  if (evidence.state === "unsupported")
    return { state: "unsupported", reason: "source-unsupported" };
  if (evidence.state === "conflicting")
    return {
      state: "conflicting",
      candidates: [],
      ...(evidence.value === undefined ? {} : { selected: evidence.value }),
    };
  return evidence.value === undefined
    ? { state: "unknown", reason: "no-proposal-value" }
    : { state: "known", value: evidence.value };
}

function price(value: number | null): SafeValue | null {
  return value === null
    ? null
    : {
        amountMicrounits: Math.round(value * 1_000_000),
        currency: "USD",
        unit: "per-million-tokens",
      };
}

function reportReasons(
  effectiveLimitReason: ModelProfileEvidence["effectiveLimitReason"],
  requested: boolean,
  sources: ModelProfileInspectionSourceV1[],
  decision?: ModelCatalogReconciliationDecisionV1,
): string[] {
  return [
    ...new Set([
      "legacy-config-is-not-approval",
      "verified-approval-unavailable",
      ...(effectiveLimitReason === "metadata-unknown" ? ["fallback-metadata-unknown"] : []),
      ...(effectiveLimitReason === "metadata-stale" ? ["fallback-metadata-stale"] : []),
      ...(!requested ? ["catalog-not-requested"] : []),
      ...sources
        .filter((item) => item.status === "unavailable")
        .map((item) => `${item.source}-catalog-${item.code}`),
      ...(decision ? decision.reasons.map((reason) => reason.code) : []),
    ]),
  ].sort();
}

function remediationFor(
  effectiveLimitReason: ModelProfileEvidence["effectiveLimitReason"],
  requested: boolean,
  sources: readonly ModelProfileInspectionSourceV1[],
  decision?: ModelCatalogReconciliationDecisionV1,
): string[] {
  const output = [];
  if (!requested)
    output.push(
      "Run `docsfab profile inspect --catalog` for explicit read-only provider discovery.",
    );
  if (sources.some((item) => item.code === "adapter-not-implemented")) {
    output.push("The configured serving route has no implemented catalog-approval adapter.");
  }
  if (effectiveLimitReason !== "none") {
    output.push(
      "Do not treat unknown or stale metadata as an 8192-token DocsFab ceiling. Unique composition matches use installed windows; unmatched selections leave the provider as the ceiling.",
    );
  }
  if (decision?.disposition === "review-required" || decision?.disposition === "blocked") {
    output.push("Resolve field-level catalog disagreement before preparing an approval artifact.");
  }
  output.push(
    "Complete the governed proposal and approval chain; legacy environment configuration is not approval.",
  );
  return output;
}

function artifactId(
  prefix: string,
  purpose: ModelProfilePurpose,
  generatedAt: string,
  observations: ModelCatalogObservationV1[],
): string {
  return `${prefix}:${purpose}:${digest({ generatedAt, observations: observations.map((item) => item.sha256).sort() }).slice(0, 32)}`;
}

export {
  inspectionField,
  configuredEvidenceCell,
  catalogCell,
  proposalCell,
  price,
  reportReasons,
  remediationFor,
  artifactId,
};
