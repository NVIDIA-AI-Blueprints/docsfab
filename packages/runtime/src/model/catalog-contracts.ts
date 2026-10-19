// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { equalJson, invalid, valueKey } from "./catalog-contracts/canonical-values.js";
import { validateDerivation } from "./catalog-contracts/derivation.js";
import type { ModelProfile } from "./configuration.js";
import {
  canonicalizeJsonEvidence,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../json-evidence.js";
import { compareText } from "../shared/primitives.js";

export { ModelCatalogContractError } from "./catalog-contracts/canonical-values.js";

export const MODEL_CATALOG_SCHEMA_VERSION = 1 as const;

export const MODEL_CATALOG_FIELDS = [
  "activity",
  "apiFormats",
  "billingInterpretation",
  "cacheReadPrice",
  "cacheWritePrice",
  "contextWindow",
  "inputModalities",
  "inputPrice",
  "limitSemantics",
  "maxInputTokens",
  "maxOutputTokens",
  "modelId",
  "origin",
  "outputPrice",
  "providerCreatedAt",
  "providerId",
  "providerUpdatedAt",
  "reasoning",
  "supportsDeveloperRole",
  "supportsReasoningEffort",
  "supportsSystemRole",
  "toolUse",
] as const;
export type ModelCatalogField = (typeof MODEL_CATALOG_FIELDS)[number];

export const MODEL_CATALOG_FIELD_STATES = [
  "observed",
  "unknown",
  "conflicting",
  "unsupported",
] as const;
export type ModelCatalogFieldState = (typeof MODEL_CATALOG_FIELD_STATES)[number];
export type ModelProfilePurpose = "policy" | "judge";

export interface ModelCatalogPriceV1 {
  /** Integer minor amount at 10^-6 currency units; avoids floating-point rates. */
  amountMicrounits: number;
  currency: string;
  unit: "per-million-tokens";
}

export type ModelCatalogFieldValue = boolean | number | string | string[] | ModelCatalogPriceV1;

export interface ObservedModelCatalogFieldV1 {
  field: ModelCatalogField;
  state: "observed";
  value: ModelCatalogFieldValue;
}

export interface UnknownModelCatalogFieldV1 {
  field: ModelCatalogField;
  state: "unknown";
  reason: "missing" | "not-authoritative" | "source-unavailable";
}

export interface UnsupportedModelCatalogFieldV1 {
  field: ModelCatalogField;
  state: "unsupported";
  reason: "model-unsupported" | "source-unsupported";
}

export interface ConflictingModelCatalogFieldV1 {
  field: ModelCatalogField;
  state: "conflicting";
  candidates: ModelCatalogFieldValue[];
}

export type ModelCatalogFieldEvidenceV1 =
  | ObservedModelCatalogFieldV1
  | UnknownModelCatalogFieldV1
  | UnsupportedModelCatalogFieldV1
  | ConflictingModelCatalogFieldV1;

export interface ModelCatalogObservationV1 {
  schemaVersion: typeof MODEL_CATALOG_SCHEMA_VERSION;
  kind: "docsfab-model-catalog-observation";
  id: string;
  purpose: ModelProfilePurpose;
  source: {
    id: string;
    adapter: { id: string; version: string };
    retrievedAt: string;
  };
  fields: ModelCatalogFieldEvidenceV1[];
  sha256: string;
}

export interface ModelCatalogObservationBindingV1 {
  id: string;
  sha256: string;
}

/** A complete host-discovered boundary for provenance/signature layers to trust. */
export interface ModelCatalogObservationSetV1 {
  schemaVersion: typeof MODEL_CATALOG_SCHEMA_VERSION;
  kind: "docsfab-model-catalog-observation-set";
  id: string;
  purpose: ModelProfilePurpose;
  completedAt: string;
  observations: ModelCatalogObservationBindingV1[];
  sha256: string;
}

export interface ModelCatalogFieldReferenceV1 {
  observationId: string;
  observationSha256: string;
  field: ModelCatalogField;
}

export const MODEL_CATALOG_RECONCILIATION_RULES = [
  "array-intersection@1",
  "boolean-conjunction@1",
  "combined-context-input-clamp@1",
  "exact-consensus@1",
  "minimum-number@1",
  "qualified-model-label@1",
  "select-runtime-source@1",
  "prefer-observed@1",
  "propagate-no-authoritative-value@1",
  "propagate-unknown@1",
  "propagate-unsupported@1",
  "select-observation@1",
  "unresolved-conflict@1",
] as const;
export type ModelCatalogReconciliationRule = (typeof MODEL_CATALOG_RECONCILIATION_RULES)[number];

export type ModelCatalogFieldDerivationV1 =
  | {
      kind: "observation";
      input: ModelCatalogFieldReferenceV1;
    }
  | {
      kind: "rule";
      rule: ModelCatalogReconciliationRule;
      inputs: ModelCatalogFieldReferenceV1[];
    };

export interface ModelCatalogProposalFieldV1 {
  field: ModelCatalogField;
  state: ModelCatalogFieldState;
  value?: ModelCatalogFieldValue;
  derivation: ModelCatalogFieldDerivationV1;
}

export interface ModelProfileProposalV1 {
  schemaVersion: typeof MODEL_CATALOG_SCHEMA_VERSION;
  kind: "docsfab-model-profile-proposal";
  id: string;
  purpose: ModelProfilePurpose;
  createdAt: string;
  observationSet: ModelCatalogObservationBindingV1;
  observations: ModelCatalogObservationBindingV1[];
  fields: ModelCatalogProposalFieldV1[];
  sha256: string;
}

export interface OperatorApprovedModelProfileV1 {
  schemaVersion: typeof MODEL_CATALOG_SCHEMA_VERSION;
  kind: "docsfab-operator-approved-model-profile";
  id: string;
  purpose: ModelProfilePurpose;
  proposalSha256: string;
  approvedBy: string;
  approvedAt: string;
  effectiveDate: string;
  reviewAfter: string;
  fields: ModelCatalogProposalFieldV1[];
  sha256: string;
}

export type ModelCatalogArtifactV1 =
  | ModelCatalogObservationV1
  | ModelCatalogObservationSetV1
  | ModelProfileProposalV1
  | OperatorApprovedModelProfileV1;

export function finalizeModelCatalogObservation(
  input: Omit<ModelCatalogObservationV1, "schemaVersion" | "kind" | "sha256">,
): ModelCatalogObservationV1 {
  const artifact = {
    schemaVersion: MODEL_CATALOG_SCHEMA_VERSION,
    kind: "docsfab-model-catalog-observation" as const,
    ...input,
    fields: normalizedEvidenceFields(input.fields),
    sha256: "",
  };
  artifact.sha256 = artifactDigest(artifact);
  return validateObservation(artifact);
}

export function finalizeModelProfileProposal(
  input: Omit<ModelProfileProposalV1, "schemaVersion" | "kind" | "sha256">,
  observationSet: ModelCatalogObservationSetV1,
  observations: readonly ModelCatalogObservationV1[],
): ModelProfileProposalV1 {
  const artifact = {
    schemaVersion: MODEL_CATALOG_SCHEMA_VERSION,
    kind: "docsfab-model-profile-proposal" as const,
    ...input,
    observations: [...input.observations].sort(compareBinding),
    fields: normalizedProposalFields(input.fields),
    sha256: "",
  };
  artifact.sha256 = artifactDigest(artifact);
  return validateModelProfileProposal(artifact, observationSet, observations);
}

export function finalizeModelCatalogObservationSet(
  input: Omit<ModelCatalogObservationSetV1, "schemaVersion" | "kind" | "sha256">,
  observations: readonly ModelCatalogObservationV1[],
): ModelCatalogObservationSetV1 {
  const artifact = {
    schemaVersion: MODEL_CATALOG_SCHEMA_VERSION,
    kind: "docsfab-model-catalog-observation-set" as const,
    ...input,
    observations: [...input.observations].sort(compareBinding),
    sha256: "",
  };
  artifact.sha256 = artifactDigest(artifact);
  return validateModelCatalogObservationSet(artifact, observations);
}

export function finalizeOperatorApprovedModelProfile(
  input: Omit<OperatorApprovedModelProfileV1, "schemaVersion" | "kind" | "sha256">,
  proposal: ModelProfileProposalV1,
  observationSet: ModelCatalogObservationSetV1,
  observations: readonly ModelCatalogObservationV1[],
): OperatorApprovedModelProfileV1 {
  const artifact = {
    schemaVersion: MODEL_CATALOG_SCHEMA_VERSION,
    kind: "docsfab-operator-approved-model-profile" as const,
    ...input,
    fields: normalizedProposalFields(input.fields),
    sha256: "",
  };
  artifact.sha256 = artifactDigest(artifact);
  return validateOperatorApprovedModelProfile(artifact, proposal, observationSet, observations);
}

export function decodeModelCatalogObservation(
  input: string | Uint8Array | unknown,
): ModelCatalogObservationV1 {
  return validateObservation(parsed(input));
}

export function decodeModelProfileProposal(
  input: string | Uint8Array | unknown,
  observationSet: ModelCatalogObservationSetV1,
  observations: readonly ModelCatalogObservationV1[],
): ModelProfileProposalV1 {
  return validateModelProfileProposal(parsed(input), observationSet, observations);
}

export function decodeModelCatalogObservationSet(
  input: string | Uint8Array | unknown,
  observations: readonly ModelCatalogObservationV1[],
): ModelCatalogObservationSetV1 {
  return validateModelCatalogObservationSet(parsed(input), observations);
}

export function decodeOperatorApprovedModelProfile(
  input: string | Uint8Array | unknown,
  proposal: ModelProfileProposalV1,
  observationSet: ModelCatalogObservationSetV1,
  observations: readonly ModelCatalogObservationV1[],
): OperatorApprovedModelProfileV1 {
  return validateOperatorApprovedModelProfile(
    parsed(input),
    proposal,
    observationSet,
    observations,
  );
}

export function serializeModelCatalogArtifact(artifact: ModelCatalogArtifactV1): string {
  if (artifact.kind === "docsfab-model-catalog-observation") validateObservation(artifact);
  else if (artifact.kind === "docsfab-model-catalog-observation-set")
    validateObservationSetShape(artifact);
  else if (artifact.kind === "docsfab-model-profile-proposal") validateProposalShape(artifact);
  else validateApprovalShape(artifact);
  return canonicalizeJsonEvidence(artifact as unknown as JsonEvidenceValue);
}

/**
 * Preserve the existing runtime contract. Unknown catalog facts remain visible
 * in the approved artifact and become conservative runtime guardrails here.
 */
export function projectApprovedModelProfile(
  approvalValue: OperatorApprovedModelProfileV1,
  proposalValue: ModelProfileProposalV1,
  observationSet: ModelCatalogObservationSetV1,
  observations: readonly ModelCatalogObservationV1[],
  asOf: Date,
): ModelProfile {
  const approval = validateOperatorApprovedModelProfile(
    approvalValue,
    proposalValue,
    observationSet,
    observations,
  );
  const contextWindow = requiredNumber(approval.fields, "contextWindow");
  const maxInputTokens = requiredNumber(approval.fields, "maxInputTokens");
  const maxOutputTokens = requiredNumber(approval.fields, "maxOutputTokens");
  const origin = requiredString(approval.fields, "origin");
  const asOfMilliseconds = asOf.valueOf();
  if (
    !Number.isFinite(asOfMilliseconds) ||
    asOfMilliseconds < Date.parse(approval.approvedAt) ||
    asOfMilliseconds < Date.parse(`${approval.effectiveDate}T00:00:00.000Z`)
  )
    invalid();
  if (requiredString(approval.fields, "limitSemantics") !== "combined-context") invalid();
  const input = optionalStrings(approval.fields, "inputModalities").filter(
    (item): item is "text" | "image" => item === "text" || item === "image",
  );
  const apiFormats = optionalStrings(approval.fields, "apiFormats").filter(
    (item): item is "chat_completions" | "messages" =>
      item === "chat_completions" || item === "messages",
  );
  if (
    !input.includes("text") ||
    !hasApprovedGenerativeApiFormat(apiFormats) ||
    maxOutputTokens > contextWindow
  )
    invalid();
  // The approval's review date is advisory. A projection after that
  // date keeps the approved windows, capabilities and prices and stays
  // `current`; the advisory is rendered by display surfaces only.
  return {
    configuredLimits: { contextWindow, maxInputTokens, maxOutputTokens },
    contextWindow,
    maxInputTokens,
    maxOutputTokens,
    effectiveLimitReason: "none",
    reasoning: optionalBoolean(approval.fields, "reasoning") === true,
    input,
    compatibility: {
      supportsDeveloperRole: optionalBoolean(approval.fields, "supportsDeveloperRole") === true,
      supportsReasoningEffort:
        optionalBoolean(approval.fields, "supportsReasoningEffort") === true &&
        optionalBoolean(approval.fields, "reasoning") === true,
      apiFormats,
    },
    costPerMillionTokens: {
      input: optionalUsdPrice(approval.fields, "inputPrice"),
      output: optionalUsdPrice(approval.fields, "outputPrice"),
      cacheRead: optionalUsdPrice(approval.fields, "cacheReadPrice"),
      cacheWrite: optionalUsdPrice(approval.fields, "cacheWritePrice"),
    },
    metadata: {
      approvedSource: new URL(origin).toString(),
      effectiveDate: approval.effectiveDate,
      reviewAfter: approval.reviewAfter,
      status: "current",
    },
  };
}

function validateObservation(value: unknown): ModelCatalogObservationV1 {
  const root = closed(value, [
    "schemaVersion",
    "kind",
    "id",
    "purpose",
    "source",
    "fields",
    "sha256",
  ]);
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-model-catalog-observation") invalid();
  identifier(root.id);
  purpose(root.purpose);
  digest(root.sha256);
  const source = closed(root.source, ["id", "adapter", "retrievedAt"]);
  identifier(source.id);
  timestamp(source.retrievedAt);
  const adapter = closed(source.adapter, ["id", "version"]);
  identifier(adapter.id);
  version(adapter.version);
  validateEvidenceFields(root.fields);
  const fields = root.fields as unknown as ModelCatalogFieldEvidenceV1[];
  if (
    ["modelId", "providerId", "origin"].some(
      (name) => fields.find((field) => field.field === name)?.state !== "observed",
    )
  )
    invalid();
  const created = fields.find((field) => field.field === "providerCreatedAt");
  const updated = fields.find((field) => field.field === "providerUpdatedAt");
  if (
    created?.state === "observed" &&
    updated?.state === "observed" &&
    String(updated.value) < String(created.value)
  )
    invalid();
  if (artifactDigest(root) !== root.sha256) invalid();
  return root as unknown as ModelCatalogObservationV1;
}

export function validateModelCatalogObservationSet(
  value: unknown,
  observations: readonly ModelCatalogObservationV1[],
): ModelCatalogObservationSetV1 {
  const observationSet = validateObservationSetShape(value);
  const source = validatedObservationMap(observations, observationSet.purpose);
  const expected = [...source.values()]
    .map((item) => ({ id: item.id, sha256: item.sha256 }))
    .sort(compareBinding);
  if (
    !equalJson(observationSet.observations, expected) ||
    [...source.values()].some((item) => item.source.retrievedAt > observationSet.completedAt)
  )
    invalid();
  return observationSet;
}

function validateObservationSetShape(value: unknown): ModelCatalogObservationSetV1 {
  const root = closed(value, [
    "schemaVersion",
    "kind",
    "id",
    "purpose",
    "completedAt",
    "observations",
    "sha256",
  ]);
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-model-catalog-observation-set") invalid();
  identifier(root.id);
  purpose(root.purpose);
  timestamp(root.completedAt);
  digest(root.sha256);
  const bindings = denseArray(root.observations).map(binding);
  if (bindings.length === 0 || bindings.length > 64) invalid();
  orderedUnique(bindings.map((item) => item.id));
  if (artifactDigest(root) !== root.sha256) invalid();
  return root as unknown as ModelCatalogObservationSetV1;
}

export function validateModelProfileProposal(
  value: unknown,
  observationSetValue: ModelCatalogObservationSetV1,
  observations: readonly ModelCatalogObservationV1[],
): ModelProfileProposalV1 {
  const proposal = validateProposalShape(value);
  const observationSet = validateModelCatalogObservationSet(observationSetValue, observations);
  if (
    proposal.observationSet.id !== observationSet.id ||
    proposal.observationSet.sha256 !== observationSet.sha256 ||
    proposal.purpose !== observationSet.purpose ||
    proposal.createdAt < observationSet.completedAt
  )
    invalid();
  const source = validatedObservationMap(observations, proposal.purpose);
  if ([...source.values()].some((item) => item.source.retrievedAt > proposal.createdAt)) invalid();
  const expected = [...source.values()]
    .map((item) => ({ id: item.id, sha256: item.sha256 }))
    .sort(compareBinding);
  if (!equalJson(proposal.observations, expected)) invalid();
  for (const field of proposal.fields) validateDerivation(field, source);
  return proposal;
}

function validateProposalShape(value: unknown): ModelProfileProposalV1 {
  const root = closed(value, [
    "schemaVersion",
    "kind",
    "id",
    "purpose",
    "createdAt",
    "observationSet",
    "observations",
    "fields",
    "sha256",
  ]);
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-model-profile-proposal") invalid();
  identifier(root.id);
  purpose(root.purpose);
  timestamp(root.createdAt);
  binding(root.observationSet);
  digest(root.sha256);
  const bindings = denseArray(root.observations).map((item) => {
    const binding = closed(item, ["id", "sha256"]);
    identifier(binding.id);
    digest(binding.sha256);
    return binding;
  });
  if (bindings.length === 0 || bindings.length > 64) invalid();
  orderedUnique(bindings.map((item) => String(item.id)));
  validateProposalFields(root.fields);
  if (artifactDigest(root) !== root.sha256) invalid();
  return root as unknown as ModelProfileProposalV1;
}

export function validateOperatorApprovedModelProfile(
  value: unknown,
  proposalValue: ModelProfileProposalV1,
  observationSet: ModelCatalogObservationSetV1,
  observations: readonly ModelCatalogObservationV1[],
): OperatorApprovedModelProfileV1 {
  const approval = validateApprovalShape(value);
  const proposal = validateModelProfileProposal(proposalValue, observationSet, observations);
  const contextWindow = requiredNumber(approval.fields, "contextWindow");
  const maxInputTokens = requiredNumber(approval.fields, "maxInputTokens");
  const maxOutputTokens = requiredNumber(approval.fields, "maxOutputTokens");
  const inputModalities = requiredStrings(approval.fields, "inputModalities");
  const apiFormats = requiredStrings(approval.fields, "apiFormats");
  const observedPrice = ["inputPrice", "outputPrice", "cacheReadPrice", "cacheWritePrice"].some(
    (name) => approval.fields.find((field) => field.field === name)?.state === "observed",
  );
  if (
    approval.proposalSha256 !== proposal.sha256 ||
    approval.purpose !== proposal.purpose ||
    !approvalFieldsMatchProposal(approval.fields, proposal.fields) ||
    approval.approvedAt < proposal.createdAt ||
    approval.effectiveDate > approval.reviewAfter ||
    approval.approvedAt.slice(0, 10) > approval.effectiveDate ||
    approval.fields.some((field) => field.state === "conflicting") ||
    requiredString(approval.fields, "modelId").length === 0 ||
    requiredString(approval.fields, "providerId").length === 0 ||
    requiredString(approval.fields, "origin").length === 0 ||
    requiredString(approval.fields, "activity") !== "active" ||
    requiredString(approval.fields, "limitSemantics") !== "combined-context" ||
    maxInputTokens > contextWindow ||
    maxOutputTokens > contextWindow ||
    maxInputTokens > contextWindow - maxOutputTokens ||
    !inputModalities.includes("text") ||
    !hasApprovedGenerativeApiFormat(apiFormats) ||
    (observedPrice &&
      approval.fields.find((field) => field.field === "billingInterpretation")?.state !==
        "observed")
  )
    invalid();
  return approval;
}

function approvalFieldsMatchProposal(
  approved: ModelCatalogProposalFieldV1[],
  proposed: ModelCatalogProposalFieldV1[],
): boolean {
  return (
    approved.length === proposed.length &&
    approved.every((field, index) => {
      const source = proposed[index];
      if (!source || field.field !== source.field) return false;
      if (equalJson(field, source)) return true;
      return (
        source.state === "conflicting" &&
        source.value !== undefined &&
        field.state === "observed" &&
        equalJson(field.value, source.value) &&
        equalJson(field.derivation, source.derivation)
      );
    })
  );
}

function validateApprovalShape(value: unknown): OperatorApprovedModelProfileV1 {
  const root = closed(value, [
    "schemaVersion",
    "kind",
    "id",
    "purpose",
    "proposalSha256",
    "approvedBy",
    "approvedAt",
    "effectiveDate",
    "reviewAfter",
    "fields",
    "sha256",
  ]);
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-operator-approved-model-profile")
    invalid();
  identifier(root.id);
  purpose(root.purpose);
  digest(root.proposalSha256);
  identifier(root.approvedBy);
  timestamp(root.approvedAt);
  date(root.effectiveDate);
  date(root.reviewAfter);
  digest(root.sha256);
  validateProposalFields(root.fields);
  if (artifactDigest(root) !== root.sha256) invalid();
  return root as unknown as OperatorApprovedModelProfileV1;
}

function validateEvidenceFields(value: unknown): ModelCatalogFieldEvidenceV1[] {
  const fields = denseArray(value).map((item) => {
    const base = record(item);
    catalogField(base.field);
    switch (base.state) {
      case "observed": {
        const observed = closed(base, ["field", "state", "value"]);
        fieldValue(observed.field as ModelCatalogField, observed.value);
        return observed;
      }
      case "unknown": {
        const unknown = closed(base, ["field", "state", "reason"]);
        if (
          !["missing", "not-authoritative", "source-unavailable"].includes(String(unknown.reason))
        )
          invalid();
        return unknown;
      }
      case "unsupported": {
        const unsupported = closed(base, ["field", "state", "reason"]);
        if (!["model-unsupported", "source-unsupported"].includes(String(unsupported.reason)))
          invalid();
        if (
          unsupported.reason === "model-unsupported" &&
          ![
            "apiFormats",
            "inputModalities",
            "reasoning",
            "supportsDeveloperRole",
            "supportsReasoningEffort",
            "supportsSystemRole",
            "toolUse",
          ].includes(String(unsupported.field))
        )
          invalid();
        return unsupported;
      }
      case "conflicting": {
        const conflicting = closed(base, ["field", "state", "candidates"]);
        const candidates = denseArray(conflicting.candidates);
        if (candidates.length < 2 || candidates.length > 64) invalid();
        for (const candidate of candidates)
          fieldValue(conflicting.field as ModelCatalogField, candidate);
        orderedUnique(candidates.map(valueKey));
        return conflicting;
      }
      default:
        return invalid();
    }
  });
  exactFields(fields.map((item) => String(item.field)));
  return fields as unknown as ModelCatalogFieldEvidenceV1[];
}

function validateProposalFields(value: unknown): ModelCatalogProposalFieldV1[] {
  const fields = denseArray(value).map((item) => {
    const base = closed(item, ["field", "state", "derivation"], ["value"]);
    const field = catalogField(base.field);
    if (!MODEL_CATALOG_FIELD_STATES.includes(base.state as ModelCatalogFieldState)) invalid();
    if (base.value !== undefined) fieldValue(field, base.value);
    if (
      (base.state === "observed" && base.value === undefined) ||
      ((base.state === "unknown" || base.state === "unsupported") && base.value !== undefined)
    )
      invalid();
    validateDerivationShape(base.derivation, field);
    return base;
  });
  exactFields(fields.map((item) => String(item.field)));
  return fields as unknown as ModelCatalogProposalFieldV1[];
}

function validateDerivationShape(value: unknown, field: ModelCatalogField): void {
  const base = record(value);
  if (base.kind === "observation") {
    const direct = closed(base, ["kind", "input"]);
    fieldReference(direct.input, field);
    return;
  }
  if (base.kind === "rule") {
    const rule = closed(base, ["kind", "rule", "inputs"]);
    if (!MODEL_CATALOG_RECONCILIATION_RULES.includes(rule.rule as ModelCatalogReconciliationRule))
      invalid();
    const inputs = denseArray(rule.inputs);
    if (inputs.length === 0) invalid();
    const allowedFields =
      rule.rule === "combined-context-input-clamp@1" && field === "maxInputTokens"
        ? (["contextWindow", "limitSemantics", "maxInputTokens", "maxOutputTokens"] as const)
        : rule.rule === "qualified-model-label@1" && field === "modelId"
          ? (["modelId", "providerId"] as const)
          : ([field] as const);
    const keys = inputs.map((input) => {
      const root = record(input);
      if (!allowedFields.includes(root.field as never)) invalid();
      return fieldReference(input, root.field as ModelCatalogField);
    });
    orderedUnique(keys);
    return;
  }
  invalid();
}

function validatedObservationMap(
  values: readonly ModelCatalogObservationV1[],
  purposeValue: ModelProfilePurpose,
): Map<string, ModelCatalogObservationV1> {
  if (values.length === 0) invalid();
  const output = new Map<string, ModelCatalogObservationV1>();
  for (const value of values) {
    const observation = validateObservation(value);
    if (observation.purpose !== purposeValue || output.has(observation.id)) invalid();
    output.set(observation.id, observation);
  }
  return output;
}

function normalizedEvidenceFields(
  fields: ModelCatalogFieldEvidenceV1[],
): ModelCatalogFieldEvidenceV1[] {
  return fields
    .map((field) =>
      field.state === "observed"
        ? { ...field, value: normalizeValue(field.value) }
        : field.state === "conflicting"
          ? {
              ...field,
              candidates: field.candidates
                .map(normalizeValue)
                .sort((a, b) => compareText(valueKey(a), valueKey(b))),
            }
          : { ...field },
    )
    .sort(compareField);
}

function normalizedProposalFields(
  fields: ModelCatalogProposalFieldV1[],
): ModelCatalogProposalFieldV1[] {
  return fields
    .map((field) => {
      const { value, ...rest } = field;
      return {
        ...rest,
        ...(value === undefined ? {} : { value: normalizeValue(value) }),
        derivation:
          field.derivation.kind === "observation"
            ? { kind: "observation" as const, input: { ...field.derivation.input } }
            : {
                kind: "rule" as const,
                rule: field.derivation.rule,
                inputs: [...field.derivation.inputs]
                  .map((input) => ({ ...input }))
                  .sort(compareReference),
              },
      };
    })
    .sort(compareField);
}

function normalizeValue(value: ModelCatalogFieldValue): ModelCatalogFieldValue {
  if (Array.isArray(value)) return [...value].sort();
  if (typeof value === "object") return { ...value };
  return value;
}

function fieldValue(
  field: ModelCatalogField,
  value: unknown,
): asserts value is ModelCatalogFieldValue {
  switch (field) {
    case "activity":
      if (!["active", "inactive", "draft", "deprecated"].includes(String(value))) invalid();
      return;
    case "apiFormats":
      stringSet(value, ["chat_completions", "messages", "responses"]);
      return;
    case "billingInterpretation":
      if (!["authoritative-rate", "internal-chargeback", "explicitly-free"].includes(String(value)))
        invalid();
      return;
    case "inputModalities":
      stringSet(value, ["audio", "image", "text", "video"]);
      return;
    case "limitSemantics":
      if (!["combined-context", "independent-input-output"].includes(String(value))) invalid();
      return;
    case "cacheReadPrice":
    case "cacheWritePrice":
    case "inputPrice":
    case "outputPrice":
      price(value);
      return;
    case "contextWindow":
    case "maxInputTokens":
    case "maxOutputTokens":
      if (!Number.isSafeInteger(value) || Number(value) <= 0) invalid();
      return;
    case "modelId":
      modelId(value);
      return;
    case "providerId":
      identifier(value);
      return;
    case "origin":
      origin(value);
      return;
    case "providerCreatedAt":
    case "providerUpdatedAt":
      timestamp(value);
      return;
    case "reasoning":
    case "supportsDeveloperRole":
    case "supportsReasoningEffort":
    case "supportsSystemRole":
    case "toolUse":
      if (typeof value !== "boolean") invalid();
      return;
  }
}

function artifactDigest(value: Record<string, unknown>): string {
  const { sha256: _sha256, ...body } = value;
  return createHash("sha256")
    .update(canonicalizeJsonEvidence(body as JsonEvidenceValue))
    .digest("hex");
}

function parsed(input: string | Uint8Array | unknown): unknown {
  try {
    return typeof input === "string" || input instanceof Uint8Array
      ? parseJsonEvidence(input)
      : input;
  } catch {
    return invalid();
  }
}

function exactFields(fields: string[]): void {
  if (
    fields.length !== MODEL_CATALOG_FIELDS.length ||
    fields.some((field, index) => field !== MODEL_CATALOG_FIELDS[index])
  )
    invalid();
}

function fieldReference(value: unknown, field: ModelCatalogField): string {
  const root = closed(value, ["observationId", "observationSha256", "field"]);
  identifier(root.observationId);
  digest(root.observationSha256);
  if (root.field !== field) invalid();
  return `${root.observationId}:${root.field}`;
}

function binding(value: unknown): ModelCatalogObservationBindingV1 {
  const root = closed(value, ["id", "sha256"]);
  identifier(root.id);
  digest(root.sha256);
  return root as unknown as ModelCatalogObservationBindingV1;
}

function requiredField(
  fields: ModelCatalogProposalFieldV1[],
  name: ModelCatalogField,
): ModelCatalogProposalFieldV1 {
  const field = fields.find((item) => item.field === name);
  if (!field || field.state !== "observed" || field.value === undefined) invalid();
  return field;
}

function requiredString(fields: ModelCatalogProposalFieldV1[], name: ModelCatalogField): string {
  const value = requiredField(fields, name).value;
  if (typeof value !== "string") return invalid();
  return value;
}

function requiredNumber(fields: ModelCatalogProposalFieldV1[], name: ModelCatalogField): number {
  const value = requiredField(fields, name).value;
  if (typeof value !== "number") return invalid();
  return value;
}

function requiredStrings(fields: ModelCatalogProposalFieldV1[], name: ModelCatalogField): string[] {
  const value = requiredField(fields, name).value;
  if (!Array.isArray(value)) return invalid();
  return [...value];
}

function optionalBoolean(
  fields: ModelCatalogProposalFieldV1[],
  name: ModelCatalogField,
): boolean | undefined {
  const value = fields.find((item) => item.field === name)?.value;
  return typeof value === "boolean" ? value : undefined;
}

function optionalStrings(fields: ModelCatalogProposalFieldV1[], name: ModelCatalogField): string[] {
  const value = fields.find((item) => item.field === name)?.value;
  return Array.isArray(value) ? [...value] : [];
}

function optionalUsdPrice(
  fields: ModelCatalogProposalFieldV1[],
  name: ModelCatalogField,
): number | null {
  const value = fields.find((item) => item.field === name)?.value;
  return plain(value) && value.currency === "USD" && typeof value.amountMicrounits === "number"
    ? value.amountMicrounits / 1_000_000
    : null;
}

function price(value: unknown): asserts value is ModelCatalogPriceV1 {
  const root = closed(value, ["amountMicrounits", "currency", "unit"]);
  if (
    !Number.isSafeInteger(root.amountMicrounits) ||
    Number(root.amountMicrounits) < 0 ||
    typeof root.currency !== "string" ||
    !/^[A-Z]{3}$/u.test(root.currency) ||
    root.unit !== "per-million-tokens"
  )
    invalid();
}

function stringSet(value: unknown, allowed: readonly string[]): void {
  const strings = denseArray(value);
  if (
    strings.length === 0 ||
    strings.some((item) => typeof item !== "string" || !allowed.includes(item))
  )
    invalid();
  orderedUnique(strings as string[]);
}

function closed(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const root = record(value);
  const keys = Object.keys(root).sort();
  const allowed = [...required, ...optional].sort();
  if (
    required.some((key) => !Object.hasOwn(root, key)) ||
    keys.some((key) => !allowed.includes(key))
  )
    invalid();
  return root;
}

function record(value: unknown): Record<string, unknown> {
  if (!plain(value)) invalid();
  const descriptors = Object.values(Object.getOwnPropertyDescriptors(value));
  if (descriptors.some((item) => !Object.hasOwn(item, "value") || !item.enumerable)) invalid();
  return value;
}

function plain(value: unknown): value is Record<string, unknown> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.getOwnPropertySymbols(value).length === 0
  );
}

function denseArray(value: unknown): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length > 0
  )
    invalid();
  const names = Object.getOwnPropertyNames(value);
  const indexes = names.filter((name) => name !== "length");
  if (
    names.length !== value.length + 1 ||
    indexes.length !== value.length ||
    indexes.some((key, index) => key !== String(index))
  )
    invalid();
  for (const index of indexes) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) invalid();
  }
  return value;
}

function purpose(value: unknown): asserts value is ModelProfilePurpose {
  if (value !== "policy" && value !== "judge") invalid();
}

function catalogField(value: unknown): ModelCatalogField {
  if (!MODEL_CATALOG_FIELDS.includes(value as ModelCatalogField)) return invalid();
  return value as ModelCatalogField;
}

function hasApprovedGenerativeApiFormat(apiFormats: readonly string[]): boolean {
  return apiFormats.includes("chat_completions") || apiFormats.includes("messages");
}

function identifier(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/u.test(value) ||
    value.includes("..") ||
    value.includes("//")
  )
    invalid();
}

function modelId(value: unknown): asserts value is string {
  identifier(value);
}

function version(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)) invalid();
}

function digest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) invalid();
}

function origin(value: unknown): asserts value is string {
  if (typeof value !== "string") invalid();
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.origin !== value
    )
      invalid();
  } catch {
    invalid();
  }
}

function timestamp(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    new Date(value).toISOString() !== value
  )
    invalid();
}

function date(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value
  )
    invalid();
}

function orderedUnique(values: string[]): void {
  if (values.some((value, index) => index > 0 && value <= values[index - 1]!)) invalid();
}

function compareField(left: { field: string }, right: { field: string }): number {
  return compareText(left.field, right.field);
}

function compareBinding(
  left: ModelCatalogObservationBindingV1,
  right: ModelCatalogObservationBindingV1,
): number {
  return compareText(left.id, right.id);
}

function compareReference(
  left: ModelCatalogFieldReferenceV1,
  right: ModelCatalogFieldReferenceV1,
): number {
  return compareText(
    `${left.observationId}:${left.field}`,
    `${right.observationId}:${right.field}`,
  );
}
