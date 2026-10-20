// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isExecutableRouteOrigin } from "../../config/executable-route-urls.js";
import { equalJson, invalid, valueKey } from "./canonical-values.js";
import type {
  ModelCatalogField,
  ModelCatalogFieldEvidenceV1,
  ModelCatalogFieldReferenceV1,
  ModelCatalogFieldState,
  ModelCatalogFieldValue,
  ModelCatalogObservationV1,
  ModelCatalogProposalFieldV1,
} from "../catalog-contracts.js";

export function validateDerivation(
  proposed: ModelCatalogProposalFieldV1,
  observations: Map<string, ModelCatalogObservationV1>,
): void {
  const derivation = proposed.derivation;
  if (derivation.kind === "observation") {
    if (observations.size !== 1) invalid();
    const evidence = referencedField(derivation.input, observations);
    if (evidence.state !== proposed.state || evidence.state === "conflicting") invalid();
    if (evidence.state === "observed") {
      if (!equalJson(evidence.value, proposed.value)) invalid();
    } else if (proposed.value !== undefined) invalid();
    return;
  }
  if (derivation.rule === "select-runtime-source@1") {
    validateRuntimeSourceDerivation(proposed, derivation.inputs, observations);
    return;
  }
  if (derivation.rule === "qualified-model-label@1") {
    validateQualifiedModelLabelDerivation(proposed, derivation.inputs, observations);
    return;
  }
  if (derivation.rule === "combined-context-input-clamp@1") {
    validateCombinedContextInputClampDerivation(proposed, derivation.inputs, observations);
    return;
  }
  const expectedIds = [...observations.keys()].sort();
  const actualIds = derivation.inputs.map((input) => input.observationId).sort();
  if (!equalJson(actualIds, expectedIds)) invalid();
  const evidence = derivation.inputs.map((input) => referencedField(input, observations));
  const values = evidence.flatMap((item) =>
    item.state === "observed" ? [item.value] : item.state === "conflicting" ? item.candidates : [],
  );
  const allValueBearing = evidence.every(
    (item) => item.state === "observed" || item.state === "conflicting",
  );
  let derived: ModelCatalogFieldValue | undefined;
  let state: ModelCatalogFieldState;
  switch (derivation.rule) {
    case "select-observation@1":
      if (evidence.length !== 1 || evidence[0]?.state !== "observed") invalid();
      derived = evidence[0].value;
      state = "observed";
      break;
    case "exact-consensus@1":
      if (!allValueBearing || values.length === 0 || new Set(values.map(valueKey)).size !== 1)
        invalid();
      derived = values[0];
      state = "observed";
      break;
    case "minimum-number@1":
      if (
        !allValueBearing ||
        values.length === 0 ||
        values.some((item) => typeof item !== "number")
      )
        invalid();
      derived = Math.min(...(values as number[]));
      state = new Set(values.map(valueKey)).size > 1 ? "conflicting" : "observed";
      break;
    case "prefer-observed@1":
      if (
        values.length === 0 ||
        new Set(values.map(valueKey)).size !== 1 ||
        evidence.some((item) => item.state === "unsupported" && item.reason === "model-unsupported")
      )
        invalid();
      derived = values[0];
      state = "observed";
      break;
    case "boolean-conjunction@1":
      if (
        !allValueBearing ||
        values.length === 0 ||
        values.some((item) => typeof item !== "boolean")
      )
        invalid();
      derived = (values as boolean[]).every(Boolean);
      state = new Set(values.map(valueKey)).size > 1 ? "conflicting" : "observed";
      break;
    case "array-intersection@1": {
      if (!allValueBearing || values.length === 0 || values.some((item) => !Array.isArray(item)))
        invalid();
      const arrays = values as string[][];
      derived = [...new Set(arrays[0])]
        .filter((item) => arrays.every((array) => array.includes(item)))
        .sort();
      state = new Set(values.map(valueKey)).size > 1 ? "conflicting" : "observed";
      break;
    }
    case "propagate-unknown@1":
      if (evidence.some((item) => item.state !== "unknown")) invalid();
      state = "unknown";
      break;
    case "propagate-no-authoritative-value@1":
      if (
        !evidence.some((item) => item.state === "unknown") ||
        !evidence.some(
          (item) => item.state === "unsupported" && item.reason === "source-unsupported",
        ) ||
        evidence.some(
          (item) =>
            item.state !== "unknown" &&
            !(item.state === "unsupported" && item.reason === "source-unsupported"),
        )
      )
        invalid();
      state = "unknown";
      break;
    case "propagate-unsupported@1":
      if (evidence.some((item) => item.state !== "unsupported")) invalid();
      state = "unsupported";
      break;
    case "unresolved-conflict@1":
      if (!allValueBearing || values.length < 2 || new Set(values.map(valueKey)).size < 2)
        invalid();
      state = "conflicting";
      break;
    default:
      return invalid();
  }
  if (proposed.state !== state || !equalJson(proposed.value, derived)) invalid();
}

const NVIDIA_INFERENCE_ADAPTER = "adapter:nvidia-inference-api-model-catalog";
const NVIDIA_INFERENCE_SOURCE = "nvidia-inference-api-model-catalog";
const NVIDIA_METADATA_ADAPTERS = new Set(["adapter:nvidia-inference-hub-metadata:authenticated"]);

function validateRuntimeSourceDerivation(
  proposed: ModelCatalogProposalFieldV1,
  inputs: ModelCatalogFieldReferenceV1[],
  observations: Map<string, ModelCatalogObservationV1>,
): void {
  if (!["providerId", "origin"].includes(proposed.field) || inputs.length !== observations.size)
    invalid();
  const expected = [...observations.values()]
    .map((observation) => `${observation.id}:${proposed.field}`)
    .sort();
  if (!equalJson(inputs.map((input) => `${input.observationId}:${input.field}`).sort(), expected)) {
    invalid();
  }
  const { runtime } = nvidiaSourcePair(observations);
  const runtimeProvider = observedString(runtime, "providerId");
  const runtimeOrigin = observedString(runtime, "origin");
  if (!isExecutableRouteOrigin("nvidia-inference-api", runtimeOrigin)) invalid();
  const selected = proposed.field === "providerId" ? runtimeProvider : runtimeOrigin;
  if (proposed.state !== "observed" || !equalJson(proposed.value, selected)) invalid();
  for (const input of inputs) referencedField(input, observations);
}

function validateQualifiedModelLabelDerivation(
  proposed: ModelCatalogProposalFieldV1,
  inputs: ModelCatalogFieldReferenceV1[],
  observations: Map<string, ModelCatalogObservationV1>,
): void {
  if (proposed.field !== "modelId" || inputs.length !== observations.size * 2) invalid();
  const expected = [...observations.values()]
    .flatMap((observation) => [`${observation.id}:modelId`, `${observation.id}:providerId`])
    .sort();
  if (!equalJson(inputs.map((input) => `${input.observationId}:${input.field}`).sort(), expected)) {
    invalid();
  }
  const { runtime, metadata } = nvidiaSourcePair(observations);
  const runtimeModel = observedString(runtime, "modelId");
  const metadataModel = observedString(metadata, "modelId");
  const metadataProvider = observedString(metadata, "providerId");
  const exact = metadataModel === runtimeModel;
  const qualified =
    /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/u.test(metadataProvider) &&
    metadataModel === `${metadataProvider}/${runtimeModel}`;
  if ((!exact && !qualified) || proposed.state !== "observed" || proposed.value !== runtimeModel)
    invalid();
  for (const input of inputs) referencedField(input, observations);
}

function validateCombinedContextInputClampDerivation(
  proposed: ModelCatalogProposalFieldV1,
  inputs: ModelCatalogFieldReferenceV1[],
  observations: Map<string, ModelCatalogObservationV1>,
): void {
  if (proposed.field !== "maxInputTokens" || inputs.length !== observations.size * 4) invalid();
  const expected = [...observations.values()]
    .flatMap((observation) => [
      `${observation.id}:contextWindow`,
      `${observation.id}:limitSemantics`,
      `${observation.id}:maxInputTokens`,
      `${observation.id}:maxOutputTokens`,
    ])
    .sort();
  if (!equalJson(inputs.map((input) => `${input.observationId}:${input.field}`).sort(), expected)) {
    invalid();
  }
  const contexts: number[] = [];
  const maximumInputs: number[] = [];
  const maximumOutputs: number[] = [];
  let hasCombinedSemantics = false;
  for (const observation of observations.values()) {
    const semantics = observation.fields.find((item) => item.field === "limitSemantics");
    if (semantics?.state === "observed") {
      if (semantics.value !== "combined-context") invalid();
      hasCombinedSemantics = true;
    } else if (semantics?.state === "unsupported" && semantics.reason === "model-unsupported")
      invalid();
  }
  for (const input of inputs) {
    const evidence = referencedField(input, observations);
    if (evidence.state === "observed") {
      if (input.field === "limitSemantics") {
        if (evidence.value !== "combined-context") invalid();
        continue;
      }
      if (typeof evidence.value !== "number") invalid();
      if (input.field === "contextWindow") contexts.push(evidence.value);
      else if (input.field === "maxInputTokens") maximumInputs.push(evidence.value);
      else maximumOutputs.push(evidence.value);
    } else if (evidence.state === "conflicting") {
      if (input.field === "limitSemantics") invalid();
      if (evidence.candidates.some((value) => typeof value !== "number")) invalid();
      if (input.field === "contextWindow") contexts.push(...(evidence.candidates as number[]));
      else if (input.field === "maxInputTokens")
        maximumInputs.push(...(evidence.candidates as number[]));
      else maximumOutputs.push(...(evidence.candidates as number[]));
    } else if (evidence.state === "unsupported" && evidence.reason === "model-unsupported")
      invalid();
  }
  if (!hasCombinedSemantics || contexts.length === 0 || maximumOutputs.length === 0) invalid();
  const context = Math.min(...contexts);
  const output = Math.min(...maximumOutputs);
  const remaining = context - output;
  if (!Number.isSafeInteger(remaining) || remaining <= 0) invalid();
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
  if (proposed.state !== state || proposed.value !== selected) invalid();
}

function nvidiaSourcePair(observations: Map<string, ModelCatalogObservationV1>): {
  runtime: ModelCatalogObservationV1;
  metadata: ModelCatalogObservationV1;
} {
  const inference = [...observations.values()].filter(
    (observation) =>
      observation.source.id === NVIDIA_INFERENCE_SOURCE &&
      observation.source.adapter.id === NVIDIA_INFERENCE_ADAPTER &&
      observation.source.adapter.version === "1.0.0",
  );
  const metadata = [...observations.values()].filter(
    (observation) =>
      NVIDIA_METADATA_ADAPTERS.has(observation.source.adapter.id) &&
      observation.source.adapter.version === "1.0.0" &&
      observation.source.id === "source:ihub-metadata:authenticated",
  );
  if (inference.length !== 1 || metadata.length !== 1 || observations.size !== 2) invalid();
  return { runtime: inference[0]!, metadata: metadata[0]! };
}

function observedString(observation: ModelCatalogObservationV1, field: ModelCatalogField): string {
  const evidence = observation.fields.find((item) => item.field === field);
  if (evidence?.state !== "observed" || typeof evidence.value !== "string") return invalid();
  return evidence.value;
}

function referencedField(
  reference: ModelCatalogFieldReferenceV1,
  observations: Map<string, ModelCatalogObservationV1>,
): ModelCatalogFieldEvidenceV1 {
  const observation = observations.get(reference.observationId);
  if (!observation || observation.sha256 !== reference.observationSha256) invalid();
  const field = observation.fields.find((item) => item.field === reference.field);
  if (!field) invalid();
  return field;
}
