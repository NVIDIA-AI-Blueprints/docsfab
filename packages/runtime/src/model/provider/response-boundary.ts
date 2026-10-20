// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  CredentialBoundaryError,
  assertModelResponseCredentialFree,
} from "../../security/credential-isolation.js";
import type { ProviderResponseObservationV1 } from "../../records/contracts.js";
import { createHash } from "node:crypto";
import type { ProviderTransport } from "../configuration.js";
import { isProviderErrorEnvelope } from "../provider-stream-error.js";
import { readProviderResponsePayloads } from "../provider-response-payloads.js";
import { ProviderBoundaryRefusalError, ProviderResponseLimitError } from "./errors.js";

/** A response that named a model other than the requested one. */
export interface ServedModelObservation {
  readonly expectedModel: string;
  readonly servedModels: readonly string[];
}

export async function validateProviderResponseModel(
  response: Response,
  expectedModel: string,
  transport: ProviderTransport,
  forbiddenCredential?: string,
  onServedModel?: (observation: ServedModelObservation) => void,
): Promise<Response> {
  // Reading the body stays outside the refusal boundary below: a body that dies
  // mid-transfer is a transport fault, and nothing has reached Pi yet, so the
  // request is safe to replay. Wrapping it as a refusal would veto that replay.
  // The size limit stays a refusal through its own error type.
  const bytes = await response.arrayBuffer();
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    assertModelResponseCredentialFree(text);
    if (forbiddenCredential && text.includes(forbiddenCredential)) {
      throw new CredentialBoundaryError("model-response");
    }
  } catch (error) {
    if (error instanceof CredentialBoundaryError) throw error;
    throw new ProviderBoundaryRefusalError(
      "Provider response rejected before model identity could be verified safely.",
    );
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  if (!response.ok) {
    return new Response(bytes, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  const body = readProviderResponsePayloads(text);
  // A stream of only structured provider error events carries no model output
  // whose identity could be checked. Like a non-2xx body, it goes to the
  // transport, whose stream-error observer classifies the declared fault. Data
  // after `[DONE]`, which the consumer ignores, keeps the identity check.
  if (
    body?.stream &&
    !body.dataAfterDone &&
    body.payloads.length > 0 &&
    body.payloads.every(isProviderErrorEnvelope)
  ) {
    return new Response(bytes, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  // A body this reader cannot read, or one that names no model, leaves the
  // served model unknown, and another reader may still deliver its payloads:
  // its identity cannot be recorded truthfully, so it stays refused.
  const models = body === undefined ? [] : providerResponseModels(body.payloads, transport);
  if (models.length === 0) {
    throw new ProviderBoundaryRefusalError(
      "Provider response rejected because observed model identity did not match.",
    );
  }
  if (models.some((model) => model !== expectedModel)) {
    // Recorded and warned, never refused: a gateway may rename the model.
    onServedModel?.({ expectedModel, servedModels: models });
  }
  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function providerResponseModels(
  payloads: readonly unknown[],
  transport: ProviderTransport,
): string[] {
  const models = new Set<string>();
  for (const payload of payloads) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    const root = payload as Record<string, unknown>;
    const candidates = [
      root.model,
      transport === "openai-responses" && root.response && typeof root.response === "object"
        ? (root.response as Record<string, unknown>).model
        : undefined,
      transport === "anthropic-messages" && root.message && typeof root.message === "object"
        ? (root.message as Record<string, unknown>).model
        : undefined,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.length > 0) models.add(candidate);
    }
  }
  return [...models].sort();
}

/** Observe the raw provider stream while preserving the existing optional size refusal. */
export function observeProviderResponse(
  response: Response,
  maxResponseBytes: number | undefined,
  onResponseLimit: ((error: ProviderResponseLimitError) => void) | undefined,
  requestSequence: number,
  onFirstBodyByte?: () => void,
  onObservation?: (observation: ProviderResponseObservationV1) => void,
  captureDigest = false,
): Response {
  if (
    maxResponseBytes === undefined &&
    onFirstBodyByte === undefined &&
    onObservation === undefined &&
    !captureDigest
  ) {
    return response;
  }
  if (
    maxResponseBytes !== undefined &&
    (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1)
  ) {
    throw new Error("Provider response byte limit must be a positive integer.");
  }
  let settled = false;
  const bodyDigest = captureDigest ? createHash("sha256") : null;
  const settle = (
    disposition: ProviderResponseObservationV1["disposition"],
    observedBytes: number,
    httpStatus?: number,
  ): void => {
    if (settled) return;
    settled = true;
    onObservation?.({
      requestSequence,
      disposition,
      observedBytes,
      ...(httpStatus === undefined ? {} : { httpStatus }),
      ...(bodyDigest === null || disposition === "no-body"
        ? {}
        : { bodySha256: bodyDigest.digest("hex") }),
    });
  };
  const status = response.status;
  if (maxResponseBytes !== undefined) {
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null) {
      if (!/^\d+$/u.test(contentLength)) {
        void response.body?.cancel().catch(() => undefined);
        settle(response.body === null ? "no-body" : "cancelled", 0, status);
        throw new ProviderBoundaryRefusalError(
          "Provider response rejected because its Content-Length header was malformed.",
        );
      }
      if (Number(contentLength) > maxResponseBytes) {
        void response.body?.cancel().catch(() => undefined);
        const failure = new ProviderResponseLimitError(maxResponseBytes);
        settle("limit-refused", 0, status);
        onResponseLimit?.(failure);
        throw failure;
      }
    }
  }
  if (!response.body) {
    settle("no-body", 0, status);
    return response;
  }

  const reader = response.body.getReader();
  let observedBytes = 0;
  let seenFirstByte = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          settle("complete", observedBytes, status);
          controller.close();
          return;
        }
        observedBytes += chunk.value.byteLength;
        bodyDigest?.update(chunk.value);
        if (!seenFirstByte && chunk.value.byteLength > 0) {
          seenFirstByte = true;
          onFirstBodyByte?.();
        }
        if (maxResponseBytes !== undefined && observedBytes > maxResponseBytes) {
          const failure = new ProviderResponseLimitError(maxResponseBytes);
          settle("limit-refused", observedBytes, status);
          onResponseLimit?.(failure);
          void reader.cancel(failure).catch(() => undefined);
          controller.error(failure);
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        settle("read-error", observedBytes, status);
        controller.error(error);
      }
    },
    cancel(reason) {
      settle("cancelled", observedBytes, status);
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
