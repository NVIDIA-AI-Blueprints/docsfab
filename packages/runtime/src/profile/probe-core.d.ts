// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ReleasedModelCredential } from "../security/model-credential-release.js";

export interface ProbeProvider {
  readonly baseUrl: string;
  /** The model key, released for this provider's endpoint. */
  readonly credential: ReleasedModelCredential;
}

/** Closed class of a request that ended without an HTTP response. */
export type TransportErrorClass = "timeout" | "byte-bound" | "reset" | "other";

/** Why and when a request ended without an HTTP response; never the error's message. */
export interface TransportFailure {
  readonly class: TransportErrorClass;
  readonly errorName: string;
  readonly elapsedMs: number;
  /** Response bytes received before the failure. */
  readonly streamedBytes: number;
}

export function transportErrorClass(error: unknown, timedOut: boolean): TransportErrorClass;

export type ChatCompletionResult =
  | {
      readonly ok: false;
      readonly status: number;
      readonly body: string;
      readonly bodyTruncated?: boolean;
      /** Number of response-body bytes observed by the transport. */
      readonly responseBytes: number;
      /** Safe presence/source/hash metadata; raw request identifiers are not returned. */
      readonly requestIdentifier: ProbeRequestIdentifier;
      /** Present only with status 0. */
      readonly transport?: TransportFailure;
    }
  | { readonly ok: true; readonly status: number; readonly json: unknown }
  | {
      readonly ok: true;
      readonly status: number;
      readonly contentType: string;
      readonly responseBytes: number;
      /** Safe presence/source/hash metadata; raw request identifiers are not returned. */
      readonly requestIdentifier: ProbeRequestIdentifier;
      readonly text: string;
    };

export function providerErrorMessage(body: string): string;

export function redactProviderText(
  text: string,
  apiKey: string | undefined,
  echoMinChars: number,
): string;

export function boundedErrorBody(
  text: string,
  apiKey: string,
  maxChars: number,
  echoMinChars: number,
): { body: string; bodyTruncated: boolean };

export function postChatCompletion(input: {
  readonly baseUrl: string;
  /** The model key, released for `baseUrl`; read only for this request's origin. */
  readonly credential: ReleasedModelCredential;
  readonly body: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
  readonly errorBodyMaxChars: number;
  /** `endpointProbe.credentialEchoMinChars`: shortest credential run removed from provider text. */
  readonly credentialEchoMinChars: number;
  readonly stream?: boolean;
  /** The caller's network boundary; defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Clock for `transport.elapsedMs`; `Date.now` by default. */
  readonly now?: () => number;
}): Promise<ChatCompletionResult>;

export interface ReasoningProbeOptions {
  readonly timeoutMs: number;
  readonly errorBodyMaxChars: number;
  readonly credentialEchoMinChars: number;
  readonly sampleMaxTokens: number;
  readonly tokenField?: ProbeTokenField;
  readonly fetch?: typeof globalThis.fetch;
}

export interface ReasoningProbeSample {
  readonly reachable: boolean;
  readonly status?: number;
  readonly error?: string;
  readonly errorTruncated?: boolean;
  readonly reasoningSplit?: boolean;
  readonly reasoningPresent?: boolean;
  readonly contentPopulated?: boolean;
}

export type ReasoningProbeVerdict =
  | "harness-compatible"
  | "reasoning-split-controllable"
  | "reasoning-split-uncontrolled"
  | "unreachable";

export const DEFAULT_PROMPTS: readonly string[];

export function shapeOf(json: unknown): {
  contentPopulated: boolean;
  reasoningPresent: boolean;
  keys: string[];
  reasoningSplit: boolean;
};

export function probeOnce(
  model: string,
  provider: ProbeProvider,
  promptText: string,
  extraBody: Record<string, unknown>,
  options: ReasoningProbeOptions,
): Promise<ReasoningProbeSample>;

export function probeOne(
  model: string,
  provider: ProbeProvider,
  extraBody: Record<string, unknown>,
  prompts: readonly string[],
  options: ReasoningProbeOptions,
): Promise<ReasoningProbeSample>;

export function decideVerdict(
  plain: ReasoningProbeSample,
  noThink: ReasoningProbeSample | null,
): ReasoningProbeVerdict;

export const COMPATIBILITY_TOOL_NAME: "record_probe_result";
export const COMPATIBILITY_TOOL_PROMPT: string;
export const COMPATIBILITY_JSON_PROMPT: string;

export type ProbeTokenField = "max_tokens" | "max_completion_tokens";

export interface ProbeRequestShape {
  readonly tokenField?: ProbeTokenField;
  readonly systemRole?: "system" | "developer";
  /** Send `store: false`, as the provider SDK does on standard OpenAI endpoints. */
  readonly store?: boolean;
}

export function compatibilityRequestBodies(
  model: string,
  options: ProbeRequestShape & { readonly maxTokens: number; readonly systemPrompt: string },
): {
  toolCall: Record<string, unknown>;
  structuredOutput: Record<string, unknown>;
};

export interface StreamErrorEvent {
  readonly message: string;
  readonly type: string;
  readonly code: number | null;
}

export interface CompletionTurn {
  readonly events: number;
  readonly done: boolean;
  readonly malformedEvents: number;
  readonly errorEvent: StreamErrorEvent | undefined;
  /** In memory only; callers never copy it into an observation. */
  readonly content: string;
  readonly reasoningPresent: boolean;
  readonly toolCalls: readonly { readonly name: string; readonly arguments: string }[];
  /** Content-free SSE assembly counters; production response bytes use the shared canonical bound. */
  readonly streamObservation?: ProbeStreamObservation;
  readonly finishReason: string | null;
  readonly completionTokens: number | null;
}

/** Structural metadata only: never includes tool arguments, tool IDs, prompts, or provider text. */
export interface ProbeStreamObservation {
  readonly streamClass:
    | "empty"
    | "provider-error-event"
    | "malformed-event"
    | "done-with-finish"
    | "done-without-finish"
    | "finish-without-done"
    | "events-without-terminal"
    | "non-sse-response"
    | "unparsed-response";
  readonly eventCount: number;
  readonly malformedEventCount: number;
  readonly doneMarkerPresent: boolean;
  readonly toolCallDeltaCount: number;
  readonly callStartCount: number;
  readonly indexedDeltaCount: number;
  readonly indexlessDeltaCount: number;
  readonly distinctIndexCount: number;
  readonly lowestIndex: number | null;
  readonly highestIndex: number | null;
  readonly duplicateIndexDeltaCount: number;
  readonly identifiedDeltaCount: number;
  readonly unidentifiedDeltaCount: number;
  readonly distinctCallIdCount: number;
  readonly duplicateCallIdDeltaCount: number;
  readonly assembledCallCount: number;
}

export interface ProbeRequestIdentifier {
  readonly present: boolean;
  readonly source: "x-request-id" | "request-id" | null;
  /** SHA-256 of the header value; raw identifiers are never returned. */
  readonly sha256: string | null;
}

export function parseChatCompletionStream(text: string): CompletionTurn;

export type CompatibilityTurn =
  | {
      readonly ok: false;
      readonly status: number;
      readonly body: string;
      readonly bodyTruncated: boolean;
      readonly responseBytes?: number;
      readonly requestIdentifier?: ProbeRequestIdentifier;
      readonly streamClass?: "transport-error" | "http-error";
      /** Present only with status 0. */
      readonly transport?: TransportFailure;
    }
  | (CompletionTurn & {
      readonly ok: true;
      readonly status: number;
      readonly eventStream: boolean;
      readonly responseBytes?: number;
      readonly requestIdentifier?: ProbeRequestIdentifier;
    });

export interface CompatibilityProbeOptions extends ProbeRequestShape {
  readonly fetch?: typeof globalThis.fetch;
  readonly maxTokens: number;
  readonly systemPrompt: string;
  readonly timeoutMs: number;
  readonly errorBodyMaxChars: number;
  readonly credentialEchoMinChars: number;
  readonly extraBody?: Record<string, unknown>;
  readonly finalizeBody?: (body: Record<string, unknown>) => Record<string, unknown>;
}

export interface CompatibilityProbeObservation {
  readonly toolCall: CompatibilityTurn;
  readonly structuredOutput: CompatibilityTurn | null;
}

export function probeCompatibility(
  model: string,
  provider: ProbeProvider,
  options: CompatibilityProbeOptions,
): Promise<CompatibilityProbeObservation>;

export function streamChatCompletion(
  provider: ProbeProvider,
  body: Record<string, unknown>,
  options: Pick<
    CompatibilityProbeOptions,
    "fetch" | "timeoutMs" | "errorBodyMaxChars" | "credentialEchoMinChars"
  > & {
    /** Clock for `transport.elapsedMs`; `Date.now` by default. */
    readonly now?: () => number;
  },
): Promise<CompatibilityTurn>;
