// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import {
  containsInferenceCredential,
  containsMetadataCredential,
} from "../security/credential-material.js";
import { detectCredentialRuleIds } from "../security/repository-scanner.js";
import {
  finalizeModelCatalogObservation,
  type ModelCatalogField,
  type ModelCatalogFieldEvidenceV1,
  type ModelCatalogObservationV1,
  type ModelCatalogPriceV1,
  type ModelProfilePurpose,
} from "./catalog-contracts.js";
import {
  finalizeModelCatalogObservationProvenance,
  type ModelCatalogObservationProvenanceV1,
} from "./catalog-provenance.js";
import { sha256 } from "../content-ir/canonical.js";
import { OutboundProxyRefusal, outboundFetch } from "./outbound-http-policy.js";

const ADAPTER = {
  id: "adapter:nvidia-inference-hub-metadata",
  version: "1.0.0",
} as const;

const DEFAULT_LIMITS = {
  timeoutMs: 5_000,
  maxResponseBytes: 1024 * 1024,
  maxResponseChunks: 4_096,
  maxPages: 8,
  maxItemsPerPage: 100,
  maxItems: 256,
  maxCursorBytes: 512,
  maxJsonDepth: 24,
  maxJsonNodes: 20_000,
  maxStringBytes: 16_384,
} as const;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const METADATA_KEY_PATTERN = /^ihub_api_[A-Za-z0-9_-]{20,}$/u;
const PATH_PATTERN = /^\/(?!\/)[^\u0000-\u001f\u007f?#]*$/u;

export type InferenceHubMetadataMode = "browse" | "search" | "slim";
export type InferenceHubMetadataAuthority = "authenticated" | "public-preview";
/** Closed allowlist of label query parameters used by Metadata search APIs. */
export const INFERENCE_HUB_METADATA_LABEL_PARAMETERS = ["label", "q", "query", "search"] as const;
export type InferenceHubMetadataLabelParameter =
  (typeof INFERENCE_HUB_METADATA_LABEL_PARAMETERS)[number];

export interface InferenceHubMetadataEndpoint {
  /** Exact credential boundary. Paths, queries, userinfo, and fragments are rejected. */
  origin: string;
  /** Configured relative endpoint. Response-provided URLs are never followed. */
  path: string;
  mode: InferenceHubMetadataMode;
  /**
   * Search APIs vary between label/q/query/search. This remains a closed
   * allowlist. Search mode defaults to `search`, the parameter of the Inference
   * Hub Metadata `/api/v1/models` search; browse and slim default to `label`.
   */
  labelParameter?: InferenceHubMetadataLabelParameter;
}

export interface InferenceHubMetadataLimits {
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxResponseChunks?: number;
  maxPages?: number;
  maxItemsPerPage?: number;
  maxItems?: number;
  maxCursorBytes?: number;
  maxJsonDepth?: number;
  maxJsonNodes?: number;
  maxStringBytes?: number;
}

export interface InferenceHubMetadataInspection {
  requested: boolean;
  authority: InferenceHubMetadataAuthority;
  purpose: ModelProfilePurpose;
  label: string;
  endpoint: InferenceHubMetadataEndpoint;
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  clock?: () => Date;
  limits?: InferenceHubMetadataLimits;
}

export interface InferenceHubMetadataDiagnostic {
  code: "metadata-api-key-missing";
  message: string;
}

export type InferenceHubMetadataInspectionResult =
  | { status: "not-requested" }
  | { status: "optional-capability-unavailable"; diagnostic: InferenceHubMetadataDiagnostic }
  | {
      status: "observed";
      authority: InferenceHubMetadataAuthority;
      observation: ModelCatalogObservationV1;
      provenance: ModelCatalogObservationProvenanceV1;
    };

export type InferenceHubMetadataErrorCode =
  | "invalid-configuration"
  | "invalid-metadata-credential"
  | "request-failed"
  | "request-timeout"
  | "response-rejected"
  | "pagination-rejected"
  | "model-not-found"
  | "duplicate-model-label";

const ERROR_MESSAGES: Record<InferenceHubMetadataErrorCode, string> = {
  "invalid-configuration": "Inference Hub Metadata API inspection configuration was rejected.",
  "invalid-metadata-credential":
    "The Metadata API credential is invalid; use a distinct ihub_api_ credential.",
  "request-failed":
    "Inference Hub Metadata API inspection failed without retaining response content.",
  "request-timeout": "Inference Hub Metadata API inspection exceeded its bounded timeout.",
  "response-rejected": "Inference Hub Metadata API response was rejected.",
  "pagination-rejected": "Inference Hub Metadata API pagination was rejected.",
  "model-not-found": "The exact configured model label was not present in Metadata API results.",
  "duplicate-model-label": "The exact configured model label appeared more than once.",
};

export class InferenceHubMetadataError extends Error {
  public constructor(public readonly code: InferenceHubMetadataErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "InferenceHubMetadataError";
  }
}

/**
 * Perform an explicitly requested, read-only metadata inspection. The raw JSON
 * and credential are scoped to this call and cannot appear in its return type.
 */
export async function inspectInferenceHubMetadata(
  input: InferenceHubMetadataInspection,
): Promise<InferenceHubMetadataInspectionResult> {
  if (!input.requested) return { status: "not-requested" };

  const endpoint = validateEndpoint(input.endpoint);
  const purpose = validatePurpose(input.purpose);
  const label = validateLabel(input.label);
  const limits = validateLimits(input.limits);
  const authority = validateAuthority(input.authority);
  const delegate = input.fetch ?? outboundFetch();
  const clock = input.clock ?? (() => new Date());
  const credential =
    authority === "authenticated"
      ? readMetadataCredential(input.environment ?? process.env)
      : undefined;
  if (authority === "authenticated" && credential === null) {
    return {
      status: "optional-capability-unavailable",
      diagnostic: {
        code: "metadata-api-key-missing",
        message: [
          "Optional Inference Hub Metadata API discovery is unavailable.",
          "Set INFERENCE_HUB_METADATA_API_KEY to a distinct ihub_api_ credential and retry the requested inspection.",
          "Inference-provider credentials are not substitutes.",
        ].join(" "),
      },
    };
  }

  const fetched = await fetchExactRecord({
    endpoint,
    label,
    authority,
    credential: credential ?? undefined,
    delegate,
    limits,
  });
  const retrievedAt = normalizedNow(clock);
  const observation = normalizeObservation({
    authority,
    purpose,
    label,
    origin: endpoint.origin,
    record: fetched.record,
    retrievedAt,
  });
  const trace = sha256(fetched.requestPaths.join("\n"));
  const sourcePath = `${endpoint.path}?docsfab-trace-sha256=${trace}&pages=${fetched.requestPaths.length}`;
  const provenance = finalizeModelCatalogObservationProvenance({ observation, sourcePath });
  return { status: "observed", authority, observation, provenance };
}

interface ValidatedLimits {
  timeoutMs: number;
  maxResponseBytes: number;
  maxResponseChunks: number;
  maxPages: number;
  maxItemsPerPage: number;
  maxItems: number;
  maxCursorBytes: number;
  maxJsonDepth: number;
  maxJsonNodes: number;
  maxStringBytes: number;
}

interface FetchInput {
  endpoint: InferenceHubMetadataEndpoint;
  label: string;
  authority: InferenceHubMetadataAuthority;
  credential?: string;
  delegate: typeof globalThis.fetch;
  limits: ValidatedLimits;
}

interface FetchResult {
  record: Record<string, JsonEvidenceValue>;
  requestPaths: string[];
}

async function fetchExactRecord(input: FetchInput): Promise<FetchResult> {
  const requestPaths: string[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let itemsSeen = 0;
  let selected: Record<string, JsonEvidenceValue> | undefined;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.limits.timeoutMs);

  try {
    for (let page = 0; page < input.limits.maxPages; page += 1) {
      const url = pageUrl(
        input.endpoint,
        input.label,
        cursor,
        input.authority,
        input.limits.maxItemsPerPage,
      );
      requestPaths.push(`${url.pathname}${url.search}`);
      const payload = await boundedPageRequest(
        url,
        input,
        input.limits,
        controller.signal,
        () => timedOut,
      );
      validateJsonBudget(payload, input.limits);
      const parsed = parsePage(payload, input.limits, input.authority, input.endpoint.mode);
      itemsSeen += parsed.items.length;
      if (itemsSeen > input.limits.maxItems) fail("pagination-rejected");

      for (const item of parsed.items) {
        const itemLabel = recordLabel(item);
        if (itemLabel === input.label) {
          if (selected) fail("duplicate-model-label");
          selected = item;
        }
      }

      cursor = parsed.nextCursor;
      if (!cursor) return selected ? { record: selected, requestPaths } : fail("model-not-found");
      validateCursor(cursor, input.limits);
      if (seenCursors.has(cursor)) fail("pagination-rejected");
      seenCursors.add(cursor);
    }
    return fail("pagination-rejected");
  } finally {
    clearTimeout(timer);
  }
}

function pageUrl(
  endpoint: InferenceHubMetadataEndpoint,
  label: string,
  cursor: string | undefined,
  authority: InferenceHubMetadataAuthority,
  pageSize: number,
): URL {
  const url = new URL(endpoint.path, endpoint.origin);
  const labelParameter =
    endpoint.labelParameter ?? (endpoint.mode === "search" ? "search" : "label");
  // Browse still sends the exact label as a hint; selection remains local and exact.
  url.searchParams.set(labelParameter, label);
  url.searchParams.set("limit", String(pageSize));
  if (cursor) url.searchParams.set("cursor", cursor);
  if (authority === "public-preview") url.searchParams.set("view", "descriptive");
  return url;
}

async function boundedPageRequest(
  url: URL,
  input: FetchInput,
  limits: ValidatedLimits,
  signal: AbortSignal,
  timedOut: () => boolean,
): Promise<JsonEvidenceValue> {
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (input.authority === "authenticated") {
      if (!input.credential) fail("invalid-metadata-credential");
      // The Metadata API authenticates `ihub_api_` keys by `x-api-key`; it
      // answers 403 to the same key sent as `Authorization: Bearer`.
      headers["x-api-key"] = input.credential;
    }
    const request = Promise.resolve().then(() =>
      input.delegate(url, {
        method: "GET",
        headers,
        redirect: "manual",
        signal,
      }),
    );
    void request.then(
      async (lateResponse) => {
        if (signal.aborted) await cancelResponse(lateResponse);
      },
      () => undefined,
    );
    const response = await Promise.race([
      request,
      new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(new Error("aborted"));
        else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    ]);
    if (REDIRECT_STATUSES.has(response.status)) {
      void cancelResponse(response);
      fail("response-rejected");
    }
    if (response.redirected || (response.url && response.url !== url.href)) {
      void cancelResponse(response);
      fail("response-rejected");
    }
    if (response.status !== 200) {
      void cancelResponse(response);
      fail("request-failed");
    }
    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      void cancelResponse(response);
      fail("response-rejected");
    }
    const payload = await readBoundedJson(response, limits, signal);
    if (timedOut() || signal.aborted) fail("request-timeout");
    return payload;
  } catch (error) {
    // A local proxy refusal sent nothing; it keeps its own code and next action.
    if (error instanceof OutboundProxyRefusal) throw error;
    if (error instanceof InferenceHubMetadataError) throw error;
    fail(timedOut() || signal.aborted ? "request-timeout" : "request-failed");
  }
}

async function readBoundedJson(
  response: Response,
  limits: ValidatedLimits,
  signal: AbortSignal,
): Promise<JsonEvidenceValue> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/u.test(contentLength)) {
      void cancelResponse(response);
      fail("response-rejected");
    }
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length > limits.maxResponseBytes) {
      void cancelResponse(response);
      fail("response-rejected");
    }
  }
  if (!response.body) fail("response-rejected");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let chunkCount = 0;
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(new Error("aborted"));
    else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  try {
    while (true) {
      const result = await Promise.race([reader.read(), aborted]);
      if (result.done) break;
      chunkCount += 1;
      if (result.value.byteLength === 0 || chunkCount > limits.maxResponseChunks) {
        void reader.cancel().catch(() => undefined);
        fail("response-rejected");
      }
      total += result.value.byteLength;
      if (total > limits.maxResponseBytes) {
        void reader.cancel().catch(() => undefined);
        fail("response-rejected");
      }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return parseJsonEvidence(bytes);
    } catch {
      return fail("response-rejected");
    }
  } catch (error) {
    if (error instanceof InferenceHubMetadataError) throw error;
    if (signal.aborted) {
      void reader.cancel().catch(() => undefined);
      return fail("request-timeout");
    }
    return fail("response-rejected");
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Cleanup cannot delay or replace the stable inspection disposition.
    }
  }
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Response details are deliberately suppressed.
  }
}

function parsePage(
  value: JsonEvidenceValue,
  limits: ValidatedLimits,
  authority: InferenceHubMetadataAuthority,
  mode: InferenceHubMetadataMode,
): { items: Array<Record<string, JsonEvidenceValue>>; nextCursor?: string } {
  const root = jsonRecord(value);
  rejectResponseNextUrl(root);
  const candidates = [root.models, root.items, root.data, root.model].filter(
    (item) => item !== undefined,
  );
  const rootIsDirectRecord = candidates.length === 0 && recordLabel(root) !== undefined;
  if (candidates.length > 1 || (!rootIsDirectRecord && candidates.length !== 1)) {
    fail("response-rejected");
  }
  const candidate = candidates[0];
  let items: Array<Record<string, JsonEvidenceValue>>;
  if (rootIsDirectRecord) {
    if (authority !== "public-preview" && mode !== "slim") fail("response-rejected");
    items = [root];
  } else if (Array.isArray(candidate)) {
    if (candidate.length > limits.maxItemsPerPage) fail("response-rejected");
    items = candidate.map(jsonRecord);
  } else {
    if ((authority !== "public-preview" && mode !== "slim") || candidate === undefined) {
      fail("response-rejected");
    }
    items = [jsonRecord(candidate)];
  }
  const directCursor = aliased(root, ["nextCursor", "next_cursor"]);
  const pagination = root.pagination === undefined ? undefined : jsonRecord(root.pagination);
  if (pagination) rejectResponseNextUrl(pagination);
  const nestedCursor = pagination ? aliased(pagination, ["nextCursor", "next_cursor"]) : undefined;
  if (directCursor !== undefined && nestedCursor !== undefined) fail("response-rejected");
  const nextCursor = directCursor ?? nestedCursor;
  if (nextCursor !== undefined && nextCursor !== null && typeof nextCursor !== "string") {
    fail("response-rejected");
  }
  return {
    items,
    ...(typeof nextCursor === "string" && nextCursor.length > 0 ? { nextCursor } : {}),
  };
}

function rejectResponseNextUrl(root: Record<string, JsonEvidenceValue>): void {
  if (
    ["next", "nextUrl", "next_url", "nextPage", "next_page"].some(
      (key) => Object.hasOwn(root, key) && root[key] !== null,
    )
  )
    fail("pagination-rejected");
}

function recordLabel(record: Record<string, JsonEvidenceValue>): string | undefined {
  const value = aliased(record, ["label", "modelLabel", "model_label"]);
  if (value === undefined) return undefined;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 200) {
    fail("response-rejected");
  }
  return value;
}

interface NormalizeInput {
  authority: InferenceHubMetadataAuthority;
  purpose: ModelProfilePurpose;
  label: string;
  origin: string;
  record: Record<string, JsonEvidenceValue>;
  retrievedAt: string;
}

function normalizeObservation(input: NormalizeInput): ModelCatalogObservationV1 {
  const label = recordLabel(input.record);
  if (label !== input.label) fail("response-rejected");
  const providerId = providerIdentity(input.record);
  const fields =
    input.authority === "public-preview"
      ? publicPreviewFields(input.label, providerId, input.origin)
      : authenticatedFields(input.record, input.label, providerId, input.origin);
  const identity = sha256(
    `${input.purpose}\n${input.origin}\n${input.label}\n${input.retrievedAt}`,
  );
  try {
    return finalizeModelCatalogObservation({
      id: `observation:ihub-metadata:${identity.slice(0, 32)}`,
      purpose: input.purpose,
      source: {
        id: `source:ihub-metadata:${input.authority}`,
        adapter: {
          id: `${ADAPTER.id}:${input.authority}`,
          version: ADAPTER.version,
        },
        retrievedAt: input.retrievedAt,
      },
      fields,
    });
  } catch {
    return fail("response-rejected");
  }
}

function publicPreviewFields(
  label: string,
  providerId: string,
  origin: string,
): ModelCatalogFieldEvidenceV1[] {
  return fieldList(
    {
      modelId: observed("modelId", label),
      providerId: observed("providerId", providerId),
      origin: observed("origin", origin),
    },
    "not-authoritative",
  );
}

function authenticatedFields(
  record: Record<string, JsonEvidenceValue>,
  label: string,
  providerId: string,
  origin: string,
): ModelCatalogFieldEvidenceV1[] {
  // `capabilities` is either a nested flag object or, on the
  // `inference-backend` catalog, a descriptive tag list such as
  // ["chat", "reasoning", "tool-use"] beside top-level `supports_*` flags.
  const capabilitySource = aliased(record, ["capabilities", "features"]);
  const capabilityTags = Array.isArray(capabilitySource)
    ? capabilityTagSet(capabilitySource)
    : undefined;
  const capabilities = Array.isArray(capabilitySource)
    ? undefined
    : optionalRecord(capabilitySource);
  const limits = optionalRecord(aliased(record, ["limits", "token_limits", "tokenLimits"]));
  const pricing = aliased(record, ["pricing", "price"]);
  const activity = normalizeActivity(
    aliased(record, ["status", "state", "activity"]),
    optionalBoolean(aliased(record, ["is_active", "isActive"])),
    optionalBoolean(aliased(record, ["is_draft", "isDraft"])),
  );
  const reasoning = capabilityEvidence(
    "reasoning",
    aliasedAcross(record, capabilities, ["reasoning", "supports_reasoning"]),
    capabilityTags,
    "reasoning",
  );
  const toolUse = capabilityEvidence(
    "toolUse",
    aliasedAcross(record, capabilities, ["toolUse", "tool_use", "tools", "supports_tool_use"]),
    capabilityTags,
    "tool-use",
  );
  const explicitFormats = stringArray(
    aliasedAcross(record, capabilities, ["apiFormats", "api_formats"]),
    ["chat_completions", "messages", "responses"],
  );
  const chat = capabilityFlag(
    aliasedAcross(record, capabilities, [
      "chat",
      "chat_completion",
      "chatCompletion",
      "supports_chat",
    ]),
    capabilityTags,
    "chat",
  );
  if (explicitFormats && chat === false && explicitFormats.includes("chat_completions")) {
    fail("response-rejected");
  }
  const apiFormats = explicitFormats
    ? observed("apiFormats", explicitFormats)
    : chat === true
      ? observed("apiFormats", ["chat_completions"])
      : chat === false
        ? unsupported("apiFormats")
        : unknown("apiFormats", "missing");
  const modalities =
    stringArray(
      aliasedAcross(record, capabilities, ["inputModalities", "input_modalities", "modalities"]),
      ["audio", "image", "text", "video"],
    ) ?? flaggedInputModalities(record, capabilities, chat);
  const inputModalities = modalities
    ? observed("inputModalities", modalities)
    : unknown("inputModalities", "missing");
  const contextWindow = integerEvidence(
    "contextWindow",
    aliasedAcross(record, limits, [
      "contextWindow",
      "context_window",
      "contextLength",
      "context_length",
      "context_length_tokens",
    ]),
  );
  const maxInputTokens = integerEvidence(
    "maxInputTokens",
    aliasedAcross(record, limits, ["maxInputTokens", "max_input_tokens"]),
  );
  const maxOutputTokens = integerEvidence(
    "maxOutputTokens",
    aliasedAcross(record, limits, ["maxOutputTokens", "max_output_tokens"]),
  );
  const limitSemanticsValue = aliasedAcross(record, limits, ["limitSemantics", "limit_semantics"]);
  const limitSemantics =
    limitSemanticsValue === undefined
      ? unknown("limitSemantics", "missing")
      : typeof limitSemanticsValue === "string" &&
          ["combined-context", "independent-input-output"].includes(limitSemanticsValue)
        ? observed("limitSemantics", limitSemanticsValue)
        : fail("response-rejected");
  const prices = pricingEvidence(pricing);

  return fieldList(
    {
      activity,
      apiFormats,
      billingInterpretation: prices.billingInterpretation,
      cacheReadPrice: prices.cacheReadPrice,
      cacheWritePrice: prices.cacheWritePrice,
      contextWindow,
      inputModalities,
      inputPrice: prices.inputPrice,
      limitSemantics,
      maxInputTokens,
      maxOutputTokens,
      modelId: observed("modelId", label),
      origin: observed("origin", origin),
      outputPrice: prices.outputPrice,
      providerCreatedAt: timestampEvidence(
        "providerCreatedAt",
        aliased(record, ["providerCreatedAt", "provider_created_at", "createdAt", "created_at"]),
      ),
      providerId: observed("providerId", providerId),
      providerUpdatedAt: timestampEvidence(
        "providerUpdatedAt",
        aliased(record, ["providerUpdatedAt", "provider_updated_at", "updatedAt", "updated_at"]),
      ),
      reasoning,
      supportsDeveloperRole: booleanEvidence(
        "supportsDeveloperRole",
        aliasedAcross(record, capabilities, ["supportsDeveloperRole", "supports_developer_role"]),
      ),
      supportsReasoningEffort: booleanEvidence(
        "supportsReasoningEffort",
        aliasedAcross(record, capabilities, [
          "supportsReasoningEffort",
          "supports_reasoning_effort",
        ]),
      ),
      supportsSystemRole: booleanEvidence(
        "supportsSystemRole",
        aliasedAcross(record, capabilities, ["supportsSystemRole", "supports_system_role"]),
      ),
      toolUse,
    },
    "missing",
  );
}

type FieldMap = Partial<Record<ModelCatalogField, ModelCatalogFieldEvidenceV1>>;

function fieldList(
  values: FieldMap,
  fallback: "missing" | "not-authoritative",
): ModelCatalogFieldEvidenceV1[] {
  const fields: ModelCatalogField[] = [
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
  ];
  return fields.map((field) => values[field] ?? unknown(field, fallback));
}

function observed(
  field: ModelCatalogField,
  value: boolean | number | string | string[] | ModelCatalogPriceV1,
): ModelCatalogFieldEvidenceV1 {
  return { field, state: "observed", value };
}

function unknown(
  field: ModelCatalogField,
  reason: "missing" | "not-authoritative" | "source-unavailable",
): ModelCatalogFieldEvidenceV1 {
  return { field, state: "unknown", reason };
}

function unsupported(field: ModelCatalogField): ModelCatalogFieldEvidenceV1 {
  return { field, state: "unsupported", reason: "model-unsupported" };
}

function providerIdentity(record: Record<string, JsonEvidenceValue>): string {
  const value = aliased(record, ["providerId", "provider_id", "provider"]);
  if (typeof value === "string") return validateIdentifier(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const nested = aliased(value, ["id", "label", "name"]);
    if (typeof nested === "string") return validateIdentifier(nested);
  }
  return fail("response-rejected");
}

function normalizeActivity(
  value: JsonEvidenceValue | undefined,
  isActive: boolean | undefined,
  isDraft: boolean | undefined,
): ModelCatalogFieldEvidenceV1 {
  // `is_draft: true` wins over `is_active`; `is_draft: false` alone says nothing
  // about whether the record is active.
  const flagged =
    isDraft === true
      ? "draft"
      : isActive === true
        ? "active"
        : isActive === false
          ? "inactive"
          : undefined;
  if (value === undefined) {
    return flagged === undefined ? unknown("activity", "missing") : observed("activity", flagged);
  }
  if (typeof value !== "string" || !["active", "inactive", "draft", "deprecated"].includes(value)) {
    return fail("response-rejected");
  }
  if (flagged !== undefined && flagged !== value) return fail("response-rejected");
  return observed("activity", value);
}

/**
 * Descriptive tags are matched only against the three exact capability tags
 * below; any other string is ignored. The JSON budget already bounds count and
 * size, so an unfamiliar tag spelling does not reject an otherwise valid record.
 */
function capabilityTagSet(value: JsonEvidenceValue[]): ReadonlySet<string> {
  if (value.some((item) => typeof item !== "string")) return fail("response-rejected");
  return new Set(value as string[]);
}

/**
 * An explicit boolean flag is authoritative. A descriptive tag can only add a
 * `true`; its absence is not evidence of `false`. A flag that contradicts its
 * own record's tag list is rejected rather than resolved.
 */
function capabilityFlag(
  value: JsonEvidenceValue | undefined,
  tags: ReadonlySet<string> | undefined,
  tag: string,
): boolean | undefined {
  const flag = optionalBoolean(value);
  const tagged = tags?.has(tag) === true;
  if (flag === false && tagged) return fail("response-rejected");
  return flag ?? (tagged ? true : undefined);
}

function capabilityEvidence(
  field: ModelCatalogField,
  value: JsonEvidenceValue | undefined,
  tags: ReadonlySet<string> | undefined,
  tag: string,
): ModelCatalogFieldEvidenceV1 {
  const flag = capabilityFlag(value, tags, tag);
  return flag === undefined ? unknown(field, "missing") : observed(field, flag);
}

function booleanEvidence(
  field: ModelCatalogField,
  value: JsonEvidenceValue | undefined,
): ModelCatalogFieldEvidenceV1 {
  const normalized = optionalBoolean(value);
  return normalized === undefined ? unknown(field, "missing") : observed(field, normalized);
}

/**
 * Derive input modalities from `supports_*` flags only when they are
 * unambiguous: chat establishes text input and `supports_vlm` image input. The
 * audio and video flags do not say whether they describe input or output, so
 * either being `true` leaves the modalities unknown.
 */
function flaggedInputModalities(
  record: Record<string, JsonEvidenceValue>,
  capabilities: Record<string, JsonEvidenceValue> | undefined,
  chat: boolean | undefined,
): string[] | undefined {
  const vision = optionalBoolean(aliasedAcross(record, capabilities, ["supports_vlm"]));
  const audio = optionalBoolean(aliasedAcross(record, capabilities, ["supports_audio"]));
  const video = optionalBoolean(aliasedAcross(record, capabilities, ["supports_video"]));
  if (chat !== true || vision === undefined || audio === true || video === true) return undefined;
  return vision ? ["image", "text"] : ["text"];
}

function optionalBoolean(value: JsonEvidenceValue | undefined): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") return fail("response-rejected");
  return value;
}

function integerEvidence(
  field: ModelCatalogField,
  value: JsonEvidenceValue | undefined,
): ModelCatalogFieldEvidenceV1 {
  if (value === undefined || value === null) return unknown(field, "missing");
  if (!Number.isSafeInteger(value) || Number(value) <= 0) return fail("response-rejected");
  return observed(field, Number(value));
}

function timestampEvidence(
  field: ModelCatalogField,
  value: JsonEvidenceValue | undefined,
): ModelCatalogFieldEvidenceV1 {
  if (value === undefined || value === null) return unknown(field, "missing");
  if (typeof value !== "string") return fail("response-rejected");
  // A well-formed timestamp without an offset names no instant; keep it unknown
  // rather than guessing a zone. Any other malformed value is still rejected.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$/u.test(value)) {
    return unknown(field, "not-authoritative");
  }
  const timestamp = normalizeTimestamp(value);
  return observed(field, timestamp);
}

function pricingEvidence(value: JsonEvidenceValue | undefined): {
  billingInterpretation: ModelCatalogFieldEvidenceV1;
  inputPrice: ModelCatalogFieldEvidenceV1;
  outputPrice: ModelCatalogFieldEvidenceV1;
  cacheReadPrice: ModelCatalogFieldEvidenceV1;
  cacheWritePrice: ModelCatalogFieldEvidenceV1;
} {
  const missing = {
    billingInterpretation: unknown("billingInterpretation", "missing"),
    inputPrice: unknown("inputPrice", "missing"),
    outputPrice: unknown("outputPrice", "missing"),
    cacheReadPrice: unknown("cacheReadPrice", "missing"),
    cacheWritePrice: unknown("cacheWritePrice", "missing"),
  };
  if (value === undefined || value === null) return missing;
  const pricing = jsonRecord(value);
  const interpretation = aliased(pricing, ["billingInterpretation", "billing_interpretation"]);
  const billing =
    interpretation === undefined
      ? unknown("billingInterpretation", "missing")
      : typeof interpretation === "string" &&
          ["authoritative-rate", "internal-chargeback", "explicitly-free"].includes(interpretation)
        ? observed("billingInterpretation", interpretation)
        : fail("response-rejected");
  const prices = {
    inputPrice: pricingField(
      pricing,
      "inputPrice",
      ["input", "inputPrice", "input_price"],
      "price_1m_input_tokens",
    ),
    outputPrice: pricingField(
      pricing,
      "outputPrice",
      ["output", "outputPrice", "output_price"],
      "price_1m_output_tokens",
    ),
    cacheReadPrice: pricingField(
      pricing,
      "cacheReadPrice",
      ["cacheRead", "cache_read", "cacheReadPrice", "cache_read_price"],
      "price_1m_cache_read_input_tokens",
    ),
    cacheWritePrice: pricingField(
      pricing,
      "cacheWritePrice",
      ["cacheWrite", "cache_write", "cacheWritePrice", "cache_write_price"],
      "price_1m_cache_write_input_tokens",
    ),
  };
  if (
    billing.state === "observed" &&
    billing.value === "explicitly-free" &&
    Object.values(prices).some(
      (evidence) =>
        evidence.state === "observed" &&
        typeof evidence.value === "object" &&
        !Array.isArray(evidence.value) &&
        evidence.value.amountMicrounits !== 0,
    )
  ) {
    fail("response-rejected");
  }
  if (billing.state !== "observed") {
    for (const [fieldName, evidence] of Object.entries(prices)) {
      if (
        evidence.state === "observed" &&
        typeof evidence.value === "object" &&
        !Array.isArray(evidence.value) &&
        evidence.value.amountMicrounits === 0
      ) {
        prices[fieldName as keyof typeof prices] = unknown(evidence.field, "not-authoritative");
      }
    }
  }
  return {
    billingInterpretation: billing,
    ...prices,
  };
}

/**
 * One price field from either the structured `{amountMicrounits, currency,
 * unit}` shape or an `inference-backend` bare `price_1m_*` rate. A bare rate
 * names its token unit in the key but no currency, so it cannot become an
 * authoritative price: it is validated and kept `unknown/not-authoritative`.
 */
function pricingField(
  pricing: Record<string, JsonEvidenceValue>,
  field: ModelCatalogField,
  structuredAliases: readonly string[],
  rateKey: string,
): ModelCatalogFieldEvidenceV1 {
  const structured = aliased(pricing, structuredAliases);
  const rate = Object.hasOwn(pricing, rateKey) ? pricing[rateKey] : undefined;
  if (structured !== undefined && rate !== undefined) return fail("response-rejected");
  if (rate === undefined) return priceEvidence(field, structured);
  if (rate === null) return unknown(field, "missing");
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) {
    return fail("response-rejected");
  }
  return unknown(field, "not-authoritative");
}

function priceEvidence(
  field: ModelCatalogField,
  value: JsonEvidenceValue | undefined,
): ModelCatalogFieldEvidenceV1 {
  if (value === undefined || value === null) return unknown(field, "missing");
  const price = jsonRecord(value);
  const amount = aliased(price, ["amountMicrounits", "amount_microunits"]);
  const currency = price.currency;
  const unit = price.unit;
  if (
    !Number.isSafeInteger(amount) ||
    Number(amount) < 0 ||
    typeof currency !== "string" ||
    !/^[A-Z]{3}$/u.test(currency) ||
    unit !== "per-million-tokens"
  ) {
    return fail("response-rejected");
  }
  return observed(field, { amountMicrounits: Number(amount), currency, unit });
}

function stringArray(
  value: JsonEvidenceValue | undefined,
  allowed: readonly string[],
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > allowed.length ||
    value.some((item) => typeof item !== "string" || !allowed.includes(item))
  ) {
    return fail("response-rejected");
  }
  const output = [...new Set(value as string[])].sort();
  if (output.length !== value.length) return fail("response-rejected");
  return output;
}

function aliasedAcross(
  root: Record<string, JsonEvidenceValue>,
  nested: Record<string, JsonEvidenceValue> | undefined,
  aliases: readonly string[],
): JsonEvidenceValue | undefined {
  const outer = aliased(root, aliases);
  const inner = nested ? aliased(nested, aliases) : undefined;
  if (outer !== undefined && inner !== undefined) fail("response-rejected");
  return outer ?? inner;
}

function aliased(
  root: Record<string, JsonEvidenceValue>,
  aliases: readonly string[],
): JsonEvidenceValue | undefined {
  const present = aliases.filter((key) => Object.hasOwn(root, key));
  if (present.length > 1) fail("response-rejected");
  return present.length === 1 ? root[present[0]!] : undefined;
}

function optionalRecord(
  value: JsonEvidenceValue | undefined,
): Record<string, JsonEvidenceValue> | undefined {
  return value === undefined || value === null ? undefined : jsonRecord(value);
}

function jsonRecord(value: JsonEvidenceValue): Record<string, JsonEvidenceValue> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail("response-rejected");
  return value;
}

function validateEndpoint(input: InferenceHubMetadataEndpoint): InferenceHubMetadataEndpoint {
  try {
    const url = new URL(input.origin);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.origin !== input.origin ||
      !PATH_PATTERN.test(input.path) ||
      input.path.includes("//") ||
      input.path
        .split("/")
        .some((segment) => segment === "." || segment === ".." || segment.includes("%")) ||
      !["browse", "search", "slim"].includes(input.mode) ||
      (input.labelParameter !== undefined &&
        !(INFERENCE_HUB_METADATA_LABEL_PARAMETERS as readonly string[]).includes(
          input.labelParameter,
        ))
    ) {
      fail("invalid-configuration");
    }
    const endpoint = new URL(input.path, input.origin);
    if (endpoint.origin !== input.origin || endpoint.pathname !== input.path)
      fail("invalid-configuration");
    return { ...input };
  } catch (error) {
    if (error instanceof InferenceHubMetadataError) throw error;
    return fail("invalid-configuration");
  }
}

function validateLimits(input: InferenceHubMetadataLimits | undefined): ValidatedLimits {
  const values = { ...DEFAULT_LIMITS, ...input };
  const caps: Record<keyof ValidatedLimits, number> = {
    timeoutMs: 30_000,
    maxResponseBytes: 4 * 1024 * 1024,
    maxResponseChunks: 16_384,
    maxPages: 16,
    maxItemsPerPage: 256,
    maxItems: 1_024,
    maxCursorBytes: 1_024,
    maxJsonDepth: 64,
    maxJsonNodes: 100_000,
    maxStringBytes: 65_536,
  };
  for (const key of Object.keys(caps) as Array<keyof ValidatedLimits>) {
    if (!Number.isSafeInteger(values[key]) || values[key] <= 0 || values[key] > caps[key]) {
      fail("invalid-configuration");
    }
  }
  if (values.maxItems < values.maxItemsPerPage) fail("invalid-configuration");
  return values;
}

function readMetadataCredential(environment: NodeJS.ProcessEnv): string | null {
  let value: unknown;
  try {
    value = environment.INFERENCE_HUB_METADATA_API_KEY;
  } catch {
    return fail("invalid-metadata-credential");
  }
  if (value === undefined || value === "") return null;
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    !METADATA_KEY_PATTERN.test(value) ||
    containsInferenceCredential(value) ||
    !containsMetadataCredential(value)
  ) {
    fail("invalid-metadata-credential");
  }
  return value;
}

function validateCursor(cursor: string, limits: ValidatedLimits): void {
  if (
    Buffer.byteLength(cursor, "utf8") > limits.maxCursorBytes ||
    /[\u0000-\u001f\u007f]/u.test(cursor) ||
    detectCredentialRuleIds(cursor).length > 0
  ) {
    fail("pagination-rejected");
  }
}

function validateJsonBudget(value: JsonEvidenceValue, limits: ValidatedLimits): void {
  const state = { nodes: 0 };
  const visit = (candidate: JsonEvidenceValue, depth: number): void => {
    state.nodes += 1;
    if (depth > limits.maxJsonDepth || state.nodes > limits.maxJsonNodes) fail("response-rejected");
    if (typeof candidate === "string") {
      if (Buffer.byteLength(candidate, "utf8") > limits.maxStringBytes) fail("response-rejected");
      return;
    }
    if (candidate === null || typeof candidate === "boolean" || typeof candidate === "number")
      return;
    if (Array.isArray(candidate)) {
      if (candidate.length > limits.maxItems) fail("response-rejected");
      for (const item of candidate) visit(item, depth + 1);
      return;
    }
    const entries = Object.entries(candidate);
    if (entries.length > 256) fail("response-rejected");
    for (const [key, item] of entries) {
      if (Buffer.byteLength(key, "utf8") > 256) fail("response-rejected");
      visit(item, depth + 1);
    }
  };
  visit(value, 0);
}

function validatePurpose(value: ModelProfilePurpose): ModelProfilePurpose {
  return value === "policy" || value === "judge" ? value : fail("invalid-configuration");
}

function validateAuthority(value: InferenceHubMetadataAuthority): InferenceHubMetadataAuthority {
  return value === "authenticated" || value === "public-preview"
    ? value
    : fail("invalid-configuration");
}

function validateLabel(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/u.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    detectCredentialRuleIds(value).length > 0
  ) {
    return fail("invalid-configuration");
  }
  return value;
}

function validateIdentifier(value: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/u.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    detectCredentialRuleIds(value).length > 0
  ) {
    return fail("response-rejected");
  }
  return value;
}

function normalizedNow(clock: () => Date): string {
  try {
    const value = clock();
    if (!(value instanceof Date) || !Number.isFinite(value.valueOf()))
      fail("invalid-configuration");
    return value.toISOString();
  } catch (error) {
    if (error instanceof InferenceHubMetadataError) throw error;
    return fail("invalid-configuration");
  }
}

function normalizeTimestamp(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value)) {
    return fail("response-rejected");
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.valueOf())) return fail("response-rejected");
  return timestamp.toISOString();
}

function fail(code: InferenceHubMetadataErrorCode): never {
  throw new InferenceHubMetadataError(code);
}
