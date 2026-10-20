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
  OPENAI_API_CATALOG_ADAPTER,
  OPENAI_API_CATALOG_SOURCE_ID,
  OPENAI_API_ORIGIN,
} from "./catalog-serving-route.js";

export const OPENAI_API_CATALOG_SOURCE_PATH_PREFIX = "/v1/models/" as const;
const OPENAI_KEY_PATTERN = /^sk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}$/u;

export class OpenaiApiCatalogDiscoveryError extends Error {
  public readonly retryable = false as const;

  public constructor(public readonly code: DirectProviderCatalogFailureCode) {
    super(`OpenAI API model catalog discovery failed: ${code}.`);
    this.name = "OpenaiApiCatalogDiscoveryError";
  }
}

export interface OpenaiApiCatalogDiscoveryResult {
  observation: ModelCatalogObservationV1;
  provenance: ModelCatalogObservationProvenanceV1;
}

export interface OpenaiApiCatalogDiscoveryInput {
  config: ModelEndpointConfig;
  purpose: ModelProfilePurpose;
  fetch?: typeof globalThis.fetch;
  clock?: () => Date;
}

const fail = catalogFail(OpenaiApiCatalogDiscoveryError);

/**
 * Perform one explicit read-only OpenAI Models retrieve. This adapter is not
 * called by ordinary workflow execution and never reads Inference Hub Metadata.
 */
export async function discoverOpenaiApiModelCatalog(
  input: OpenaiApiCatalogDiscoveryInput,
): Promise<OpenaiApiCatalogDiscoveryResult> {
  const boundary = snapshotDiscoveryBoundary(input);
  const url = `${OPENAI_API_ORIGIN}${OPENAI_API_CATALOG_SOURCE_PATH_PREFIX}${boundary.config.modelId}`;
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
      authorization: `Bearer ${credentialForRequest(credential, url)}`,
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
  providerCreatedAt?: string;
}

interface OpenaiDiscoveryConfigSnapshot {
  baseUrl: string;
  providerId: string;
  modelId: string;
  apiKey: string;
  apiFormat: ModelProfileApiFormat;
  inputModalities: Array<"text" | "image">;
}

interface OpenaiDiscoveryBoundary {
  config: Readonly<OpenaiDiscoveryConfigSnapshot>;
  purpose: ModelProfilePurpose;
}

function snapshotDiscoveryBoundary(
  input: OpenaiApiCatalogDiscoveryInput,
): Readonly<OpenaiDiscoveryBoundary> {
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
    if (error instanceof OpenaiApiCatalogDiscoveryError) throw error;
    return fail("invalid-configuration");
  }
}

function validateDiscoveryConfiguration(
  config: OpenaiDiscoveryConfigSnapshot,
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
  const runtimeIsOpenAi =
    runtimeBase.protocol === "https:" &&
    runtimeBase.username === "" &&
    runtimeBase.password === "" &&
    runtimeBase.origin === OPENAI_API_ORIGIN &&
    runtimePath === "/v1" &&
    runtimeBase.search === "" &&
    runtimeBase.hash === "";
  if (
    !runtimeIsOpenAi ||
    config.apiFormat !== "chat_completions" ||
    !safeCatalogIdentifier(config.providerId) ||
    !safeCatalogIdentifier(config.modelId) ||
    detectCredentialRuleIds(config.providerId).length > 0 ||
    detectCredentialRuleIds(config.modelId).length > 0 ||
    typeof config.apiKey !== "string" ||
    config.apiKey.length > 4_096 ||
    !OPENAI_KEY_PATTERN.test(config.apiKey) ||
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
  if (body.object !== undefined && body.object !== "model") fail("malformed-response");
  // Live GET /v1/models/{id} returns id, object, created, owned_by, and optional
  // shutdown_date. Token limits are not on that object; leave them unknown.
  return {
    providerCreatedAt: optionalTimestamp(body, "created", fail),
  };
}

function normalizeDiscovery(
  boundary: OpenaiDiscoveryBoundary,
  model: SelectedCatalogModel,
  retrievedAt: string,
  requestUrl: string,
): OpenaiApiCatalogDiscoveryResult {
  try {
    const identity = createHash("sha256")
      .update(
        `${boundary.purpose}\0${boundary.config.providerId}\0${boundary.config.modelId}\0${retrievedAt}`,
      )
      .digest("hex")
      .slice(0, 32);
    const sourcePath = new URL(requestUrl).pathname;
    const observation = finalizeModelCatalogObservation({
      id: `observation:openai-api:${identity}`,
      purpose: boundary.purpose,
      source: {
        id: OPENAI_API_CATALOG_SOURCE_ID,
        adapter: { ...OPENAI_API_CATALOG_ADAPTER },
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
  config: OpenaiDiscoveryConfigSnapshot,
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
      return { field, state: "unknown", reason: "not-authoritative" };
    case "contextWindow":
    case "maxInputTokens":
    case "maxOutputTokens":
      return { field, state: "unknown", reason: "missing" };
    case "modelId":
      return { field, state: "observed", value: config.modelId };
    case "origin":
      return { field, state: "observed", value: OPENAI_API_ORIGIN };
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
