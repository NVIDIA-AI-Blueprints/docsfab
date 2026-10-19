// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type { ModelEndpointConfig, ModelProfileApiFormat } from "./configuration.js";
import type { JsonEvidenceValue } from "../json-evidence.js";
import {
  containsInferenceCredential,
  containsMetadataCredential,
} from "../security/credential-material.js";
import { detectCredentialRuleIds } from "../security/repository-scanner.js";
import {
  credentialForRequest,
  releaseModelCredential,
} from "../security/model-credential-release.js";
import {
  MODEL_CATALOG_FIELDS,
  finalizeModelCatalogObservation,
  type ModelCatalogField,
  type ModelCatalogFieldEvidenceV1,
  type ModelCatalogObservationV1,
  type ModelProfilePurpose,
} from "./catalog-contracts.js";
import {
  catalogFail,
  optionalPositiveInteger,
  optionalTimestamp,
  retrieveDirectProviderCatalogJson,
  safeCatalogIdentifier,
  type DirectProviderCatalogFailureCode,
} from "./catalog-discovery-http.js";
import {
  finalizeModelCatalogObservationProvenance,
  type ModelCatalogObservationProvenanceV1,
} from "./catalog-provenance.js";
import {
  ANTHROPIC_API_CATALOG_ADAPTER,
  ANTHROPIC_API_CATALOG_SOURCE_ID,
  ANTHROPIC_API_ORIGIN,
} from "./catalog-serving-route.js";

export const ANTHROPIC_API_CATALOG_SOURCE_PATH_PREFIX = "/v1/models/" as const;
export const ANTHROPIC_API_VERSION = "2023-06-01" as const;
const ANTHROPIC_KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]{20,}$/u;

export class AnthropicApiCatalogDiscoveryError extends Error {
  public readonly retryable = false as const;

  public constructor(public readonly code: DirectProviderCatalogFailureCode) {
    super(`Anthropic API model catalog discovery failed: ${code}.`);
    this.name = "AnthropicApiCatalogDiscoveryError";
  }
}

export interface AnthropicApiCatalogDiscoveryResult {
  observation: ModelCatalogObservationV1;
  provenance: ModelCatalogObservationProvenanceV1;
}

export interface AnthropicApiCatalogDiscoveryInput {
  config: ModelEndpointConfig;
  purpose: ModelProfilePurpose;
  fetch?: typeof globalThis.fetch;
  clock?: () => Date;
}

const fail = catalogFail(AnthropicApiCatalogDiscoveryError);

/**
 * Perform one explicit read-only Anthropic Models retrieve. This adapter is not
 * called by ordinary workflow execution and never reads Inference Hub Metadata.
 */
export async function discoverAnthropicApiModelCatalog(
  input: AnthropicApiCatalogDiscoveryInput,
): Promise<AnthropicApiCatalogDiscoveryResult> {
  const boundary = snapshotDiscoveryBoundary(input);
  const url = `${ANTHROPIC_API_ORIGIN}${ANTHROPIC_API_CATALOG_SOURCE_PATH_PREFIX}${boundary.config.modelId}`;
  // Released for the configured endpoint, which shares the catalog's origin.
  const credential = releaseModelCredential(
    {
      endpoint: boundary.config.baseUrl,
      endpointSource: input.config.endpointSource,
      apiKey: boundary.config.apiKey,
    },
    "catalog-lookup",
  );
  const result = await retrieveDirectProviderCatalogJson({
    url,
    headers: {
      accept: "application/json",
      "anthropic-version": ANTHROPIC_API_VERSION,
      "x-api-key": credentialForRequest(credential, url),
    },
    fetch: input.fetch,
    clock: input.clock,
    fail,
    notFoundCode: "model-absent",
  });
  const model = selectedModel(result.body, boundary.config.modelId);
  return normalizeDiscovery(boundary, model, result.retrievedAt, url);
}

interface SelectedCatalogModel {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  contextWindow?: number;
  providerCreatedAt?: string;
}

interface AnthropicDiscoveryConfigSnapshot {
  baseUrl: string;
  providerId: string;
  modelId: string;
  apiKey: string;
  apiFormat: ModelProfileApiFormat;
  inputModalities: Array<"text" | "image">;
}

interface AnthropicDiscoveryBoundary {
  config: Readonly<AnthropicDiscoveryConfigSnapshot>;
  purpose: ModelProfilePurpose;
}

function snapshotDiscoveryBoundary(
  input: AnthropicApiCatalogDiscoveryInput,
): Readonly<AnthropicDiscoveryBoundary> {
  try {
    const inputModalities = uniqueModalities(input.config.profile.input);
    const config = Object.freeze({
      baseUrl: input.config.baseUrl,
      providerId: input.config.providerId,
      modelId: input.config.modelId,
      apiKey: input.config.apiKey,
      apiFormat: input.config.apiFormat,
      inputModalities: Object.freeze([...inputModalities]) as Array<"text" | "image">,
    });
    const purpose = input.purpose;
    validateDiscoveryConfiguration(config, purpose);
    return Object.freeze({ config, purpose });
  } catch (error) {
    if (error instanceof AnthropicApiCatalogDiscoveryError) throw error;
    return fail("invalid-configuration");
  }
}

function validateDiscoveryConfiguration(
  config: AnthropicDiscoveryConfigSnapshot,
  purpose: ModelProfilePurpose,
): void {
  if (purpose !== "policy" && purpose !== "judge") fail("invalid-configuration");
  let runtimeBase: URL;
  try {
    runtimeBase = new URL(config.baseUrl);
  } catch {
    return fail("invalid-configuration");
  }
  const runtimePath = runtimeBase.pathname.endsWith("/")
    ? runtimeBase.pathname.slice(0, -1)
    : runtimeBase.pathname;
  const runtimeIsAnthropic =
    runtimeBase.protocol === "https:" &&
    runtimeBase.username === "" &&
    runtimeBase.password === "" &&
    runtimeBase.origin === ANTHROPIC_API_ORIGIN &&
    runtimePath === "/v1" &&
    runtimeBase.search === "" &&
    runtimeBase.hash === "";
  if (
    !runtimeIsAnthropic ||
    config.apiFormat !== "messages" ||
    !safeCatalogIdentifier(config.providerId) ||
    !safeCatalogIdentifier(config.modelId) ||
    detectCredentialRuleIds(config.providerId).length > 0 ||
    detectCredentialRuleIds(config.modelId).length > 0 ||
    typeof config.apiKey !== "string" ||
    config.apiKey.length > 4_096 ||
    !ANTHROPIC_KEY_PATTERN.test(config.apiKey) ||
    containsInferenceCredential(config.apiKey) ||
    containsMetadataCredential(config.apiKey) ||
    /\s/u.test(config.apiKey) ||
    !config.inputModalities.includes("text")
  ) {
    fail("invalid-configuration");
  }
}

function selectedModel(
  body: Record<string, JsonEvidenceValue>,
  configuredModelId: string,
): SelectedCatalogModel {
  if (typeof body.id !== "string" || !safeCatalogIdentifier(body.id)) fail("malformed-response");
  if (body.id !== configuredModelId) fail("malformed-response");
  if (body.type !== undefined && body.type !== "model") fail("malformed-response");
  const maxInputTokens = optionalPositiveInteger(body, "max_input_tokens", fail);
  const maxOutputTokens = optionalPositiveInteger(body, "max_tokens", fail);
  // Live retrieve reports independent input and output budgets. Project them
  // into the combined-context approval envelope as their sum.
  const contextWindow = combinedContextWindow(maxInputTokens, maxOutputTokens);
  return {
    maxInputTokens,
    maxOutputTokens,
    contextWindow,
    providerCreatedAt:
      optionalTimestamp(body, "created_at", fail) ?? optionalTimestamp(body, "created", fail),
  };
}

function combinedContextWindow(
  maxInputTokens: number | undefined,
  maxOutputTokens: number | undefined,
): number | undefined {
  if (maxInputTokens === undefined || maxOutputTokens === undefined) return undefined;
  const contextWindow = maxInputTokens + maxOutputTokens;
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) fail("malformed-response");
  return contextWindow;
}

function normalizeDiscovery(
  boundary: AnthropicDiscoveryBoundary,
  model: SelectedCatalogModel,
  retrievedAt: string,
  requestUrl: string,
): AnthropicApiCatalogDiscoveryResult {
  try {
    const identity = createHash("sha256")
      .update(
        `${boundary.purpose}\0${boundary.config.providerId}\0${boundary.config.modelId}\0${retrievedAt}`,
      )
      .digest("hex")
      .slice(0, 32);
    const sourcePath = new URL(requestUrl).pathname;
    const observation = finalizeModelCatalogObservation({
      id: `observation:anthropic-api:${identity}`,
      purpose: boundary.purpose,
      source: {
        id: ANTHROPIC_API_CATALOG_SOURCE_ID,
        adapter: { ...ANTHROPIC_API_CATALOG_ADAPTER },
        retrievedAt,
      },
      fields: MODEL_CATALOG_FIELDS.map((field) => normalizedField(field, boundary.config, model)),
    });
    const provenance = finalizeModelCatalogObservationProvenance({
      observation,
      sourcePath,
    });
    return { observation, provenance };
  } catch {
    return fail("malformed-response");
  }
}

function normalizedField(
  field: ModelCatalogField,
  config: AnthropicDiscoveryConfigSnapshot,
  model: SelectedCatalogModel,
): ModelCatalogFieldEvidenceV1 {
  switch (field) {
    case "activity":
      return { field, state: "observed", value: "active" };
    case "apiFormats":
      return { field, state: "observed", value: [config.apiFormat] };
    case "inputModalities":
      return { field, state: "observed", value: [...config.inputModalities] };
    case "limitSemantics":
      return model.contextWindow === undefined
        ? { field, state: "unknown", reason: "not-authoritative" }
        : { field, state: "observed", value: "combined-context" };
    case "contextWindow":
      return model.contextWindow === undefined
        ? { field, state: "unknown", reason: "missing" }
        : { field, state: "observed", value: model.contextWindow };
    case "maxInputTokens":
      return model.maxInputTokens === undefined
        ? { field, state: "unknown", reason: "missing" }
        : { field, state: "observed", value: model.maxInputTokens };
    case "maxOutputTokens":
      return model.maxOutputTokens === undefined
        ? { field, state: "unknown", reason: "missing" }
        : { field, state: "observed", value: model.maxOutputTokens };
    case "modelId":
      return { field, state: "observed", value: config.modelId };
    case "origin":
      return { field, state: "observed", value: ANTHROPIC_API_ORIGIN };
    case "providerId":
      return { field, state: "observed", value: config.providerId };
    case "providerCreatedAt":
      return model.providerCreatedAt === undefined
        ? { field, state: "unknown", reason: "missing" }
        : { field, state: "observed", value: model.providerCreatedAt };
    case "providerUpdatedAt":
      return { field, state: "unknown", reason: "missing" };
    default:
      return { field, state: "unknown", reason: "not-authoritative" };
  }
}

function uniqueModalities(input: ReadonlyArray<"text" | "image">): Array<"text" | "image"> {
  return [...new Set(input)].sort();
}
