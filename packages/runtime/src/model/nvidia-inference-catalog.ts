// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type { ModelEndpointConfig } from "./configuration.js";
import { parseJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import {
  containsCatalogCredential,
  containsInferenceCredential,
  containsMetadataCredential,
} from "../security/credential-material.js";
import { detectCredentialRuleIds } from "../security/repository-scanner.js";
import {
  MODEL_CATALOG_FIELDS,
  finalizeModelCatalogObservation,
  type ModelCatalogField,
  type ModelCatalogFieldEvidenceV1,
  type ModelCatalogObservationV1,
  type ModelProfilePurpose,
} from "./catalog-contracts.js";
import {
  finalizeModelCatalogObservationProvenance,
  type ModelCatalogObservationProvenanceV1,
} from "./catalog-provenance.js";
import { OutboundProxyRefusal, outboundFetch } from "./outbound-http-policy.js";
import { createProviderBoundaryFetch } from "./provider.js";
import {
  EXECUTABLE_ROUTE_BASE_URLS,
  isExecutableRouteOrigin,
} from "../config/executable-route-urls.js";
import { NVIDIA_INFERENCE_CATALOG_ORIGIN } from "./catalog-serving-route.js";
import {
  credentialForRequest,
  releaseModelCredential,
} from "../security/model-credential-release.js";

const inferenceBaseUrl = EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"];
export const NVIDIA_INFERENCE_CATALOG_ENDPOINT =
  inferenceBaseUrl === undefined ? undefined : `${inferenceBaseUrl}/models`;
export { NVIDIA_INFERENCE_CATALOG_ORIGIN };
export const NVIDIA_INFERENCE_CATALOG_SOURCE_PATH = "/v1/models" as const;
export const NVIDIA_INFERENCE_CATALOG_MAX_BYTES = 1024 * 1024;
export const NVIDIA_INFERENCE_CATALOG_MAX_MODELS = 10_000;
export const NVIDIA_INFERENCE_CATALOG_TIMEOUT_MS = 5_000;

const ADAPTER = {
  id: "adapter:nvidia-inference-api-model-catalog",
  version: "1.0.0",
} as const;
const SOURCE_ID = "nvidia-inference-api-model-catalog";
const NVIDIA_INFERENCE_KEY_PATTERN = /^nvapi-[A-Za-z0-9_-]{20,}$/u;
const REDIRECT_BOUNDARY_MESSAGE = "Provider response rejected because redirects are not allowed.";
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 50_000;
const MAX_JSON_OBJECT_FIELDS = 64;
const MAX_JSON_STRING_BYTES = 64 * 1024;
const MAX_RESPONSE_CHUNKS = 16_384;

export type NvidiaInferenceCatalogDiscoveryFailureCode =
  | "invalid-configuration"
  | "timeout"
  | "network-failure"
  | "redirected-response"
  | "cross-origin-response"
  | "http-status"
  | "oversized-response"
  | "malformed-response"
  | "model-absent"
  | "model-duplicate";

/** Stable, content-free diagnostics for the opt-in catalog read. */
export class NvidiaInferenceCatalogDiscoveryError extends Error {
  public readonly retryable = false as const;

  public constructor(public readonly code: NvidiaInferenceCatalogDiscoveryFailureCode) {
    super(`NVIDIA Inference model catalog discovery failed: ${code}.`);
    this.name = "NvidiaInferenceCatalogDiscoveryError";
  }
}

export interface NvidiaInferenceCatalogDiscoveryResult {
  observation: ModelCatalogObservationV1;
  provenance: ModelCatalogObservationProvenanceV1;
}

export interface NvidiaInferenceCatalogDiscoveryInput {
  /** The runtime endpoint supplies the configured model ID and inference key. */
  config: ModelEndpointConfig;
  purpose: ModelProfilePurpose;
  /** Test seam only. The adapter still fixes the request URL, method, and headers. */
  fetch?: typeof globalThis.fetch;
  clock?: () => Date;
}

/**
 * Perform one explicit read-only NVIDIA Inference catalog lookup. This adapter
 * is not called by model registration or ordinary workflow execution.
 */
export async function discoverNvidiaInferenceModelCatalog(
  input: NvidiaInferenceCatalogDiscoveryInput,
): Promise<NvidiaInferenceCatalogDiscoveryResult> {
  const boundary = snapshotDiscoveryBoundary(input);
  const endpoint = configuredCatalogEndpoint(boundary.config.baseUrl);
  const delegate = input.fetch ?? outboundFetch();
  const clock = input.clock;
  if (typeof delegate !== "function" || (clock !== undefined && typeof clock !== "function")) {
    return fail("invalid-configuration");
  }
  // Released for the configured endpoint, which shares the catalog's origin,
  // and read outside the catch below so a refusal keeps its own code.
  const credential = releaseModelCredential(
    {
      endpoint: boundary.config.baseUrl,
      endpointSource: input.config.endpointSource,
      apiKey: boundary.config.apiKey,
    },
    "catalog-lookup",
  );
  const authorization = `Bearer ${credentialForRequest(credential, endpoint)}`;

  try {
    return await withEndToEndTimeout(async (signal, registerLateBody, registerActiveReader) => {
      const boundaryFetch = createProviderBoundaryFetch(endpoint, delegate);
      const response = await boundaryFetch(endpoint, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization,
        },
        redirect: "manual",
        signal,
      });
      registerLateBody(response);
      validateResponseEnvelope(response, endpoint);
      const body = await readBoundedBody(response, signal, registerActiveReader);
      const model = selectedModel(body, boundary.config.modelId);
      const retrievedAt = readClock(clock).toISOString();
      return normalizeDiscovery(boundary.config, boundary.purpose, model, retrievedAt);
    });
  } catch (error) {
    if (error instanceof NvidiaInferenceCatalogDiscoveryError) throw error;
    // A local proxy refusal sent nothing; it keeps its own code and next action.
    if (error instanceof OutboundProxyRefusal) throw error;
    if (error instanceof Error && error.message === REDIRECT_BOUNDARY_MESSAGE) {
      return fail("redirected-response");
    }
    return fail("network-failure");
  }
}

interface SelectedCatalogModel {
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

interface NvidiaInferenceDiscoveryConfigSnapshot {
  baseUrl: string;
  providerId: string;
  modelId: string;
  apiKey: string;
}

interface NvidiaInferenceDiscoveryBoundary {
  config: Readonly<NvidiaInferenceDiscoveryConfigSnapshot>;
  purpose: ModelProfilePurpose;
}

function snapshotDiscoveryBoundary(
  input: NvidiaInferenceCatalogDiscoveryInput,
): Readonly<NvidiaInferenceDiscoveryBoundary> {
  try {
    const suppliedConfig = input.config;
    const baseUrl = suppliedConfig.baseUrl;
    configuredCatalogEndpoint(baseUrl);
    const config = Object.freeze({
      baseUrl,
      providerId: suppliedConfig.providerId,
      modelId: suppliedConfig.modelId,
      apiKey: suppliedConfig.apiKey,
    });
    const purpose = input.purpose;
    validateDiscoveryConfiguration(config, purpose);
    return Object.freeze({ config, purpose });
  } catch (error) {
    if (error instanceof NvidiaInferenceCatalogDiscoveryError) throw error;
    return fail("invalid-configuration");
  }
}

function configuredCatalogEndpoint(baseUrl: string): string {
  let configured: URL;
  try {
    configured = new URL(baseUrl);
  } catch {
    return fail("invalid-configuration");
  }
  const path = configured.pathname.endsWith("/")
    ? configured.pathname.slice(0, -1)
    : configured.pathname;
  if (
    configured.protocol !== "https:" ||
    configured.username !== "" ||
    configured.password !== "" ||
    configured.search !== "" ||
    configured.hash !== "" ||
    path !== "/v1" ||
    !isExecutableRouteOrigin("nvidia-inference-api", configured.origin)
  ) {
    return fail("invalid-configuration");
  }
  return `${configured.origin}${NVIDIA_INFERENCE_CATALOG_SOURCE_PATH}`;
}

function validateDiscoveryConfiguration(
  config: NvidiaInferenceDiscoveryConfigSnapshot,
  purpose: ModelProfilePurpose,
): void {
  if (purpose !== "policy" && purpose !== "judge") fail("invalid-configuration");
  const catalogEndpoint = configuredCatalogEndpoint(config.baseUrl);
  let endpoint: URL;
  let runtimeBase: URL;
  try {
    endpoint = new URL(catalogEndpoint);
    runtimeBase = new URL(config.baseUrl);
  } catch {
    return fail("invalid-configuration");
  }
  const endpointIsExact =
    endpoint.protocol === "https:" &&
    endpoint.username === "" &&
    endpoint.password === "" &&
    isExecutableRouteOrigin("nvidia-inference-api", endpoint.origin) &&
    endpoint.pathname === NVIDIA_INFERENCE_CATALOG_SOURCE_PATH &&
    endpoint.search === "" &&
    endpoint.hash === "" &&
    endpoint.href === catalogEndpoint;
  const runtimePath = runtimeBase.pathname.endsWith("/")
    ? runtimeBase.pathname.slice(0, -1)
    : runtimeBase.pathname;
  const runtimeIsInference =
    runtimeBase.protocol === "https:" &&
    runtimeBase.username === "" &&
    runtimeBase.password === "" &&
    runtimeBase.origin === endpoint.origin &&
    runtimePath === "/v1" &&
    runtimeBase.search === "" &&
    runtimeBase.hash === "";
  if (
    !endpointIsExact ||
    !runtimeIsInference ||
    !safeIdentifier(config.providerId) ||
    !safeIdentifier(config.modelId) ||
    detectCredentialRuleIds(config.providerId).length > 0 ||
    detectCredentialRuleIds(config.modelId).length > 0 ||
    typeof config.apiKey !== "string" ||
    config.apiKey.length > 4_096 ||
    !NVIDIA_INFERENCE_KEY_PATTERN.test(config.apiKey) ||
    !containsInferenceCredential(config.apiKey) ||
    containsMetadataCredential(config.apiKey) ||
    !containsCatalogCredential(config.apiKey) ||
    /\s/u.test(config.apiKey)
  ) {
    fail("invalid-configuration");
  }
}

function validateResponseEnvelope(response: Response, endpoint: string): void {
  if (response.redirected) rejectResponse(response, "redirected-response");
  if (response.url !== endpoint) {
    rejectResponse(response, "cross-origin-response");
  }
  if (response.status !== 200) rejectResponse(response, "http-status");
  const contentType = response.headers.get("content-type");
  if (!contentType || !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    rejectResponse(response, "malformed-response");
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/u.test(contentLength)) {
      rejectResponse(response, "malformed-response");
    }
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length)) rejectResponse(response, "malformed-response");
    if (length > NVIDIA_INFERENCE_CATALOG_MAX_BYTES) {
      rejectResponse(response, "oversized-response");
    }
  }
}

function rejectResponse(
  response: Response,
  code: NvidiaInferenceCatalogDiscoveryFailureCode,
): never {
  // Start cleanup without awaiting provider-controlled stream behavior. The
  // end-to-end deadline remains authoritative and cleanup detail stays hidden.
  void safeCancelBody(response);
  return fail(code);
}

async function readBoundedBody(
  response: Response,
  signal: AbortSignal,
  registerActiveReader: (reader: ReadableStreamDefaultReader<Uint8Array> | undefined) => void,
): Promise<Uint8Array> {
  if (!response.body) fail("malformed-response");
  const reader = response.body.getReader();
  registerActiveReader(reader);
  const chunks: Uint8Array[] = [];
  let length = 0;
  let chunkCount = 0;
  let rejectAborted: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = () => reject(new NvidiaInferenceCatalogDiscoveryError("timeout"));
    if (signal.aborted) rejectAborted();
    else signal.addEventListener("abort", rejectAborted, { once: true });
  });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), aborted]);
      if (part.done) break;
      const chunk = part.value;
      chunkCount += 1;
      if (chunk.byteLength === 0 || chunkCount > MAX_RESPONSE_CHUNKS) {
        startReaderCancellation(reader);
        fail("malformed-response");
      }
      length += chunk.byteLength;
      if (length > NVIDIA_INFERENCE_CATALOG_MAX_BYTES) {
        startReaderCancellation(reader);
        fail("oversized-response");
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof NvidiaInferenceCatalogDiscoveryError) throw error;
    return fail("network-failure");
  } finally {
    if (rejectAborted) signal.removeEventListener("abort", rejectAborted);
    registerActiveReader(undefined);
    try {
      reader.releaseLock();
    } catch {
      // Cleanup cannot replace the stable discovery diagnostic.
    }
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function selectedModel(body: Uint8Array, configuredModelId: string): SelectedCatalogModel {
  let parsed: JsonEvidenceValue;
  try {
    parsed = parseJsonEvidence(body);
    assertBoundedJson(parsed);
  } catch {
    return fail("malformed-response");
  }
  if (
    !plainRecord(parsed) ||
    parsed.object !== "list" ||
    !Array.isArray(parsed.data) ||
    parsed.data.length > NVIDIA_INFERENCE_CATALOG_MAX_MODELS
  ) {
    fail("malformed-response");
  }
  let match: Record<string, JsonEvidenceValue> | undefined;
  for (const candidate of parsed.data) {
    if (
      !plainRecord(candidate) ||
      typeof candidate.id !== "string" ||
      !safeIdentifier(candidate.id)
    ) {
      fail("malformed-response");
    }
    if (candidate.id !== configuredModelId) continue;
    if (match) fail("model-duplicate");
    match = candidate;
  }
  if (!match) fail("model-absent");
  return {
    ...optionalLimit(match, "max_input_tokens", "maxInputTokens"),
    ...optionalLimit(match, "max_output_tokens", "maxOutputTokens"),
  };
}

function optionalLimit(
  model: Record<string, JsonEvidenceValue>,
  sourceName: "max_input_tokens" | "max_output_tokens",
  targetName: "maxInputTokens" | "maxOutputTokens",
): Partial<SelectedCatalogModel> {
  const value = model[sourceName];
  if (value === undefined || value === null) return {};
  if (!Number.isSafeInteger(value) || Number(value) <= 0) fail("malformed-response");
  return { [targetName]: value as number };
}

function normalizeDiscovery(
  config: NvidiaInferenceDiscoveryConfigSnapshot,
  purpose: ModelProfilePurpose,
  model: SelectedCatalogModel,
  retrievedAt: string,
): NvidiaInferenceCatalogDiscoveryResult {
  try {
    const identity = createHash("sha256")
      .update(`${purpose}\0${config.providerId}\0${config.modelId}\0${retrievedAt}`)
      .digest("hex")
      .slice(0, 32);
    const observation = finalizeModelCatalogObservation({
      id: `observation:nvidia-inference-api:${identity}`,
      purpose,
      source: {
        id: SOURCE_ID,
        adapter: { ...ADAPTER },
        retrievedAt,
      },
      fields: MODEL_CATALOG_FIELDS.map((field) => normalizedField(field, config, model)),
    });
    const provenance = finalizeModelCatalogObservationProvenance({
      observation,
      sourcePath: NVIDIA_INFERENCE_CATALOG_SOURCE_PATH,
    });
    return { observation, provenance };
  } catch {
    return fail("malformed-response");
  }
}

function normalizedField(
  field: ModelCatalogField,
  config: NvidiaInferenceDiscoveryConfigSnapshot,
  model: SelectedCatalogModel,
): ModelCatalogFieldEvidenceV1 {
  switch (field) {
    case "activity":
      return { field, state: "observed", value: "active" };
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
      return {
        field,
        state: "observed",
        value: new URL(config.baseUrl).origin,
      };
    case "providerId":
      return { field, state: "observed", value: config.providerId };
    case "providerCreatedAt":
    case "providerUpdatedAt":
      return { field, state: "unknown", reason: "missing" };
    default:
      return { field, state: "unknown", reason: "not-authoritative" };
  }
}

function assertBoundedJson(value: JsonEvidenceValue, depth = 0, budget = { nodes: 0 }): void {
  budget.nodes += 1;
  if (depth > MAX_JSON_DEPTH || budget.nodes > MAX_JSON_NODES) {
    fail("malformed-response");
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_JSON_STRING_BYTES) {
      fail("malformed-response");
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    if (value.length > NVIDIA_INFERENCE_CATALOG_MAX_MODELS) fail("malformed-response");
    for (const item of value) assertBoundedJson(item, depth + 1, budget);
    return;
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_JSON_OBJECT_FIELDS) fail("malformed-response");
  for (const [key, item] of entries) {
    if (Buffer.byteLength(key, "utf8") > 256) fail("malformed-response");
    assertBoundedJson(item, depth + 1, budget);
  }
}

function plainRecord(value: JsonEvidenceValue): value is Record<string, JsonEvidenceValue> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function safeIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/u.test(value) &&
    !value.includes("..") &&
    !value.includes("//")
  );
}

function readClock(clock: (() => Date) | undefined): Date {
  try {
    const value = (clock ?? (() => new Date()))();
    if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
      fail("invalid-configuration");
    }
    return value;
  } catch (error) {
    if (error instanceof NvidiaInferenceCatalogDiscoveryError) throw error;
    return fail("invalid-configuration");
  }
}

async function withEndToEndTimeout<T>(
  operation: (
    signal: AbortSignal,
    registerLateBody: (response: Response) => void,
    registerActiveReader: (reader: ReadableStreamDefaultReader<Uint8Array> | undefined) => void,
  ) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  let response: Response | undefined;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = operation(
    controller.signal,
    (candidate) => {
      response = candidate;
      if (timedOut) void safeCancelBody(candidate);
    },
    (candidate) => {
      activeReader = candidate;
      if (timedOut && candidate) startReaderCancellation(candidate);
    },
  );
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      if (activeReader) startReaderCancellation(activeReader);
      else if (response) void safeCancelBody(response);
      reject(new NvidiaInferenceCatalogDiscoveryError("timeout"));
    }, NVIDIA_INFERENCE_CATALOG_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function safeCancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cleanup details must never replace the content-free timeout diagnostic.
  }
}

function startReaderCancellation(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  // Do not await provider-controlled underlyingSource.cancel behavior.
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // Cleanup cannot replace the stable discovery diagnostic.
  }
}

function fail(code: NvidiaInferenceCatalogDiscoveryFailureCode): never {
  throw new NvidiaInferenceCatalogDiscoveryError(code);
}
