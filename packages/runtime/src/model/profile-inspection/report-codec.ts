// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../../json-evidence.js";
import {
  MODEL_CATALOG_FIELDS,
  decodeModelCatalogObservation,
  type ModelCatalogField,
  type ModelCatalogObservationV1,
  type ModelProfilePurpose,
} from "../catalog-contracts.js";
import { decodeModelCatalogObservationProvenance } from "../catalog-provenance.js";
import {
  MODEL_CATALOG_RECONCILIATION_REASON_CODES,
  reconcileModelCatalog,
} from "../catalog-reconciliation.js";
import {
  ANTHROPIC_API_CATALOG_ADAPTER,
  ANTHROPIC_API_CATALOG_SOURCE_ID,
  OPENAI_API_CATALOG_ADAPTER,
  OPENAI_API_CATALOG_SOURCE_ID,
} from "../catalog-serving-route.js";
import { validModelEvidenceProjection } from "../profile-evidence.js";
import { detectCredentialRuleIdsInValue } from "../../security/repository-scanner.js";
import {
  artifactId,
  catalogCell,
  inspectionField,
  remediationFor,
  reportReasons,
} from "./projection.js";
import {
  assertCredentialFree,
  dataObject,
  digest,
  invalidReport,
  SAFE_SOURCE_CODES,
  validTimestamp,
} from "./primitives.js";
import type {
  EvidenceCell,
  SafeValue,
  ModelProfileInspectionFieldV1,
  ModelProfileInspectionSourceV1,
  ModelProfileInspectionV1,
} from "./schema.js";

function expectedCatalogSourceIdentity(
  source: "inference" | "metadata",
  observation: ModelCatalogObservationV1,
): { sourceId: string; adapterId: string } | null {
  if (source === "metadata") {
    return observation.source.id === "source:ihub-metadata:authenticated" &&
      observation.source.adapter.id === "adapter:nvidia-inference-hub-metadata:authenticated"
      ? {
          sourceId: "source:ihub-metadata:authenticated",
          adapterId: "adapter:nvidia-inference-hub-metadata:authenticated",
        }
      : null;
  }
  if (
    observation.source.id === "nvidia-inference-api-model-catalog" &&
    observation.source.adapter.id === "adapter:nvidia-inference-api-model-catalog"
  ) {
    return {
      sourceId: "nvidia-inference-api-model-catalog",
      adapterId: "adapter:nvidia-inference-api-model-catalog",
    };
  }
  if (
    observation.source.id === OPENAI_API_CATALOG_SOURCE_ID &&
    observation.source.adapter.id === OPENAI_API_CATALOG_ADAPTER.id
  ) {
    return {
      sourceId: OPENAI_API_CATALOG_SOURCE_ID,
      adapterId: OPENAI_API_CATALOG_ADAPTER.id,
    };
  }
  if (
    observation.source.id === ANTHROPIC_API_CATALOG_SOURCE_ID &&
    observation.source.adapter.id === ANTHROPIC_API_CATALOG_ADAPTER.id
  ) {
    return {
      sourceId: ANTHROPIC_API_CATALOG_SOURCE_ID,
      adapterId: ANTHROPIC_API_CATALOG_ADAPTER.id,
    };
  }
  return null;
}

function validateReport(report: ModelProfileInspectionV1): void {
  try {
    dataObject(report, [
      "schemaVersion",
      "kind",
      "purpose",
      "generatedAt",
      "subject",
      "runtime",
      "catalog",
      "fields",
      "reasons",
      "remediation",
      "sha256",
    ]);
    if (
      report.schemaVersion !== 1 ||
      report.kind !== "docsfab-model-profile-inspection" ||
      (report.purpose !== "policy" && report.purpose !== "judge") ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(report.generatedAt) ||
      new Date(report.generatedAt).toISOString() !== report.generatedAt ||
      !/^[a-f0-9]{64}$/u.test(report.sha256)
    )
      invalidReport();
    dataObject(report.subject, ["provider", "model", "apiFormat", "apiDisposition"]);
    if (
      !safeProvider(report.subject.provider) ||
      !safeModel(report.subject.model) ||
      (report.subject.apiFormat !== "chat_completions" &&
        report.subject.apiFormat !== "messages") ||
      report.subject.apiDisposition !== "supported"
    ) {
      invalidReport();
    }
    dataObject(report.runtime, [
      "profileEvidence",
      "profileStatus",
      "effectiveLimitReason",
      "fallbackApplied",
      "configuredApprovalClaim",
      "configuredClaim",
      "verifiedApproval",
    ]);
    if (
      !["current", "stale", "unknown"].includes(report.runtime.profileStatus) ||
      !["none", "metadata-unknown", "metadata-stale"].includes(
        report.runtime.effectiveLimitReason,
      ) ||
      typeof report.runtime.fallbackApplied !== "boolean" ||
      !["present", "absent"].includes(report.runtime.configuredApprovalClaim) ||
      report.runtime.verifiedApproval !== "unknown" ||
      report.runtime.fallbackApplied !== (report.runtime.effectiveLimitReason !== "none")
    ) {
      invalidReport();
    }
    if (
      !validModelEvidenceProjection({
        provider: report.subject.provider,
        model: report.subject.model,
        profile: report.runtime.profileEvidence,
      }) ||
      report.runtime.profileEvidence.status !== report.runtime.profileStatus ||
      report.runtime.profileEvidence.effectiveLimitReason !== report.runtime.effectiveLimitReason
    ) {
      invalidReport();
    }
    dataObject(report.runtime.configuredClaim, [
      "freshness",
      "approvedSourceSha256",
      "effectiveDate",
      "reviewAfter",
      "verification",
    ]);
    if (
      report.runtime.configuredClaim.freshness !== report.runtime.profileStatus ||
      report.runtime.configuredClaim.verification !== "not-performed" ||
      !(
        report.runtime.configuredClaim.approvedSourceSha256 === null ||
        /^[a-f0-9]{64}$/u.test(report.runtime.configuredClaim.approvedSourceSha256)
      ) ||
      !nullableDate(report.runtime.configuredClaim.effectiveDate) ||
      !nullableDate(report.runtime.configuredClaim.reviewAfter)
    )
      invalidReport();
    dataObject(report.catalog, ["requested", "sources", "reconciliation"]);
    if (typeof report.catalog.requested !== "boolean") invalidReport();
    denseArray(report.catalog.sources, 2);
    if (
      report.catalog.sources.length !== 2 ||
      report.catalog.sources.map((item) => item.source).join(",") !== "inference,metadata"
    ) {
      invalidReport();
    }
    for (const source of report.catalog.sources) {
      dataObject(source, ["source", "status", "code", "evidence"]);
      if (
        !["inference", "metadata"].includes(source.source) ||
        !["not-requested", "observed", "unavailable"].includes(source.status) ||
        !(source.code === null || SAFE_SOURCE_CODES.has(source.code))
      )
        invalidReport();
      if (source.evidence !== null) {
        dataObject(source.evidence, ["observation", "provenance"]);
        const observation = decodeModelCatalogObservation(source.evidence.observation);
        const provenance = decodeModelCatalogObservationProvenance(
          source.evidence.provenance,
          observation,
        );
        const expectedIdentity = expectedCatalogSourceIdentity(source.source, observation);
        if (
          !expectedIdentity ||
          observation.purpose !== report.purpose ||
          !validTimestamp(observation.source.retrievedAt) ||
          observation.source.id !== expectedIdentity.sourceId ||
          observation.source.adapter.id !== expectedIdentity.adapterId ||
          observation.source.adapter.version !== "1.0.0" ||
          provenance.source.id !== expectedIdentity.sourceId ||
          provenance.source.adapter.id !== expectedIdentity.adapterId ||
          provenance.source.adapter.version !== "1.0.0" ||
          provenance.purpose !== report.purpose
        )
          invalidReport();
        if (
          canonicalizeJsonEvidence(observation as unknown as JsonEvidenceValue) !==
            canonicalizeJsonEvidence(source.evidence.observation as unknown as JsonEvidenceValue) ||
          canonicalizeJsonEvidence(provenance as unknown as JsonEvidenceValue) !==
            canonicalizeJsonEvidence(source.evidence.provenance as unknown as JsonEvidenceValue)
        ) {
          invalidReport();
        }
      }
      if ((source.status === "observed") !== (source.evidence !== null)) invalidReport();
      if (source.status === "not-requested" && report.catalog.requested) invalidReport();
      if (source.status !== "not-requested" && !report.catalog.requested) invalidReport();
    }
    denseArray(report.fields, MODEL_CATALOG_FIELDS.length);
    if (
      report.fields.length !== MODEL_CATALOG_FIELDS.length ||
      report.fields.some((item, index) => item.field !== MODEL_CATALOG_FIELDS[index])
    ) {
      invalidReport();
    }
    for (const field of report.fields) validateField(field, report.catalog.sources);
    const observedCount = report.catalog.sources.filter(
      (source) => source.status === "observed",
    ).length;
    if (observedCount > 0 !== (report.catalog.reconciliation !== null)) invalidReport();
    const proposalFields =
      report.catalog.reconciliation?.status === "proposed"
        ? (report.catalog.reconciliation.proposal?.fields ?? [])
        : [];
    const expectedFields = MODEL_CATALOG_FIELDS.map((field) =>
      inspectionField(
        field,
        { provider: report.subject.provider, model: report.subject.model },
        report.runtime.profileEvidence,
        report.catalog.sources,
        proposalFields,
      ),
    );
    if (!equalEvidence(report.fields, expectedFields)) invalidReport();
    stringArray(report.reasons);
    stringArray(report.remediation);
    if (
      report.reasons.join("\n") !== [...report.reasons].sort().join("\n") ||
      new Set(report.reasons).size !== report.reasons.length ||
      new Set(report.remediation).size !== report.remediation.length
    )
      invalidReport();
    if (
      report.reasons.some((reason) => !validReportReason(reason)) ||
      report.remediation.some((item) => !SAFE_REMEDIATION.has(item))
    )
      invalidReport();
    if (
      !report.reasons.includes("legacy-config-is-not-approval") ||
      !report.reasons.includes("verified-approval-unavailable")
    )
      invalidReport();
    if (report.catalog.reconciliation !== null) {
      validateReconciliation(
        report.catalog.reconciliation,
        report.catalog.sources,
        report.purpose,
        report.generatedAt,
      );
    }
    const decision = report.catalog.reconciliation?.decision;
    if (
      !equalEvidence(
        report.reasons,
        reportReasons(
          report.runtime.effectiveLimitReason,
          report.catalog.requested,
          report.catalog.sources,
          decision,
        ),
      ) ||
      !equalEvidence(
        report.remediation,
        remediationFor(
          report.runtime.effectiveLimitReason,
          report.catalog.requested,
          report.catalog.sources,
          decision,
        ),
      )
    )
      invalidReport();
    const { sha256, ...withoutDigest } = report;
    if (digest(withoutDigest) !== sha256) invalidReport();
    assertCredentialFree(report);
  } catch {
    throw new Error("Model profile inspection report is invalid or tampered.");
  }
}

function validateField(
  field: ModelProfileInspectionFieldV1,
  sources: ModelProfileInspectionSourceV1[],
): void {
  dataObject(field, [
    "field",
    "configured",
    "effective",
    "observed",
    "proposed",
    "approved",
    "drift",
  ]);
  validateCell(field.configured, field.field);
  validateCell(field.effective, field.field);
  validateCell(field.proposed, field.field);
  validateCell(field.approved, field.field);
  if (field.approved.state !== "unknown") invalidReport();
  if (
    field.field === "origin" &&
    [field.configured, field.effective, field.proposed].some((cell) => cell.state !== "redacted")
  )
    invalidReport();
  denseArray(field.observed, 2);
  for (const observation of field.observed) {
    dataObject(observation, ["source", "observationSha256", "provenanceSha256", "evidence"]);
    if (observation.source !== "inference" && observation.source !== "metadata") invalidReport();
    digests(observation.observationSha256, observation.provenanceSha256);
    validateCell(observation.evidence, field.field);
    const source = sources.find((item) => item.source === observation.source)?.evidence;
    const sourceField = source?.observation.fields.find((item) => item.field === field.field);
    const expectedCell = sourceField ? catalogCell(field.field, sourceField) : undefined;
    if (
      !source ||
      !expectedCell ||
      source.observation.sha256 !== observation.observationSha256 ||
      source.provenance.sha256 !== observation.provenanceSha256 ||
      canonicalizeJsonEvidence(expectedCell as unknown as JsonEvidenceValue) !==
        canonicalizeJsonEvidence(observation.evidence as unknown as JsonEvidenceValue)
    )
      invalidReport();
  }
  if (field.observed.length !== sources.filter((item) => item.status === "observed").length)
    invalidReport();
  dataObject(field.drift, ["status", "reasons"]);
  if (!["aligned", "different", "conflicting", "unknown"].includes(field.drift.status))
    invalidReport();
  stringArray(field.drift.reasons);
  if (field.drift.reasons.some((reason) => !SAFE_DRIFT_REASONS.has(reason))) invalidReport();
}

function validateCell(cell: EvidenceCell, field: ModelCatalogField): void {
  if (!cell || typeof cell !== "object") invalidReport();
  if (cell.state === "known") dataObject(cell, ["state", "value"]);
  else if (cell.state === "unknown" || cell.state === "unsupported") {
    dataObject(cell, ["state", "reason"]);
    if (typeof cell.reason !== "string" || !SAFE_CELL_REASONS.has(cell.reason)) invalidReport();
  } else if (cell.state === "redacted") {
    dataObject(cell, ["state", "reason"]);
    if (cell.reason !== "sensitive-boundary-redacted") invalidReport();
  } else if (cell.state === "conflicting") {
    dataObject(
      cell,
      cell.selected === undefined ? ["state", "candidates"] : ["state", "candidates", "selected"],
    );
    denseArray(cell.candidates, 64);
  } else invalidReport();
  canonicalizeJsonEvidence(cell as unknown as JsonEvidenceValue);
  if (cell.state === "known" && !validFieldValue(field, cell.value)) invalidReport();
  if (
    cell.state === "conflicting" &&
    [...cell.candidates, ...(cell.selected === undefined ? [] : [cell.selected])].some(
      (value) => !validFieldValue(field, value),
    )
  )
    invalidReport();
}

function validateReconciliation(
  value: NonNullable<ModelProfileInspectionV1["catalog"]["reconciliation"]>,
  sources: ModelProfileInspectionSourceV1[],
  purpose: ModelProfilePurpose,
  generatedAt: string,
): void {
  dataObject(value, [
    "status",
    "input",
    "observationSet",
    "proposal",
    "proposalProvenance",
    "decision",
  ]);
  if (value.status !== "proposed" && value.status !== "blocked") invalidReport();
  dataObject(value.input, [
    "observationSetId",
    "observationSetCompletedAt",
    "proposalId",
    "proposalCreatedAt",
    "decisionId",
  ]);
  if (
    !safeArtifactId(value.input.observationSetId) ||
    !safeArtifactId(value.input.proposalId) ||
    !safeArtifactId(value.input.decisionId) ||
    !validTimestamp(value.input.observationSetCompletedAt) ||
    !validTimestamp(value.input.proposalCreatedAt) ||
    value.input.observationSetCompletedAt !== generatedAt ||
    value.input.proposalCreatedAt !== generatedAt ||
    value.decision.createdAt !== generatedAt
  )
    invalidReport();
  const pairs = sources.flatMap((source) =>
    source.evidence
      ? [
          {
            observation: decodeModelCatalogObservation(source.evidence.observation),
            provenanceValue: source.evidence.provenance,
          },
        ]
      : [],
  );
  const observations = pairs.map((pair) => pair.observation);
  const provenance = pairs.map((pair) =>
    decodeModelCatalogObservationProvenance(pair.provenanceValue, pair.observation),
  );
  if (
    value.input.observationSetId !==
      artifactId("inspection-observations", purpose, generatedAt, observations) ||
    value.input.proposalId !==
      artifactId("inspection-proposal", purpose, generatedAt, observations) ||
    value.input.decisionId !== artifactId("inspection-decision", purpose, generatedAt, observations)
  )
    invalidReport();
  const expected = reconcileModelCatalog({
    purpose,
    ...value.input,
    observations,
    observationProvenance: provenance,
  });
  if (
    expected.status !== value.status ||
    !equalEvidence(expected.observationSet, value.observationSet) ||
    !equalEvidence(expected.decision, value.decision) ||
    (expected.status === "proposed" &&
      (!equalEvidence(expected.proposal, value.proposal) ||
        !equalEvidence(expected.proposalProvenance, value.proposalProvenance))) ||
    (expected.status === "blocked" &&
      (value.proposal !== null || value.proposalProvenance !== null))
  )
    invalidReport();
}

function equalEvidence(left: unknown, right: unknown): boolean {
  return (
    canonicalizeJsonEvidence(left as JsonEvidenceValue) ===
    canonicalizeJsonEvidence(right as JsonEvidenceValue)
  );
}

function denseArray(value: unknown, maximum: number): asserts value is unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).some((key) => typeof key === "symbol") ||
    Object.keys(value).length !== value.length
  )
    invalidReport();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalidReport();
  }
  if (Object.keys(descriptors).some((key) => key !== "length" && !/^\d+$/u.test(key)))
    invalidReport();
}

function stringArray(value: unknown): asserts value is string[] {
  denseArray(value, 256);
  if (value.some((item) => typeof item !== "string" || item.length === 0)) invalidReport();
}

function digests(...values: unknown[]): void {
  if (values.some((value) => typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)))
    invalidReport();
}

function nullableDate(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().startsWith(value);
}

function safeProvider(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value) &&
    detectCredentialRuleIdsInValue(value).length === 0
  );
}

function safeModel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.startsWith("/") &&
    detectCredentialRuleIdsInValue(value).length === 0
  );
}

function safeArtifactId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:/u.test(value) &&
    detectCredentialRuleIdsInValue(value).length === 0
  );
}

function validFieldValue(field: ModelCatalogField, value: SafeValue): boolean {
  if (field === "providerId") return safeProvider(value);
  if (field === "modelId") return safeModel(value);
  if (field === "origin") return false;
  if (field === "providerCreatedAt" || field === "providerUpdatedAt") {
    return validTimestamp(value);
  }
  if (["contextWindow", "maxInputTokens", "maxOutputTokens"].includes(field)) {
    return Number.isSafeInteger(value) && Number(value) > 0;
  }
  if (
    [
      "reasoning",
      "supportsDeveloperRole",
      "supportsReasoningEffort",
      "supportsSystemRole",
      "toolUse",
    ].includes(field)
  ) {
    return typeof value === "boolean";
  }
  if (["apiFormats", "inputModalities"].includes(field)) {
    return (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((item) =>
        field === "apiFormats"
          ? item === "chat_completions" || item === "messages"
          : item === "text" || item === "image",
      ) &&
      new Set(value).size === value.length &&
      [...value].sort().join("\n") === value.join("\n")
    );
  }
  if (["inputPrice", "outputPrice", "cacheReadPrice", "cacheWritePrice"].includes(field)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    try {
      dataObject(value, ["amountMicrounits", "currency", "unit"]);
      return (
        Number.isSafeInteger(value.amountMicrounits) &&
        Number(value.amountMicrounits) >= 0 &&
        /^[A-Z]{3}$/u.test(String(value.currency)) &&
        value.unit === "per-million-tokens"
      );
    } catch {
      return false;
    }
  }
  return safeText(value);
}

function safeText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    !value.includes("://") &&
    !value.includes("\\") &&
    !value.includes("..") &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:[/\\]/u.test(value) &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    detectCredentialRuleIdsInValue(value).length === 0
  );
}

const SAFE_CELL_REASONS = new Set([
  "no-verified-approval-evidence",
  "not-configured",
  "missing",
  "not-authoritative",
  "source-unavailable",
  "model-unsupported",
  "source-unsupported",
  "no-proposal",
  "no-proposal-value",
]);

const SAFE_DRIFT_REASONS = new Set([
  "source-conflict",
  "field-values-differ",
  "no-authoritative-value",
  "approval-unverified",
]);

const SAFE_REMEDIATION = new Set([
  "Run `docsfab profile inspect --catalog` for explicit read-only provider discovery.",
  "Do not treat unknown or stale metadata as an 8192-token DocsFab ceiling. Unique composition matches use installed windows; unmatched selections leave the provider as the ceiling.",
  "Resolve field-level catalog disagreement before preparing an approval artifact.",
  "Complete the governed proposal and approval chain; legacy environment configuration is not approval.",
  "The configured serving route has no implemented catalog-approval adapter.",
]);

function validReportReason(reason: string): boolean {
  if (
    [
      "legacy-config-is-not-approval",
      "verified-approval-unavailable",
      "fallback-metadata-unknown",
      "fallback-metadata-stale",
      "catalog-not-requested",
    ].includes(reason) ||
    MODEL_CATALOG_RECONCILIATION_REASON_CODES.includes(
      reason as (typeof MODEL_CATALOG_RECONCILIATION_REASON_CODES)[number],
    )
  )
    return true;
  const match = /^(inference|metadata)-catalog-(.+)$/u.exec(reason);
  return Boolean(match && SAFE_SOURCE_CODES.has(match[2]!));
}

export {
  expectedCatalogSourceIdentity,
  validateReport,
  validateField,
  validateCell,
  validateReconciliation,
  equalEvidence,
  denseArray,
  stringArray,
  digests,
  nullableDate,
  safeProvider,
  safeModel,
  safeArtifactId,
  validFieldValue,
  safeText,
  SAFE_CELL_REASONS,
  SAFE_DRIFT_REASONS,
  SAFE_REMEDIATION,
  validReportReason,
};
