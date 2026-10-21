// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Normalize a provider turn's stop metadata and error onto the closed
 * per-attempt telemetry sets, combining Pi's mapped `stopReason`, the raw
 * `rawStopReason`, the flattened `errorMessage`, and what the transport wrapper
 * in `provider.ts` observed: the HTTP status, `Retry-After`, and any structured
 * error event inside a 2xx stream.
 *
 * Nothing is retained verbatim: raw tokens and error text are read only to
 * choose a member of a closed set. An unrecognized value becomes `unknown`.
 */
import { grantedTurnOutputTokens } from "./context-budget.js";
import type {
  InferenceAttemptModelTelemetryV1,
  InferenceTurnEvidence,
  ModelFinishReason,
  ProviderErrorClass,
  ProviderErrorTelemetryV1,
} from "../records/contracts.js";
import {
  isHttpStatus,
  MODEL_TELEMETRY_SCHEMA_VERSION,
  RAW_MODEL_FINISH_REASONS,
} from "../records/model-telemetry.js";

/**
 * What the transport wrapper saw of the most recent physical provider request.
 * Reset to `sent: false` before any DocsFab guard can refuse, and set only by
 * the transport `fetch` (any response, or a failure other than a typed boundary
 * refusal), so a turn DocsFab refused before sending always reads `sent: false`.
 */
export interface ProviderExchangeObservation {
  /** The request left the host and reached, or failed on the way to, the provider. */
  readonly sent: boolean;
  /** Status of a non-2xx response, when one arrived. */
  readonly httpStatus?: number;
  /** That response's `Retry-After`, in milliseconds, when it sent a usable one. */
  readonly retryAfterMs?: number;
  /** The structured error event a 2xx stream carried, when one arrived. */
  readonly streamError?: ProviderStreamErrorObservation;
  /**
   * A 2xx chat-completions stream reached a clean end of body with no `[DONE]`
   * event and no structured error event. Set only on that transport, whose
   * streams always end with `[DONE]`.
   */
  readonly streamClosedBeforeDone?: true;
  /** A byte of the 2xx response body arrived, so the provider had started answering. */
  readonly bodyReceived?: true;
  /**
   * The request never connected: the endpoint refused it, its host name did
   * not resolve, or no route reached it (`endpoint-connect-failure.ts`). Set
   * only on a send with no response.
   */
  readonly connectFailed?: true;
}

/**
 * The closed facts of a structured error event inside a 2xx stream (see
 * `provider-stream-error.ts`). The transport status was a success, so these are
 * the provider's own declaration, kept apart from `httpStatus`.
 */
export interface ProviderStreamErrorObservation {
  /** The failing HTTP status the event's integer `error.code` declared. */
  readonly status?: number;
  /** The event's `error.type` is a known provider server-fault type. */
  readonly serverFault: boolean;
}

/** Pi's own closed `StopReason`, for a transport that preserved no raw token. */
const PI_FINISH_REASONS: ReadonlyMap<string, ModelFinishReason> = new Map([
  ["stop", "stop"],
  ["length", "length"],
  ["toolUse", "tool-use"],
  ["error", "error"],
  ["aborted", "aborted"],
]);

/**
 * The closed finish reason of one landed provider turn. The raw token wins when
 * preserved because it is more specific (Pi maps `content_filter` to `error`);
 * an unrecognized raw token is `unknown` rather than Pi's guess. Without one,
 * Pi's stop reason decides.
 */
export function normalizeModelFinishReason(
  stopReason: unknown,
  rawStopReason: unknown,
): ModelFinishReason {
  const raw = typeof rawStopReason === "string" ? rawStopReason.trim().toLowerCase() : "";
  if (raw) return RAW_MODEL_FINISH_REASONS.get(raw) ?? "unknown";
  return typeof stopReason === "string"
    ? (PI_FINISH_REASONS.get(stopReason) ?? "unknown")
    : "unknown";
}

const CONTENT_FILTER_TEXT =
  /\bcontent[ _-]?(?:filter|management|policy)|responsible\s*ai|\brefusal\b|safety system/iu;
const RATE_LIMIT_TEXT = /\brate[ _-]?limit|too many requests|quota exceeded/iu;
const AUTH_TEXT =
  /\bunauthori[sz]ed|forbidden|authenticat|invalid[ _-]?api[ _-]?key|permission denied/iu;
const TIMEOUT_TEXT = /\btime[ _-]?d? ?out|ETIMEDOUT|deadline exceeded/iu;
const NETWORK_TEXT =
  /\bnetwork|connection|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|terminated/iu;

function failingStatusClass(status: number | undefined): ProviderErrorClass | undefined {
  if (status === undefined || !isHttpStatus(status)) return undefined;
  if (status === 429) return "rate-limit";
  if (status === 401 || status === 403 || status === 407) return "auth";
  if (status === 408 || status === 504) return "timeout";
  if (status >= 500) return "server";
  if (status >= 400) return "invalid-request";
  return undefined;
}

/**
 * The closed class of one provider error.
 *
 * Content-filter is checked first because several front doors send it as an
 * ordinary 400. Otherwise a transport error status decides, then a structured
 * in-stream error event's declared status or server-fault type, then a 2xx
 * stream that closed before it finished (`streamIncomplete`), then a send that
 * never connected (`connectFailed`), and the message is read only when none
 * does (a stream cut, a reset). Message text never leaves this function.
 */
export function classifyProviderError(input: {
  readonly httpStatus?: number;
  readonly streamError?: ProviderStreamErrorObservation;
  readonly streamIncomplete?: boolean;
  /** The transport saw a definitive connect failure and no response. */
  readonly connectFailed?: boolean;
  readonly message?: string;
  readonly finishReason?: ModelFinishReason;
}): ProviderErrorClass {
  const message = input.message ?? "";
  if (input.finishReason === "content-filter" || CONTENT_FILTER_TEXT.test(message)) {
    return "content-filter";
  }
  const answered =
    failingStatusClass(input.httpStatus) ?? failingStatusClass(input.streamError?.status);
  if (answered) return answered;
  if (input.streamError?.serverFault) return "server";
  if (input.streamIncomplete && input.httpStatus === undefined && !input.streamError) {
    return "stream-incomplete";
  }
  if (input.connectFailed && input.httpStatus === undefined && !input.streamError) {
    return "unreachable";
  }
  if (RATE_LIMIT_TEXT.test(message)) return "rate-limit";
  if (AUTH_TEXT.test(message)) return "auth";
  if (TIMEOUT_TEXT.test(message)) return "timeout";
  if (NETWORK_TEXT.test(message)) return "network";
  return "unknown";
}

/** The telemetry one landed provider turn contributes to its attempt. */
export interface LandedProviderTurnTelemetry {
  readonly finishReason: ModelFinishReason;
  readonly providerError?: ProviderErrorTelemetryV1;
}

/**
 * Read one landed assistant message.
 *
 * A provider error is recorded only for a turn Pi ended with `stopReason:
 * "error"` whose last physical request was actually sent. DocsFab's own
 * refusals end a turn the same way but never send, so they carry none.
 * `httpStatus` is the one the transport received; `streamErrorStatus` is the
 * integer code a structured error event inside a 2xx stream declared. Neither
 * is ever parsed out of text. A turn with no raw finish token whose 2xx stream
 * closed before `[DONE]` is `stream-incomplete`; a raw token means the provider
 * finished the turn, so its error is not the missing end.
 */
export function observeLandedProviderTurn(
  message: object,
  exchange?: ProviderExchangeObservation,
): LandedProviderTurnTelemetry {
  const item = message as { stopReason?: unknown; rawStopReason?: unknown; errorMessage?: unknown };
  const finishReason = normalizeModelFinishReason(item.stopReason, item.rawStopReason);
  if (item.stopReason !== "error" || exchange?.sent !== true) return { finishReason };
  const errorMessage = typeof item.errorMessage === "string" ? item.errorMessage : "";
  const httpStatus = isHttpStatus(exchange.httpStatus) ? exchange.httpStatus : undefined;
  const streamError = httpStatus === undefined ? exchange.streamError : undefined;
  const streamIncomplete =
    exchange.streamClosedBeforeDone === true &&
    !(typeof item.rawStopReason === "string" && item.rawStopReason.trim() !== "");
  const declaredStatus = streamError?.status;
  const streamErrorStatus = isHttpStatus(declaredStatus) ? declaredStatus : undefined;
  // A `Retry-After` is kept only with the status of the response that carried
  // it; the record validators refuse one without it.
  const retryAfterMs =
    httpStatus !== undefined &&
    typeof exchange.retryAfterMs === "number" &&
    Number.isSafeInteger(exchange.retryAfterMs) &&
    exchange.retryAfterMs >= 0
      ? exchange.retryAfterMs
      : undefined;
  return {
    finishReason,
    providerError: {
      class: classifyProviderError({
        httpStatus,
        ...(streamError === undefined ? {} : { streamError }),
        streamIncomplete,
        connectFailed: exchange.connectFailed === true,
        message: errorMessage,
        finishReason,
      }),
      ...(httpStatus === undefined ? {} : { httpStatus }),
      ...(streamErrorStatus === undefined ? {} : { streamErrorStatus }),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    },
  };
}

/**
 * Assemble an attempt's telemetry block. `landedTurn` is the ledger entry the
 * last landed turn settled, not merely the last sent entry (which Pi may have
 * aborted before it landed), so the output figures describe the turn whose
 * finish reason is recorded. With no landed turn only latency is reported.
 */
export function buildAttemptModelTelemetry(input: {
  readonly lastLanded?: LandedProviderTurnTelemetry;
  readonly landedTurn?: InferenceTurnEvidence;
  readonly providerLatencyMs: number;
}): InferenceAttemptModelTelemetryV1 {
  const { lastLanded, landedTurn } = input;
  const outputTokens = lastLanded ? landedTurn?.outputTokens : undefined;
  const outputAllowance =
    lastLanded && landedTurn ? grantedTurnOutputTokens(landedTurn) : undefined;
  const latency = Math.round(input.providerLatencyMs);
  return {
    schemaVersion: MODEL_TELEMETRY_SCHEMA_VERSION,
    ...(lastLanded ? { finishReason: lastLanded.finishReason } : {}),
    ...(outputTokens !== undefined && Number.isSafeInteger(outputTokens) && outputTokens >= 0
      ? { outputTokens }
      : {}),
    ...(outputAllowance !== undefined &&
    Number.isSafeInteger(outputAllowance) &&
    outputAllowance > 0
      ? { outputAllowance }
      : {}),
    providerLatencyMs: Number.isSafeInteger(latency) && latency > 0 ? latency : 0,
    ...(lastLanded?.providerError ? { providerError: { ...lastLanded.providerError } } : {}),
  };
}
