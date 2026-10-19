// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { isExecutableRouteOrigin } from "../config/executable-route-urls.js";

import {
  canonicalizeJsonEvidence,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../json-evidence.js";
import { detectCredentialRuleIdsInValue } from "../security/repository-scanner.js";
import {
  MODEL_CATALOG_FIELDS,
  decodeModelCatalogObservation,
  finalizeModelCatalogObservationSet,
  finalizeModelProfileProposal,
  type ModelCatalogField,
  type ModelCatalogFieldEvidenceV1,
  type ModelCatalogFieldReferenceV1,
  type ModelCatalogFieldValue,
  type ModelCatalogObservationSetV1,
  type ModelCatalogObservationV1,
  type ModelCatalogProposalFieldV1,
  type ModelProfileProposalV1,
  type ModelProfilePurpose,
} from "./catalog-contracts.js";
import {
  decodeModelCatalogObservationProvenance,
  finalizeModelCatalogProposalProvenance,
  MODEL_CATALOG_RECONCILIATION_POLICY,
  MODEL_CATALOG_RECONCILIATION_POLICY_DIRECT_PROVIDER,
  type ModelCatalogObservationProvenanceV1,
  type ModelCatalogProposalProvenanceV1,
  type ModelCatalogReconciliationPolicy,
} from "./catalog-provenance.js";
import {
  ANTHROPIC_API_CATALOG_ADAPTER,
  ANTHROPIC_API_CATALOG_SOURCE_ID,
  ANTHROPIC_API_ORIGIN,
  OPENAI_API_CATALOG_ADAPTER,
  OPENAI_API_CATALOG_SOURCE_ID,
  OPENAI_API_ORIGIN,
} from "./catalog-serving-route.js";

export const MODEL_CATALOG_RECONCILIATION_DECISION_SCHEMA_VERSION = 1 as const;
export const MODEL_CATALOG_RECONCILIATION_REASON_CODES = [
  "combined-context-clamp",
  "complementary-source-selected",
  "conservative-conflict-value",
  "exact-qualified-model-alias",
  "irreconcilable-api-format",
  "irreconcilable-endpoint",
  "irreconcilable-field",
  "irreconcilable-limit-semantics",
  "irreconcilable-model-identity",
  "irreconcilable-price-or-unit",
  "irreconcilable-source-role",
  "model-unsupported-conflict",
  "runtime-boundary-selected",
  "source-observations-retained",
  "unknown-capability-preserved",
  "unknown-pricing-preserved",
] as const;
export type ModelCatalogReconciliationReasonCode =
  (typeof MODEL_CATALOG_RECONCILIATION_REASON_CODES)[number];
export type ModelCatalogReconciliationDisposition = "ready" | "review-required" | "blocked";

export interface ModelCatalogReconciliationReasonV1 {
  code: ModelCatalogReconciliationReasonCode;
  severity: "info" | "review" | "blocking";
  field: ModelCatalogField | null;
  observationIds: string[];
  message: string;
}

interface ReconciliationObservationBindingV1 {
  observationId: string;
  observationSha256: string;
  provenanceSha256: string;
}

export interface ModelCatalogReconciliationDecisionV1 {
  schemaVersion: typeof MODEL_CATALOG_RECONCILIATION_DECISION_SCHEMA_VERSION;
  kind: "docsfab-model-catalog-reconciliation-decision";
  id: string;
  purpose: ModelProfilePurpose;
  createdAt: string;
  observationSet: { id: string; sha256: string };
  reconciliationPolicy: ModelCatalogReconciliationPolicy;
  observations: ReconciliationObservationBindingV1[];
  disposition: ModelCatalogReconciliationDisposition;
  proposal: { id: string; sha256: string } | null;
  proposalProvenanceSha256: string | null;
  reasons: ModelCatalogReconciliationReasonV1[];
  sha256: string;
}

export interface ReconcileModelCatalogInput {
  purpose: ModelProfilePurpose;
  observationSetId: string;
  observationSetCompletedAt: string;
  proposalId: string;
  proposalCreatedAt: string;
  decisionId: string;
  observations: readonly ModelCatalogObservationV1[];
  observationProvenance: readonly ModelCatalogObservationProvenanceV1[];
}

interface ReconciliationBaseResult {
  observations: ModelCatalogObservationV1[];
  observationProvenance: ModelCatalogObservationProvenanceV1[];
  observationSet: ModelCatalogObservationSetV1;
  decision: ModelCatalogReconciliationDecisionV1;
}

export type ModelCatalogReconciliationResult =
  | (ReconciliationBaseResult & {
      status: "proposed";
      proposal: ModelProfileProposalV1;
      proposalProvenance: ModelCatalogProposalProvenanceV1;
    })
  | (ReconciliationBaseResult & {
      status: "blocked";
      proposal?: undefined;
    });

export class ModelCatalogReconciliationError extends Error {
  public readonly code = "invalid-model-catalog-reconciliation" as const;

  public constructor() {
    super("Model catalog reconciliation input or evidence is invalid.");
    this.name = "ModelCatalogReconciliationError";
  }
}

const NVIDIA_INFERENCE_ADAPTER = "adapter:nvidia-inference-api-model-catalog";
const NVIDIA_INFERENCE_SOURCE = "nvidia-inference-api-model-catalog";
const NVIDIA_METADATA_ADAPTERS = new Set(["adapter:nvidia-inference-hub-metadata:authenticated"]);

const REASON_MESSAGES: Record<ModelCatalogReconciliationReasonCode, string> = {
  "combined-context-clamp":
    "Maximum input is bounded by the smallest authentic combined-context limit.",
  "complementary-source-selected":
    "One authoritative observation supplies a value that complementary sources leave unknown.",
  "conservative-conflict-value":
    "The proposal retains a conservative candidate and requires explicit review of differing evidence.",
  "exact-qualified-model-alias":
    "The Metadata label is an exact provider-qualified form of the runtime model identity.",
  "irreconcilable-api-format":
    "Authoritative API-format observations have no safe compatible intersection.",
  "irreconcilable-endpoint":
    "The authenticated runtime observation does not identify the fixed inference endpoint.",
  "irreconcilable-field":
    "The authentic observations do not support a closed deterministic rule for this field.",
  "irreconcilable-limit-semantics": "The observations disagree about token-budget semantics.",
  "irreconcilable-model-identity":
    "The Metadata and runtime identities are not an exact or exact-qualified match.",
  "irreconcilable-price-or-unit":
    "Pricing, currency, billing, or unit evidence cannot be reconciled without invention.",
  "irreconcilable-source-role":
    "Reconciliation requires exactly one qualified authenticated Metadata observation and one qualified inference-catalog observation.",
  "model-unsupported-conflict":
    "An affirmative model-unsupported disposition cannot be overridden by another source.",
  "runtime-boundary-selected":
    "The authenticated inference-catalog observation supplies the effective runtime boundary.",
  "source-observations-retained":
    "Every authentic source observation and provenance leaf is retained in the decision.",
  "unknown-capability-preserved":
    "Missing capability evidence remains unknown and is not converted to false.",
  "unknown-pricing-preserved":
    "Missing authoritative pricing remains unknown and is not converted to zero or free.",
};

/** Pure deterministic reconciliation; it performs no I/O and never mutates runtime configuration. */
export function reconcileModelCatalog(
  input: ReconcileModelCatalogInput,
): ModelCatalogReconciliationResult {
  try {
    const normalized = normalizedInput(input);
    const observationSet = finalizeModelCatalogObservationSet(
      {
        id: normalized.observationSetId,
        purpose: normalized.purpose,
        completedAt: normalized.observationSetCompletedAt,
        observations: normalized.observations.map(binding),
      },
      normalized.observations,
    );
    const reasons: ModelCatalogReconciliationReasonV1[] = [
      reason("source-observations-retained", "info", null, normalized.observations),
    ];
    const roles = sourceRoles(normalized.observations);
    const blocking = preflightSemanticConflicts(normalized.observations, roles, reasons);
    if (blocking) {
      const decision = decisionFor(
        normalized,
        observationSet,
        null,
        null,
        "blocked",
        reasons,
        roles,
      );
      assertCredentialFree([observationSet, decision]);
      return {
        status: "blocked",
        observations: normalized.observations,
        observationProvenance: normalized.provenance,
        observationSet,
        decision,
      };
    }

    const fields: ModelCatalogProposalFieldV1[] = [];
    for (const field of MODEL_CATALOG_FIELDS) {
      const outcome = reconcileField(field, normalized.observations, roles);
      if (outcome.reason) reasons.push(outcome.reason);
      if (!outcome.field) {
        const decision = decisionFor(
          normalized,
          observationSet,
          null,
          null,
          "blocked",
          reasons,
          roles,
        );
        assertCredentialFree([observationSet, decision]);
        return {
          status: "blocked",
          observations: normalized.observations,
          observationProvenance: normalized.provenance,
          observationSet,
          decision,
        };
      }
      fields.push(outcome.field);
    }
    addUnknownReasons(fields, normalized.observations, reasons);
    const proposal = finalizeModelProfileProposal(
      {
        id: normalized.proposalId,
        purpose: normalized.purpose,
        createdAt: normalized.proposalCreatedAt,
        observationSet: { id: observationSet.id, sha256: observationSet.sha256 },
        observations: normalized.observations.map(binding),
        fields,
      },
      observationSet,
      normalized.observations,
    );
    const disposition =
      proposal.fields.some((field) => field.state === "conflicting") ||
      approvalCriticalFieldMissing(proposal.fields)
        ? "review-required"
        : "ready";
    const proposalProvenance = finalizeModelCatalogProposalProvenance({
      proposal,
      observationSet,
      observations: normalized.observations,
      observationProvenance: normalized.provenance,
    });
    const decision = decisionFor(
      normalized,
      observationSet,
      proposal,
      proposalProvenance,
      disposition,
      reasons,
      roles,
    );
    assertCredentialFree([observationSet, proposal, proposalProvenance, decision]);
    return {
      status: "proposed",
      observations: normalized.observations,
      observationProvenance: normalized.provenance,
      observationSet,
      proposal,
      proposalProvenance,
      decision,
    };
  } catch (error) {
    if (error instanceof ModelCatalogReconciliationError) throw error;
    throw new ModelCatalogReconciliationError();
  }
}

export function serializeModelCatalogReconciliationDecision(
  decision: ModelCatalogReconciliationDecisionV1,
  input: ReconcileModelCatalogInput,
): string {
  const expected = reconcileModelCatalog(input).decision;
  if (!equalJson(decision, expected)) throw new ModelCatalogReconciliationError();
  return canonicalizeJsonEvidence(decision as unknown as JsonEvidenceValue);
}

export function decodeModelCatalogReconciliationDecision(
  value: string | Uint8Array | unknown,
  input: ReconcileModelCatalogInput,
): ModelCatalogReconciliationDecisionV1 {
  try {
    const parsed =
      typeof value === "string" || value instanceof Uint8Array ? parseJsonEvidence(value) : value;
    const expected = reconcileModelCatalog(input).decision;
    if (!equalJson(parsed, expected)) throw new ModelCatalogReconciliationError();
    return expected;
  } catch (error) {
    if (error instanceof ModelCatalogReconciliationError) throw error;
    throw new ModelCatalogReconciliationError();
  }
}

interface NormalizedInput {
  purpose: ModelProfilePurpose;
  observationSetId: string;
  observationSetCompletedAt: string;
  proposalId: string;
  proposalCreatedAt: string;
  decisionId: string;
  observations: ModelCatalogObservationV1[];
  provenance: ModelCatalogObservationProvenanceV1[];
}

function normalizedInput(input: ReconcileModelCatalogInput): NormalizedInput {
  const root = closedDataObject(input, [
    "purpose",
    "observationSetId",
    "observationSetCompletedAt",
    "proposalId",
    "proposalCreatedAt",
    "decisionId",
    "observations",
    "observationProvenance",
  ]);
  assertCredentialFree(root);
  if (root.purpose !== "policy" && root.purpose !== "judge") invalid();
  identifier(root.observationSetId);
  identifier(root.proposalId);
  identifier(root.decisionId);
  timestamp(root.observationSetCompletedAt);
  timestamp(root.proposalCreatedAt);
  if (root.proposalCreatedAt < root.observationSetCompletedAt) invalid();
  const observationValues = denseDataArray(
    root.observations as readonly ModelCatalogObservationV1[],
    64,
  );
  const provenanceValues = denseDataArray(
    root.observationProvenance as readonly ModelCatalogObservationProvenanceV1[],
    64,
  );
  if (observationValues.length === 0 || observationValues.length !== provenanceValues.length) {
    invalid();
  }
  const observations = observationValues.map((value) => decodeModelCatalogObservation(value));
  if (observations.some((observation) => observation.purpose !== root.purpose)) invalid();
  observations.sort((left, right) => compareText(left.id, right.id));
  orderedUnique(observations.map((observation) => observation.id));
  const byObservation = new Map<string, ModelCatalogObservationProvenanceV1>();
  for (const candidate of provenanceValues) {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, "observation");
    if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid();
    const bindingValue = descriptor.value;
    if (!bindingValue || typeof bindingValue !== "object") invalid();
    const idDescriptor = Object.getOwnPropertyDescriptor(bindingValue, "id");
    if (
      !idDescriptor ||
      !Object.hasOwn(idDescriptor, "value") ||
      typeof idDescriptor.value !== "string"
    )
      invalid();
    const observation = observations.find((item) => item.id === idDescriptor.value);
    if (!observation || byObservation.has(observation.id)) invalid();
    byObservation.set(
      observation.id,
      decodeModelCatalogObservationProvenance(candidate, observation),
    );
  }
  const provenance = observations.map((observation) => {
    const leaf = byObservation.get(observation.id);
    return leaf ?? invalid();
  });
  return {
    purpose: root.purpose,
    observationSetId: root.observationSetId,
    observationSetCompletedAt: root.observationSetCompletedAt,
    proposalId: root.proposalId,
    proposalCreatedAt: root.proposalCreatedAt,
    decisionId: root.decisionId,
    observations,
    provenance,
  };
}

function closedDataObject(value: unknown, required: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length > 0
  )
    invalid();
  const names = Object.getOwnPropertyNames(value).sort(compareText);
  const expected = [...required].sort(compareText);
  if (!equalJson(names, expected)) invalid();
  const output: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) invalid();
    output[name] = descriptor.value;
  }
  return output;
}

interface SourceRoles {
  inference?: ModelCatalogObservationV1;
  metadata?: ModelCatalogObservationV1;
  directProvider?: ModelCatalogObservationV1;
  recognizedPair: boolean;
  recognizedDirectProvider: boolean;
  duplicateRole: boolean;
}

function sourceRoles(observations: readonly ModelCatalogObservationV1[]): SourceRoles {
  const inference = observations.filter(
    (observation) =>
      observation.source.id === NVIDIA_INFERENCE_SOURCE &&
      observation.source.adapter.id === NVIDIA_INFERENCE_ADAPTER &&
      observation.source.adapter.version === "1.0.0",
  );
  const metadata = observations.filter(
    (observation) =>
      NVIDIA_METADATA_ADAPTERS.has(observation.source.adapter.id) &&
      observation.source.adapter.version === "1.0.0" &&
      observation.source.id === "source:ihub-metadata:authenticated",
  );
  const directProvider = observations.filter(
    (observation) =>
      observation.source.adapter.version === "1.0.0" &&
      ((observation.source.adapter.id === OPENAI_API_CATALOG_ADAPTER.id &&
        observation.source.id === OPENAI_API_CATALOG_SOURCE_ID) ||
        (observation.source.adapter.id === ANTHROPIC_API_CATALOG_ADAPTER.id &&
          observation.source.id === ANTHROPIC_API_CATALOG_SOURCE_ID)),
  );
  return {
    inference: inference.length === 1 ? inference[0] : undefined,
    metadata: metadata.length === 1 ? metadata[0] : undefined,
    directProvider: directProvider.length === 1 ? directProvider[0] : undefined,
    recognizedPair: observations.length === 2 && inference.length === 1 && metadata.length === 1,
    recognizedDirectProvider:
      observations.length === 1 &&
      directProvider.length === 1 &&
      inference.length === 0 &&
      metadata.length === 0,
    duplicateRole: inference.length > 1 || metadata.length > 1 || directProvider.length > 1,
  };
}

function preflightSemanticConflicts(
  observations: readonly ModelCatalogObservationV1[],
  roles: SourceRoles,
  reasons: ModelCatalogReconciliationReasonV1[],
): boolean {
  if (roles.duplicateRole) {
    reasons.push(reason("irreconcilable-source-role", "blocking", null, observations));
    return true;
  }
  if (roles.recognizedDirectProvider) {
    return preflightDirectProvider(roles.directProvider!, observations, reasons);
  }
  if (!roles.recognizedPair) {
    reasons.push(reason("irreconcilable-source-role", "blocking", null, observations));
    return true;
  }
  if (roles.recognizedPair) {
    observedString(roles.inference!, "providerId");
    const runtimeModel = observedString(roles.inference!, "modelId");
    const runtimeOrigin = observedString(roles.inference!, "origin");
    const metadataProvider = observedString(roles.metadata!, "providerId");
    const metadataModel = observedString(roles.metadata!, "modelId");
    observedString(roles.metadata!, "origin");
    const exact = runtimeModel === metadataModel;
    const qualified =
      /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/u.test(metadataProvider) &&
      metadataModel === `${metadataProvider}/${runtimeModel}`;
    if (!isExecutableRouteOrigin("nvidia-inference-api", runtimeOrigin)) {
      reasons.push(reason("irreconcilable-endpoint", "blocking", "origin", observations));
      return true;
    }
    if (!exact && !qualified) {
      reasons.push(reason("irreconcilable-model-identity", "blocking", "modelId", observations));
      return true;
    }
    if (qualified && !exact) {
      reasons.push(reason("exact-qualified-model-alias", "info", "modelId", observations));
    }
    reasons.push(reason("runtime-boundary-selected", "info", "origin", observations));
  }
  const semanticsEvidence = observations.map((observation) =>
    observedField(observation, "limitSemantics"),
  );
  const semantics = observedValues(observations, "limitSemantics");
  if (
    distinctValues(semantics).length > 1 ||
    semanticsEvidence.some(
      (evidence) =>
        evidence.state === "conflicting" ||
        (evidence.state === "unsupported" && evidence.reason === "model-unsupported"),
    )
  ) {
    reasons.push(
      reason("irreconcilable-limit-semantics", "blocking", "limitSemantics", observations),
    );
    return true;
  }
  return false;
}

function preflightDirectProvider(
  observation: ModelCatalogObservationV1,
  observations: readonly ModelCatalogObservationV1[],
  reasons: ModelCatalogReconciliationReasonV1[],
): boolean {
  observedString(observation, "providerId");
  observedString(observation, "modelId");
  const origin = observedString(observation, "origin");
  const expectedOrigin =
    observation.source.adapter.id === OPENAI_API_CATALOG_ADAPTER.id
      ? OPENAI_API_ORIGIN
      : ANTHROPIC_API_ORIGIN;
  if (origin !== expectedOrigin) {
    reasons.push(reason("irreconcilable-endpoint", "blocking", "origin", observations));
    return true;
  }
  reasons.push(reason("runtime-boundary-selected", "info", "origin", observations));
  return false;
}

interface FieldOutcome {
  field?: ModelCatalogProposalFieldV1;
  reason?: ModelCatalogReconciliationReasonV1;
}

function reconcileField(
  field: ModelCatalogField,
  observations: readonly ModelCatalogObservationV1[],
  roles: SourceRoles,
): FieldOutcome {
  if (roles.recognizedPair && ["providerId", "origin"].includes(field)) {
    const value = observedString(roles.inference!, field);
    return {
      field: {
        field,
        state: "observed",
        value,
        derivation: {
          kind: "rule",
          rule: "select-runtime-source@1",
          inputs: references(observations, field),
        },
      },
    };
  }
  if (roles.recognizedPair && field === "modelId") {
    const value = observedString(roles.inference!, field);
    return {
      field: {
        field,
        state: "observed",
        value,
        derivation: {
          kind: "rule",
          rule: "qualified-model-label@1",
          inputs: [
            ...references(observations, "modelId"),
            ...references(observations, "providerId"),
          ].sort(compareReference),
        },
      },
    };
  }
  if (
    roles.recognizedPair &&
    field === "maxInputTokens" &&
    hasCombinedContextEvidence(observations)
  ) {
    const contexts = numericEvidence(observations, "contextWindow");
    const maximumInputs = numericEvidence(observations, "maxInputTokens");
    const maximumOutputs = numericEvidence(observations, "maxOutputTokens");
    const context = Math.min(...contexts);
    const output = Math.min(...maximumOutputs);
    const remaining = context - output;
    if (!Number.isSafeInteger(remaining) || remaining <= 0) {
      return { reason: reason("irreconcilable-limit-semantics", "blocking", field, observations) };
    }
    const rawInput = maximumInputs.length > 0 ? Math.min(...maximumInputs) : remaining;
    const selected = Math.min(rawInput, remaining);
    const state =
      maximumInputs.length === 0 ||
      selected !== rawInput ||
      new Set(contexts).size > 1 ||
      new Set(maximumInputs).size > 1 ||
      new Set(maximumOutputs).size > 1
        ? "conflicting"
        : "observed";
    return {
      field: {
        field,
        state,
        value: selected,
        derivation: {
          kind: "rule",
          rule: "combined-context-input-clamp@1",
          inputs: [
            ...references(observations, "contextWindow"),
            ...references(observations, "limitSemantics"),
            ...references(observations, "maxInputTokens"),
            ...references(observations, "maxOutputTokens"),
          ].sort(compareReference),
        },
      },
      reason:
        state === "conflicting"
          ? reason("combined-context-clamp", "review", field, observations)
          : undefined,
    };
  }
  const entries = observations.map((observation) => observedField(observation, field));
  if (observations.length === 1 && entries[0]?.state !== "conflicting") {
    const entry = entries[0]!;
    return {
      field: {
        field,
        state: entry.state,
        ...(entry.state === "observed" ? { value: entry.value } : {}),
        derivation: { kind: "observation", input: reference(observations[0]!, field) },
      },
    };
  }
  if (entries.every((entry) => entry.state === "unknown")) {
    return { field: ruleField(field, "unknown", undefined, "propagate-unknown@1", observations) };
  }
  if (
    entries.some((entry) => entry.state === "unknown") &&
    entries.some(
      (entry) => entry.state === "unsupported" && entry.reason === "source-unsupported",
    ) &&
    entries.every(
      (entry) =>
        entry.state === "unknown" ||
        (entry.state === "unsupported" && entry.reason === "source-unsupported"),
    )
  ) {
    return {
      field: ruleField(
        field,
        "unknown",
        undefined,
        "propagate-no-authoritative-value@1",
        observations,
      ),
    };
  }
  if (entries.every((entry) => entry.state === "unsupported")) {
    return {
      field: ruleField(field, "unsupported", undefined, "propagate-unsupported@1", observations),
    };
  }
  if (
    entries.some((entry) => entry.state === "unsupported" && entry.reason === "model-unsupported")
  ) {
    return { reason: reason("model-unsupported-conflict", "blocking", field, observations) };
  }
  const values = valueBearing(entries);
  const distinct = distinctValues(values);
  const complementary =
    distinct.length === 1 &&
    entries.some(
      (entry) =>
        entry.state === "unknown" ||
        (entry.state === "unsupported" && entry.reason === "source-unsupported"),
    );
  if (complementary) {
    return {
      field: ruleField(field, "observed", distinct[0], "prefer-observed@1", observations),
      reason: reason("complementary-source-selected", "info", field, observations),
    };
  }
  const allValueBearing = entries.every(
    (entry) => entry.state === "observed" || entry.state === "conflicting",
  );
  if (allValueBearing && distinct.length === 1) {
    return { field: ruleField(field, "observed", distinct[0], "exact-consensus@1", observations) };
  }
  if (!allValueBearing || distinct.length === 0) {
    return { reason: reason("irreconcilable-field", "blocking", field, observations) };
  }
  if (distinct.every((value) => typeof value === "number")) {
    const selected = Math.min(...(distinct as number[]));
    return {
      field: ruleField(field, "conflicting", selected, "minimum-number@1", observations),
      reason: reason("conservative-conflict-value", "review", field, observations),
    };
  }
  if (distinct.every((value) => typeof value === "boolean")) {
    const selected = (distinct as boolean[]).every(Boolean);
    return {
      field: ruleField(field, "conflicting", selected, "boolean-conjunction@1", observations),
      reason: reason("conservative-conflict-value", "review", field, observations),
    };
  }
  if (distinct.every(Array.isArray)) {
    const arrays = distinct as string[][];
    const selected = [...new Set(arrays[0])]
      .filter((item) => arrays.every((array) => array.includes(item)))
      .sort();
    if (selected.length === 0) {
      const code = field === "apiFormats" ? "irreconcilable-api-format" : "irreconcilable-field";
      return { reason: reason(code, "blocking", field, observations) };
    }
    return {
      field: ruleField(field, "conflicting", selected, "array-intersection@1", observations),
      reason: reason("conservative-conflict-value", "review", field, observations),
    };
  }
  const code = [
    "billingInterpretation",
    "cacheReadPrice",
    "cacheWritePrice",
    "inputPrice",
    "outputPrice",
  ].includes(field)
    ? "irreconcilable-price-or-unit"
    : "irreconcilable-field";
  return { reason: reason(code, "blocking", field, observations) };
}

function ruleField(
  field: ModelCatalogField,
  state: "observed" | "unknown" | "unsupported" | "conflicting",
  value: ModelCatalogFieldValue | undefined,
  rule:
    | "array-intersection@1"
    | "boolean-conjunction@1"
    | "exact-consensus@1"
    | "minimum-number@1"
    | "prefer-observed@1"
    | "propagate-unknown@1"
    | "propagate-no-authoritative-value@1"
    | "propagate-unsupported@1",
  observations: readonly ModelCatalogObservationV1[],
): ModelCatalogProposalFieldV1 {
  return {
    field,
    state,
    ...(value === undefined ? {} : { value }),
    derivation: { kind: "rule", rule, inputs: references(observations, field) },
  };
}

function hasCombinedContextEvidence(observations: readonly ModelCatalogObservationV1[]): boolean {
  const semantics = observedValues(observations, "limitSemantics");
  return (
    semantics.includes("combined-context") &&
    !semantics.includes("independent-input-output") &&
    numericEvidence(observations, "contextWindow").length > 0 &&
    numericEvidence(observations, "maxOutputTokens").length > 0
  );
}

function numericEvidence(
  observations: readonly ModelCatalogObservationV1[],
  field: "contextWindow" | "maxInputTokens" | "maxOutputTokens",
): number[] {
  const output: number[] = [];
  for (const observation of observations) {
    const entry = observedField(observation, field);
    if (entry.state === "observed" && typeof entry.value === "number") output.push(entry.value);
    else if (entry.state === "conflicting") {
      output.push(
        ...entry.candidates.filter((value): value is number => typeof value === "number"),
      );
    }
  }
  return output;
}

function addUnknownReasons(
  fields: readonly ModelCatalogProposalFieldV1[],
  observations: readonly ModelCatalogObservationV1[],
  reasons: ModelCatalogReconciliationReasonV1[],
): void {
  const capabilities: ModelCatalogField[] = [
    "reasoning",
    "supportsDeveloperRole",
    "supportsReasoningEffort",
    "supportsSystemRole",
    "toolUse",
  ];
  if (
    capabilities.some((name) => fields.find((field) => field.field === name)?.state === "unknown")
  ) {
    reasons.push(reason("unknown-capability-preserved", "info", null, observations));
  }
  const prices: ModelCatalogField[] = [
    "billingInterpretation",
    "cacheReadPrice",
    "cacheWritePrice",
    "inputPrice",
    "outputPrice",
  ];
  if (prices.every((name) => fields.find((field) => field.field === name)?.state === "unknown")) {
    reasons.push(reason("unknown-pricing-preserved", "info", null, observations));
  }
}

function approvalCriticalFieldMissing(fields: readonly ModelCatalogProposalFieldV1[]): boolean {
  const required: ModelCatalogField[] = [
    "activity",
    "apiFormats",
    "contextWindow",
    "inputModalities",
    "limitSemantics",
    "maxInputTokens",
    "maxOutputTokens",
    "modelId",
    "origin",
    "providerId",
  ];
  return required.some(
    (name) => fields.find((field) => field.field === name)?.state !== "observed",
  );
}

function decisionFor(
  input: NormalizedInput,
  observationSet: ModelCatalogObservationSetV1,
  proposal: ModelProfileProposalV1 | null,
  proposalProvenance: ModelCatalogProposalProvenanceV1 | null,
  disposition: ModelCatalogReconciliationDisposition,
  reasons: readonly ModelCatalogReconciliationReasonV1[],
  roles: SourceRoles,
): ModelCatalogReconciliationDecisionV1 {
  const artifact: ModelCatalogReconciliationDecisionV1 = {
    schemaVersion: MODEL_CATALOG_RECONCILIATION_DECISION_SCHEMA_VERSION,
    kind: "docsfab-model-catalog-reconciliation-decision",
    id: input.decisionId,
    purpose: input.purpose,
    createdAt: input.proposalCreatedAt,
    observationSet: { id: observationSet.id, sha256: observationSet.sha256 },
    reconciliationPolicy: {
      ...(roles.recognizedDirectProvider
        ? MODEL_CATALOG_RECONCILIATION_POLICY_DIRECT_PROVIDER
        : MODEL_CATALOG_RECONCILIATION_POLICY),
    },
    observations: input.observations.map((observation, index) => ({
      observationId: observation.id,
      observationSha256: observation.sha256,
      provenanceSha256: input.provenance[index]!.sha256,
    })),
    disposition,
    proposal: proposal ? { id: proposal.id, sha256: proposal.sha256 } : null,
    proposalProvenanceSha256: proposalProvenance?.sha256 ?? null,
    reasons: normalizedReasons(reasons),
    sha256: "",
  };
  artifact.sha256 = digestArtifact(artifact);
  return artifact;
}

function reason(
  code: ModelCatalogReconciliationReasonCode,
  severity: ModelCatalogReconciliationReasonV1["severity"],
  field: ModelCatalogField | null,
  observations: readonly ModelCatalogObservationV1[],
): ModelCatalogReconciliationReasonV1 {
  return {
    code,
    severity,
    field,
    observationIds: observations.map((observation) => observation.id).sort(compareText),
    message: REASON_MESSAGES[code],
  };
}

function normalizedReasons(
  values: readonly ModelCatalogReconciliationReasonV1[],
): ModelCatalogReconciliationReasonV1[] {
  const output = values.map((value) => ({
    ...value,
    observationIds: [...value.observationIds].sort(compareText),
  }));
  output.sort((left, right) =>
    compareText(
      `${left.severity}:${left.field ?? ""}:${left.code}:${left.observationIds.join(":")}`,
      `${right.severity}:${right.field ?? ""}:${right.code}:${right.observationIds.join(":")}`,
    ),
  );
  const keys = output.map(
    (value) =>
      `${value.severity}:${value.field ?? ""}:${value.code}:${value.observationIds.join(":")}`,
  );
  orderedUnique(keys);
  return output;
}

function observedField(
  observation: ModelCatalogObservationV1,
  field: ModelCatalogField,
): ModelCatalogFieldEvidenceV1 {
  return observation.fields.find((entry) => entry.field === field) ?? invalid();
}

function observedString(observation: ModelCatalogObservationV1, field: ModelCatalogField): string {
  const evidence = observedField(observation, field);
  if (evidence.state !== "observed" || typeof evidence.value !== "string") return invalid();
  return evidence.value;
}

function observedValues(
  observations: readonly ModelCatalogObservationV1[],
  field: ModelCatalogField,
): ModelCatalogFieldValue[] {
  return observations.flatMap((observation) => {
    const evidence = observedField(observation, field);
    return evidence.state === "observed" ? [evidence.value] : [];
  });
}

function valueBearing(entries: readonly ModelCatalogFieldEvidenceV1[]): ModelCatalogFieldValue[] {
  return entries.flatMap((entry) =>
    entry.state === "observed"
      ? [entry.value]
      : entry.state === "conflicting"
        ? entry.candidates
        : [],
  );
}

function distinctValues(values: readonly ModelCatalogFieldValue[]): ModelCatalogFieldValue[] {
  const byKey = new Map<string, ModelCatalogFieldValue>();
  for (const value of values) byKey.set(valueKey(value), value);
  return [...byKey].sort(([left], [right]) => compareText(left, right)).map(([, value]) => value);
}

function references(
  observations: readonly ModelCatalogObservationV1[],
  field: ModelCatalogField,
): ModelCatalogFieldReferenceV1[] {
  return observations.map((observation) => reference(observation, field)).sort(compareReference);
}

function reference(
  observation: ModelCatalogObservationV1,
  field: ModelCatalogField,
): ModelCatalogFieldReferenceV1 {
  return { observationId: observation.id, observationSha256: observation.sha256, field };
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

function binding(observation: ModelCatalogObservationV1) {
  return { id: observation.id, sha256: observation.sha256 };
}

function denseDataArray<T>(value: readonly T[], maximum: number): T[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Object.getOwnPropertySymbols(value).length > 0
  )
    invalid();
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== value.length + 1) invalid();
  const output: T[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) invalid();
    output.push(descriptor.value as T);
  }
  return output;
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

function timestamp(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    new Date(value).toISOString() !== value
  )
    invalid();
}

function orderedUnique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) invalid();
}

function valueKey(value: ModelCatalogFieldValue): string {
  return canonicalizeJsonEvidence(value as JsonEvidenceValue).trimEnd();
}

function digestArtifact(value: ModelCatalogReconciliationDecisionV1): string {
  const { sha256: _sha256, ...body } = value;
  return createHash("sha256")
    .update(canonicalizeJsonEvidence(body as unknown as JsonEvidenceValue))
    .digest("hex");
}

function equalJson(left: unknown, right: unknown): boolean {
  try {
    return (
      canonicalizeJsonEvidence(left as JsonEvidenceValue) ===
      canonicalizeJsonEvidence(right as JsonEvidenceValue)
    );
  } catch {
    return false;
  }
}

function assertCredentialFree(value: unknown): void {
  if (detectCredentialRuleIdsInValue(value).length > 0) invalid();
}

function compareText(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function invalid(): never {
  throw new ModelCatalogReconciliationError();
}
