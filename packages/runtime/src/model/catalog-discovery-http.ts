// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import { OutboundProxyRefusal, outboundFetch } from "./outbound-http-policy.js";
import { createProviderBoundaryFetch } from "./provider.js";

export const DIRECT_PROVIDER_CATALOG_MAX_BYTES = 1024 * 1024;
export const DIRECT_PROVIDER_CATALOG_TIMEOUT_MS = 5_000;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 50_000;
const MAX_JSON_OBJECT_FIELDS = 64;
const MAX_JSON_STRING_BYTES = 64 * 1024;
const MAX_RESPONSE_CHUNKS = 16_384;
const REDIRECT_BOUNDARY_MESSAGE = "Provider response rejected because redirects are not allowed.";

export type DirectProviderCatalogFailureCode =
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

export async function retrieveDirectProviderCatalogJson(input: {
  url: string;
  headers: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  clock?: () => Date;
  fail: CatalogFail;
  notFoundCode?: DirectProviderCatalogFailureCode;
}): Promise<{ body: Record<string, JsonEvidenceValue>; retrievedAt: string }> {
  const fail = input.fail;
  const delegate = input.fetch ?? outboundFetch();
  const clock = input.clock;
  if (typeof delegate !== "function" || (clock !== undefined && typeof clock !== "function")) {
    return fail("invalid-configuration");
  }
  try {
    return await withEndToEndTimeout(
      fail,
      async (signal, registerLateBody, registerActiveReader) => {
        const boundaryFetch = createProviderBoundaryFetch(input.url, input.fetch);
        const response = await boundaryFetch(input.url, {
          method: "GET",
          headers: input.headers,
          redirect: "manual",
          signal,
        });
        registerLateBody(response);
        validateResponseEnvelope(response, input.url, fail, input.notFoundCode ?? "model-absent");
        const bytes = await readBoundedBody(response, signal, registerActiveReader, fail);
        const retrievedAt = readClock(clock, fail).toISOString();
        return { body: parseObjectBody(bytes, fail), retrievedAt };
      },
    );
  } catch (error) {
    if (isCatalogFailure(error, fail)) throw error;
    // A local proxy refusal sent nothing; it keeps its own code and next action.
    if (error instanceof OutboundProxyRefusal) throw error;
    if (error instanceof Error && error.message === REDIRECT_BOUNDARY_MESSAGE) {
      return fail("redirected-response");
    }
    return fail("network-failure");
  }
}

export function plainRecord(value: JsonEvidenceValue): value is Record<string, JsonEvidenceValue> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function safeCatalogIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/u.test(value) &&
    !value.includes("..") &&
    !value.includes("//")
  );
}

export function optionalPositiveInteger(
  model: Record<string, JsonEvidenceValue>,
  name: string,
  fail: (code: DirectProviderCatalogFailureCode) => never,
): number | undefined {
  const value = model[name];
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) <= 0) fail("malformed-response");
  return value as number;
}

export function optionalTimestamp(
  model: Record<string, JsonEvidenceValue>,
  name: string,
  fail: (code: DirectProviderCatalogFailureCode) => never,
): string | undefined {
  const value = model[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) fail("malformed-response");
    const iso = new Date(value * 1000).toISOString();
    if (!Number.isFinite(Date.parse(iso))) fail("malformed-response");
    return iso;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    fail("malformed-response");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail("malformed-response");
  return new Date(parsed).toISOString();
}

function parseObjectBody(body: Uint8Array, fail: CatalogFail): Record<string, JsonEvidenceValue> {
  let parsed: JsonEvidenceValue;
  try {
    parsed = parseJsonEvidence(body);
    assertBoundedJson(parsed, fail);
  } catch (error) {
    if (isCatalogFailure(error, fail)) throw error;
    return fail("malformed-response");
  }
  if (!plainRecord(parsed)) fail("malformed-response");
  return parsed;
}

function validateResponseEnvelope(
  response: Response,
  expectedUrl: string,
  fail: (code: DirectProviderCatalogFailureCode) => never,
  notFoundCode: DirectProviderCatalogFailureCode,
): void {
  if (response.redirected) rejectResponse(response, "redirected-response", fail);
  if (response.url !== expectedUrl) rejectResponse(response, "cross-origin-response", fail);
  if (response.status === 404) rejectResponse(response, notFoundCode, fail);
  if (response.status !== 200) rejectResponse(response, "http-status", fail);
  const contentType = response.headers.get("content-type");
  if (!contentType || !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    rejectResponse(response, "malformed-response", fail);
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/u.test(contentLength)) {
      rejectResponse(response, "malformed-response", fail);
    }
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length)) rejectResponse(response, "malformed-response", fail);
    if (length > DIRECT_PROVIDER_CATALOG_MAX_BYTES) {
      rejectResponse(response, "oversized-response", fail);
    }
  }
}

function rejectResponse(
  response: Response,
  code: DirectProviderCatalogFailureCode,
  fail: (code: DirectProviderCatalogFailureCode) => never,
): never {
  void safeCancelBody(response);
  return fail(code);
}

async function readBoundedBody(
  response: Response,
  signal: AbortSignal,
  registerActiveReader: (reader: ReadableStreamDefaultReader<Uint8Array> | undefined) => void,
  fail: CatalogFail,
): Promise<Uint8Array> {
  if (!response.body) fail("malformed-response");
  const reader = response.body.getReader();
  registerActiveReader(reader);
  const chunks: Uint8Array[] = [];
  let length = 0;
  let chunkCount = 0;
  let rejectAborted: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = () => reject(fail.timeoutError());
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
      if (length > DIRECT_PROVIDER_CATALOG_MAX_BYTES) {
        startReaderCancellation(reader);
        fail("oversized-response");
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (isCatalogFailure(error, fail)) throw error;
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

function assertBoundedJson(
  value: JsonEvidenceValue,
  fail: (code: DirectProviderCatalogFailureCode) => never,
  depth = 0,
  budget = { nodes: 0 },
): void {
  budget.nodes += 1;
  if (depth > MAX_JSON_DEPTH || budget.nodes > MAX_JSON_NODES) fail("malformed-response");
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_JSON_STRING_BYTES) fail("malformed-response");
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    if (value.length > 10_000) fail("malformed-response");
    for (const item of value) assertBoundedJson(item, fail, depth + 1, budget);
    return;
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_JSON_OBJECT_FIELDS) fail("malformed-response");
  for (const [key, item] of entries) {
    if (Buffer.byteLength(key, "utf8") > 256) fail("malformed-response");
    assertBoundedJson(item, fail, depth + 1, budget);
  }
}

function readClock(clock: (() => Date) | undefined, fail: CatalogFail): Date {
  try {
    const value = (clock ?? (() => new Date()))();
    if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
      fail("invalid-configuration");
    }
    return value;
  } catch (error) {
    if (isCatalogFailure(error, fail)) throw error;
    return fail("invalid-configuration");
  }
}

async function withEndToEndTimeout<T>(
  fail: CatalogFail,
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
      reject(fail.timeoutError());
    }, DIRECT_PROVIDER_CATALOG_TIMEOUT_MS);
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
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // Cleanup cannot replace the stable discovery diagnostic.
  }
}

function isCatalogFailure(error: unknown, fail: CatalogFail): boolean {
  return error instanceof Error && error.name === fail.errorName;
}

export type CatalogFail = ((code: DirectProviderCatalogFailureCode) => never) & {
  errorName: string;
  timeoutError: () => Error;
};

export function catalogFail(
  ErrorType: new (code: DirectProviderCatalogFailureCode) => Error,
): CatalogFail {
  const fail = ((code: DirectProviderCatalogFailureCode) => {
    throw new ErrorType(code);
  }) as CatalogFail;
  fail.errorName = new ErrorType("invalid-configuration").name;
  fail.timeoutError = () => new ErrorType("timeout");
  return fail;
}
