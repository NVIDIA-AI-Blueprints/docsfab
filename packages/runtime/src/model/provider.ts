// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { currentTaskActivity } from "../activity/observer.js";
import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";

import { canonicalDigest, deepFreeze } from "../contract-kit/index.js";
import { providerRequestUrl, providerSdkBaseUrl } from "../config/model-providers.js";
import {
  isInstalledPolicyRoute,
  type InstalledReasoningControl,
} from "../model-composition/types.js";
import {
  type BoundModelExecutionProfile,
  type ModelEndpointConfig,
  type ProviderCredential,
  type ProviderTransport,
} from "./configuration.js";
import {
  assertLocalhostEndpointResolvesToLoopback,
  INSECURE_MODEL_ENDPOINT_CODE,
  INSECURE_MODEL_ENDPOINT_NEXT_ACTION,
  isAdmittedModelEndpoint,
  LOCALHOST_RESOLUTION_MESSAGE,
} from "./endpoint-transport.js";
import { createLoopbackHttpFetch, LoopbackResolutionRefusal } from "./loopback-http-fetch.js";
import { OutboundProxyRefusal, outboundFetch } from "./outbound-http-policy.js";
import { resolveOperatorExecutionBinding } from "./operator-execution-binding.js";
import type {
  InferenceEvidenceIdentity,
  InferenceTurnEvidence,
  ProviderResponseEvidenceV1,
  ProviderResponseObservationV1,
  InferenceEfficiencyEvidenceV1,
} from "../records/contracts.js";
import type { ProviderExchangeObservation } from "./attempt-telemetry.js";
import {
  anthropicDefaultThinking,
  anthropicEffort,
  anthropicThinking,
  thinkingLevelFor,
} from "./reasoning-wire.js";
import type { ReasoningEffortLevel } from "../config/model-settings.js";
import { observeProviderStreamErrors } from "./provider-stream-error.js";
import {
  estimateModelRequestTokens,
  grantedTurnOutputTokens,
  LOCAL_STOP_MESSAGE_PREFIX,
  preflightContextBudget,
} from "./context-budget.js";
import {
  governProviderTurn,
  type OutputTokenAuthorityInput,
  type TurnGovernorPolicy,
  type TurnGovernorState,
  type TurnRequestContext,
  type TurnToolEvidence,
} from "./turn-governor.js";
import {
  CredentialBoundaryError,
  assertModelRequestCredentialFree,
} from "../security/credential-isolation.js";
import { registerConfiguredCredential } from "../security/configured-credentials.js";
import {
  credentialForRequest,
  releaseModelCredential,
  type ReleasedModelCredential,
} from "../security/model-credential-release.js";
import {
  DOCSFAB_SYSTEM_PROMPT,
  applyReasoningControl,
  assertToolHistoryCarriesTools,
  finalizeNvidiaApiCatalogPayload,
  ProviderRequestPolicyError,
} from "./request-policy.js";
import { isAdmissibleRequestPolicyRefusal } from "./request-policy-refusals.js";
import {
  withBoundedProviderTurnRetry,
  type ProviderTurnBackoffEvent,
  type ProviderTurnReplayVeto,
  type ProviderTurnRetryPolicy,
} from "./provider-turn-retry.js";
import {
  assertStepPhysicalAttemptsRemaining,
  createPhysicalProviderAttemptLedger,
  type PhysicalProviderAttemptLedger,
} from "./provider-attempt.js";
import {
  settlePhysicalEffect,
  TaskBudgetError,
  type TaskBudgetOwner,
  type TaskBudgetEnvelope,
} from "../execution/task-budget.js";

import { ProviderBoundaryRefusalError, ProviderResponseLimitError } from "./provider/errors.js";
export { ProviderResponseLimitError } from "./provider/errors.js";
import {
  observeProviderResponse,
  validateProviderResponseModel,
} from "./provider/response-boundary.js";
import type { ServedModelObservation } from "./provider/response-boundary.js";
export type { ServedModelObservation } from "./provider/response-boundary.js";
import { finalizeTurnEvidence, writeTurnEvidence } from "./provider/turn-evidence.js";
import type { ActiveTurnGovernance, PendingFinalTurn } from "./provider/turn-evidence-types.js";

type ConfiguredModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;
type PiProviderApi = "openai-completions" | "openai-responses" | "anthropic-messages";
type ModelExecutionBudgetProfile = Pick<
  BoundModelExecutionProfile,
  "profile" | "requestPolicy" | "contextAdmission"
>;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ORIGIN_BOUNDARY_ERROR = "Provider request rejected by the configured origin boundary.";
const INSECURE_ORIGIN_BOUNDARY_ERROR = `Provider request rejected by the configured origin boundary: plain HTTP is allowed only to a loopback host (${INSECURE_MODEL_ENDPOINT_CODE}). ${INSECURE_MODEL_ENDPOINT_NEXT_ACTION}`;
const LOOPBACK_RESOLUTION_ERROR = `Provider request rejected before sending: ${LOCALHOST_RESOLUTION_MESSAGE} (${INSECURE_MODEL_ENDPOINT_CODE}). ${INSECURE_MODEL_ENDPOINT_NEXT_ACTION}`;
const REDIRECT_BOUNDARY_ERROR = "Provider response rejected because redirects are not allowed.";
const FINAL_TURN_CONTEXT = Symbol("docsfab-final-turn-context");
const REQUEST_TURN = Symbol("docsfab-request-turn");
interface ScopedTaskBudget {
  readonly owner: TaskBudgetOwner;
  readonly onRefusal?: (error: TaskBudgetError) => void;
}
const taskBudgetScope = new AsyncLocalStorage<ScopedTaskBudget | undefined>();

/** Bind one host-owned task budget to all provider work in this awaited call tree. */
export function withTaskBudgetScope<T>(
  owner: TaskBudgetOwner,
  work: () => Promise<T>,
  onRefusal?: (error: TaskBudgetError) => void,
): Promise<T> {
  return taskBudgetScope.run({ owner, onRefusal }, work);
}

export interface ProviderResponseBoundaryOptions {
  /** Effective per-response byte ceiling. Omitted on the legacy path. */
  maxResponseBytes?: number;
  /** Exact installed request pathname. Omitted on the legacy path. */
  allowedRequestPath?: string;
  /** Permit only Anthropic's exact SDK beta query on the pinned request path. */
  allowAnthropicBetaQuery?: boolean;
  /**
   * The requested model, compared with the model the response names. A
   * different name is reported to `onServedModel`, never refused: gateways
   * rename models. A response that names no model is refused.
   */
  expectedModel?: string;
  /** Called when a response names models other than `expectedModel`. */
  onServedModel?: (observation: ServedModelObservation) => void;
  transport?: ProviderTransport;
  /** Exact selected transport secret, checked in addition to known patterns. */
  forbiddenCredential?: string;
  /**
   * Called once per response when its first body byte arrives, before any
   * check buffers the body, so a caller can tell a provider that started
   * answering from one that never did.
   */
  onFirstBodyByte?: () => void;
  /** The request sequence keeps asynchronous stream failures tied to that request. */
  onRequestStart?: (requestSequence: number) => void;
  /** Called after local guards pass, immediately before the physical send. */
  onPhysicalRequestStart?: (
    requestSequence: number,
    body: BodyInit | null | undefined,
    turn: number | null,
  ) => void;
  /** Content-free terminal response measurement, once for each dispatched request. */
  onResponseObservation?: (observation: ProviderResponseObservationV1) => void;
  /** Bind the exact returned response to its physical request before stream reads begin. */
  onResponseReady?: (response: Response, requestSequence: number) => void;
  onResponseLimit?: (error: ProviderResponseLimitError, requestSequence: number) => void;
  captureResponseDigest?: boolean;
}

/** The run warning for a served model that differs from the requested one. */
export function servedModelWarning(observation: ServedModelObservation): string {
  return `The provider served model ${[...new Set(observation.servedModels)].join(", ")} for requested model ${observation.expectedModel}; DocsFab recorded it and continued.`;
}

export interface DiscardedProviderTurnUsage {
  /** Empty provider turns replayed away since the last drain. */
  turns: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ModelConnection {
  runtime: ModelRuntime;
  model: ConfiguredModel;
  /** Pi requires numeric rates; DocsFab reports cost only when every rate is current. */
  reportUsageCost: boolean;
  /** Present only for a workflow attempt bound to repository evidence. */
  turnGovernance?: {
    maxToolCalls?: number;
    evidence(): InferenceTurnEvidence[];
  };
  /**
   * Tokens spent on provider turns the in-turn replay discarded. A replayed turn
   * never reaches Pi, so the harness must charge it against the governed turn
   * that landed. Draining resets the ledger.
   */
  discardedProviderUsage?: {
    drain(): DiscardedProviderTurnUsage;
  };
  /**
   * Physical provider requests this attempt-scoped connection issued across
   * every governed turn, and what the step has left under
   * `providerAttempt.maxPhysicalRequestsPerStep`.
   */
  physicalProviderAttempts?: {
    spent(): number;
    remaining(): number | null;
    /** The task-budget refusal that closed the ledger, when one did. */
    refusal(): string | undefined;
  };
  /** Snapshot of physical response-body byte observations for this attempt. */
  providerResponses?: () => ProviderResponseEvidenceV1 | undefined;
  /** Snapshot of exact serialized request-body measurements for this attempt. */
  providerRequests?: () => InferenceEfficiencyEvidenceV1["requests"];
  /**
   * What the transport saw of the most recent physical request: whether it left
   * the host, and a non-2xx response's status and `Retry-After`. Pi flattens
   * provider failures into text, so this keeps a refusal DocsFab made before
   * sending from being recorded as a provider error.
   */
  providerTransport?: {
    lastExchange(): ProviderExchangeObservation;
    /**
     * The proxy refusal that ended the most recent physical request, if one
     * did. Pi flattens it into "Connection error" text; this keeps its code.
     */
    lastProxyRefusal(): OutboundProxyRefusal | undefined;
    /**
     * The credential-isolation refusal that ended the most recent physical
     * request, if one did: DocsFab's own configured credential in the request
     * payload or the provider's response (#1807). Pi flattens it into
     * "Connection error" text; this keeps its code and next action.
     */
    lastCredentialRefusal?(): CredentialBoundaryError | undefined;
    /** The typed deterministic response-byte refusal of the latest physical request. */
    lastResponseLimitRefusal?(): ProviderResponseLimitError | undefined;
    /**
     * Observe each in-turn replay before its backoff, so an interactive host
     * can say why it is waiting. Returns the unsubscribe function.
     */
    onRetryBackoff(listener: (notice: ProviderRetryNotice) => void): () => void;
  };
}

/** One replay about to wait, with the failing response's status when one answered. */
export interface ProviderRetryNotice extends ProviderTurnBackoffEvent {
  readonly httpStatus?: number;
}

export interface ProviderConnectionInput {
  profile: BoundModelExecutionProfile;
  credential: ProviderCredential;
}

export interface ProviderConnectionFactory {
  readonly routeId: string;
  readonly transport: ProviderTransport;
  create(
    input: ProviderConnectionInput,
    turnOptions?: ModelTurnGovernanceOptions,
  ): Promise<ModelConnection>;
}

interface ProviderConnectionFactoryOptions {
  routeId: string;
  transport: ProviderTransport;
  /** Provider-offline test seam. Production callers leave this unset. */
  fetch?: typeof globalThis.fetch;
  /** Receives each served-model difference, so the run can record it. */
  onServedModel?: (observation: ServedModelObservation) => void;
}

interface TransportBinding {
  api: PiProviderApi;
  apiFormat: BoundModelExecutionProfile["apiFormat"];
  authHeader: boolean;
}

const TRANSPORT_BINDINGS: Record<ProviderTransport, TransportBinding> = {
  "openai-chat-completions": {
    api: "openai-completions",
    apiFormat: "chat_completions",
    authHeader: true,
  },
  "openai-responses": {
    api: "openai-responses",
    apiFormat: "chat_completions",
    authHeader: false,
  },
  "anthropic-messages": {
    api: "anthropic-messages",
    apiFormat: "messages",
    authHeader: false,
  },
};

export const DEFAULT_TURN_GOVERNANCE_LIMITS = {
  maxProviderTurns: 12,
  maxToolCalls: 12,
  maxCompactions: 8,
  minRecentToolTurns: 1,
} as const;

export interface ModelTurnGovernanceOptions {
  evidenceIdentity: InferenceEvidenceIdentity;
  limits?: Partial<Record<keyof typeof DEFAULT_TURN_GOVERNANCE_LIMITS, number>>;
  aggregatePolicy?: { kind: "absent" };
  /** Host-owned cumulative preflight immediately before provider network access. */
  beforeProviderTurn?: (turn: InferenceTurnEvidence) => void;
  /**
   * Host-owned cumulative output authority, read before each governed turn so
   * `max_tokens` can be clamped to what the lease still allows.
   * `beforeProviderTurn` runs after the payload is final and can only refuse;
   * this runs first and can shrink.
   */
  outputAuthority?: () => OutputTokenAuthorityInput | undefined;
  /**
   * The `tool_choice` the next chat-completions request carries, read in the
   * payload hook before the request policy finalizes it. The final quality
   * evaluator's report turn reads `none`; explicit experimental answer-record
   * recovery may read `required` until host report readiness. `undefined`
   * leaves the request as Pi built it, tools included.
   */
  toolChoice?: () => "none" | "required" | undefined;
  providerTurnRetry?: Partial<ProviderTurnRetryPolicy>;
  /**
   * Physical provider requests this step attempt may spend across every
   * governed turn. Omitted means `providerAttempt.maxPhysicalRequestsPerStep`.
   */
  maxPhysicalRequestsPerStep?: number;
  /** Explicit no-across-step-ceiling mode for experimental answer-record discovery. */
  aggregatePhysicalRequestLimit?: { readonly kind: "absent" };
  /**
   * Nested remaining-budget owner. Each physical provider request settles one
   * `provider-turns` charge under its own effect id, so a duplicated request
   * cannot charge the budget twice.
   */
  taskBudget?: TaskBudgetOwner;
  /** Preserve local budget refusals even if Pi flattens stream errors. */
  onTaskBudgetRefusal?: (error: TaskBudgetError) => void;
  /** Optional content-free physical request observer for one public task. */
  taskActivityObserver?: {
    failed(): void;
    started(requestSequence: number, turn: number | null, body: BodyInit | null | undefined): void;
    settled(observation: ProviderResponseObservationV1): void;
    streamError(requestSequence: number, errorClass: string): void;
  };
}

/**
 * Fail closed before provider traffic can leave the configured origin, which is
 * HTTPS or plain HTTP to a loopback host. Redirects stay manual so neither a
 * request body nor authorization metadata can be replayed to a destination that
 * was not explicitly configured. Without a `delegate`, plain HTTP goes through
 * the direct loopback transport, never the global (possibly proxied) fetch, and
 * HTTPS goes through the outbound proxy policy.
 */
export function createProviderBoundaryFetch(
  baseUrl: string,
  delegate?: typeof globalThis.fetch,
  responseOptions: ProviderResponseBoundaryOptions = {},
): typeof globalThis.fetch {
  let approved: URL;
  try {
    approved = new URL(baseUrl);
  } catch {
    throw new ProviderBoundaryRefusalError(ORIGIN_BOUNDARY_ERROR);
  }
  if (!isAdmittedModelEndpoint(approved)) {
    throw new ProviderBoundaryRefusalError(
      approved.protocol === "http:" ? INSECURE_ORIGIN_BOUNDARY_ERROR : ORIGIN_BOUNDARY_ERROR,
    );
  }
  const approvedOrigin = approved.origin;
  const send =
    delegate ?? (approved.protocol === "http:" ? createLoopbackHttpFetch() : outboundFetch());
  let requestSequence = 0;

  return async (input, init) => {
    // Invalidate the previous request before even local URL/path checks: a
    // rejected next request must not inherit an older stream's late failure.
    const currentRequestSequence = ++requestSequence;
    responseOptions.onRequestStart?.(currentRequestSequence);
    const onResponseLimit = (error: ProviderResponseLimitError): void => {
      responseOptions.onResponseLimit?.(error, currentRequestSequence);
    };
    let requestUrl: URL;
    try {
      requestUrl = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
    } catch {
      throw new ProviderBoundaryRefusalError(ORIGIN_BOUNDARY_ERROR);
    }
    if (!isAdmittedModelEndpoint(requestUrl) || requestUrl.origin !== approvedOrigin) {
      throw new ProviderBoundaryRefusalError(ORIGIN_BOUNDARY_ERROR);
    }
    if (responseOptions.allowedRequestPath !== undefined) {
      const hasEmptyQueryDelimiter = requestUrl.href.split("#", 1)[0]?.endsWith("?") === true;
      const hasFragmentDelimiter = requestUrl.href.includes("#");
      const exactAnthropicBetaQuery =
        responseOptions.allowAnthropicBetaQuery === true &&
        responseOptions.transport === "anthropic-messages" &&
        requestUrl.search === "?beta=true";
      if (
        requestUrl.pathname !== responseOptions.allowedRequestPath ||
        ((requestUrl.search !== "" || hasEmptyQueryDelimiter) && !exactAnthropicBetaQuery) ||
        hasFragmentDelimiter ||
        requestUrl.username !== "" ||
        requestUrl.password !== ""
      ) {
        throw new ProviderBoundaryRefusalError(ORIGIN_BOUNDARY_ERROR);
      }
    }

    const requestTurn =
      (init as (RequestInit & { [REQUEST_TURN]?: number | null }) | undefined)?.[REQUEST_TURN] ??
      null;
    responseOptions.onPhysicalRequestStart?.(currentRequestSequence, init?.body, requestTurn);
    let response: Response;
    try {
      const sentInit: RequestInit & { [REQUEST_TURN]?: number | null } = {
        ...init,
        redirect: "manual",
      };
      delete (sentInit as RequestInit & { [REQUEST_TURN]?: number | null })[REQUEST_TURN];
      response = await send(input, sentInit);
    } catch (error) {
      responseOptions.onResponseObservation?.({
        requestSequence: currentRequestSequence,
        disposition: "no-response",
        observedBytes: 0,
      });
      if (error instanceof LoopbackResolutionRefusal) {
        throw new ProviderBoundaryRefusalError(LOOPBACK_RESOLUTION_ERROR);
      }
      throw error;
    }
    if (REDIRECT_STATUSES.has(response.status)) {
      try {
        // Start cleanup without awaiting provider-controlled stream behavior.
        // Redirect rejection must remain prompt and authoritative.
        void response.body?.cancel().catch(() => undefined);
      } catch {
        // The stable boundary error is authoritative even if cleanup fails.
      }
      responseOptions.onResponseObservation?.({
        requestSequence: currentRequestSequence,
        disposition: response.body === null ? "no-body" : "cancelled",
        observedBytes: 0,
        httpStatus: response.status,
      });
      throw new ProviderBoundaryRefusalError(REDIRECT_BOUNDARY_ERROR);
    }
    const bounded = observeProviderResponse(
      response,
      responseOptions.maxResponseBytes,
      onResponseLimit,
      currentRequestSequence,
      responseOptions.onFirstBodyByte,
      responseOptions.onResponseObservation,
      responseOptions.captureResponseDigest === true,
    );
    const ready =
      responseOptions.expectedModel && responseOptions.transport
        ? await validateProviderResponseModel(
            bounded,
            responseOptions.expectedModel,
            responseOptions.transport,
            responseOptions.forbiddenCredential,
            responseOptions.onServedModel,
          )
        : bounded;
    responseOptions.onResponseReady?.(ready, currentRequestSequence);
    return ready;
  };
}

/** Stable local stop; the message contains only closed reasons and numeric counts. */
export class TurnGovernanceError extends Error {
  public readonly code = "context-exhausted" as const;
  public readonly retryable = false as const;

  public constructor(public readonly turn: InferenceTurnEvidence) {
    super(
      [
        LOCAL_STOP_MESSAGE_PREFIX,
        `reason=${turn.reason ?? "context-exhausted"}`,
        `turn=${turn.turn}`,
        `provider-turn-limit=${turn.maxProviderTurns}`,
        `tool-calls=${turn.toolCalls}`,
        `tool-call-limit=${turn.maxToolCalls}`,
        `estimated-input=${turn.estimatedInputTokens}`,
        `available-input=${turn.availableInputTokens ?? "legacy-unbound"}`,
        `available-output=${turn.availableOutputTokens}`,
        `required-minimum-output=${turn.requiredMinimumOutputTokens}`,
        ...(turn.outputAuthority
          ? [
              `cumulative-output=${turn.outputAuthority.cumulativeOutputTokens}`,
              `output-authority=${turn.outputAuthority.maxOutputTokens}`,
              `output-floor=${turn.outputAuthority.floorOutputTokens}`,
            ]
          : []),
      ].join(" "),
    );
    this.name = "TurnGovernanceError";
  }
}

export function hasReportableUsageCost(config: ModelExecutionBudgetProfile): boolean {
  return (
    config.profile.metadata.status === "current" &&
    Object.values(config.profile.costPerMillionTokens).every(
      (value) => value !== null && Number.isFinite(value) && value >= 0,
    )
  );
}

export function createContextBudgetedStream(
  config: ModelExecutionBudgetProfile,
  delegate: ModelRuntime["streamSimple"],
  governance?: ActiveTurnGovernance,
  /**
   * The step attempt's physical-request allowance, enforced here because every
   * governed turn's first request passes through; the replay wrapper can only
   * refuse replays. Refusing before `governProviderTurn` writes no ledger row,
   * since a row that issued no request would read as `unaccounted`.
   */
  stepAttempts?: Pick<
    PhysicalProviderAttemptLedger,
    "hasRemaining" | "spent" | "bound" | "refusal"
  >,
): ModelRuntime["streamSimple"] {
  return (model, context, options) => {
    if (stepAttempts) assertStepPhysicalAttemptsRemaining(stepAttempts);
    const hostAdmission = config.contextAdmission !== "provider";
    if (governance) {
      const observed = observeTurnContext(context, governance.evidenceIdentity);
      governance.state = {
        ...governance.state,
        toolCalls: observed.toolCalls,
        toolResults: observed.toolResults,
      };
      // Read before governing so the governor can clamp `max_tokens` or stop by
      // name, instead of the post-finalization preflight refusing the request.
      const outputAuthority = governance.outputAuthority?.();
      const decision = governProviderTurn({
        context,
        policy: governance.policy,
        state: governance.state,
        evidenceIdentity: governance.evidenceIdentity,
        pinnedMessageCount: observed.pinnedMessageCount,
        toolEvidence: observed.toolEvidence,
        ...(options?.maxTokens === undefined ? {} : { requestedOutputTokens: options.maxTokens }),
        ...(outputAuthority === undefined ? {} : { outputAuthority }),
      });
      governance.ledger.push(decision.evidence);
      governance.state = decision.nextState;
      if (decision.evidence.decision === "stop") {
        throw new TurnGovernanceError(decision.evidence);
      }
      const delegatedOptions = {
        ...options,
        maxTokens: grantedTurnOutputTokens(decision.evidence),
      } as Record<PropertyKey, unknown>;
      delegatedOptions[FINAL_TURN_CONTEXT] = {
        governance,
        evidence: decision.evidence,
        retries: 0,
        blankTurns: 0,
        nudgedReplayPending: false,
      } satisfies PendingFinalTurn;
      return delegate(
        { ...model, contextWindow: 0 },
        decision.context as typeof context,
        delegatedOptions as Parameters<ModelRuntime["streamSimple"]>[2],
      );
    }

    const budget = hostAdmission
      ? preflightContextBudget({
          configuredContextWindow: config.profile.configuredLimits.contextWindow,
          effectiveContextWindow: config.profile.contextWindow,
          configuredMaxInputTokens: config.profile.configuredLimits.maxInputTokens,
          effectiveMaxInputTokens: config.profile.maxInputTokens,
          configuredMaxOutputTokens: config.profile.configuredLimits.maxOutputTokens,
          effectiveMaxOutputTokens: config.profile.maxOutputTokens,
          reservedTokens: config.requestPolicy.reservedContextTokens,
          estimatedInputTokens: estimateModelRequestTokens(context),
          requiredMinimumOutputTokens: config.requestPolicy.minimumOutputTokens,
          ...(options?.maxTokens === undefined ? {} : { requestedOutputTokens: options.maxTokens }),
        })
      : undefined;

    return delegate(
      // DocsFab already clamped context or skipped host admission; disable Pi
      // AI's hidden one-token floor without changing the registered model.
      { ...model, contextWindow: 0 },
      context,
      budget === undefined ? options : { ...options, maxTokens: budget.outputTokens },
    );
  };
}

export async function createModelConnection(
  config: ModelEndpointConfig,
  turnOptions?: ModelTurnGovernanceOptions,
): Promise<ModelConnection> {
  // Writing and judge share this binder; qualification never gates ordinary writing.
  const bound = await resolveOperatorExecutionBinding({ model: config });
  return createProviderConnectionFactory({
    routeId: bound.profile.routeId,
    transport: bound.profile.transport,
  }).create({ profile: bound.profile, credential: bound.credential }, turnOptions);
}

function ensureInstalledSystemInstruction(rawPayload: unknown): unknown {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    return rawPayload;
  }
  const payload = rawPayload as Record<string, unknown>;
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) return rawPayload;
  const first = payload.messages[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) return rawPayload;
  const message = first as Record<string, unknown>;
  if (message.role !== "system" || typeof message.content !== "string") return rawPayload;
  if (
    message.content === DOCSFAB_SYSTEM_PROMPT ||
    message.content.startsWith(`${DOCSFAB_SYSTEM_PROMPT}\n`)
  ) {
    return rawPayload;
  }
  return {
    ...payload,
    messages: [
      { ...message, content: `${DOCSFAB_SYSTEM_PROMPT}\n${message.content}` },
      ...payload.messages.slice(1),
    ],
  };
}

/**
 * Create an exact route-and-transport adapter. A factory never chooses a
 * fallback route, transport, model, or credential family.
 */
export function createProviderConnectionFactory(
  options: ProviderConnectionFactoryOptions,
): ProviderConnectionFactory {
  if (!options.routeId.trim()) throw new Error("Provider connection route ID must not be empty.");
  const binding = TRANSPORT_BINDINGS[options.transport];
  if (!binding)
    throw new Error("The selected provider connection transport is not supported by DocsFab.");
  const providerFetch = options.fetch;
  return Object.freeze({
    routeId: options.routeId,
    transport: options.transport,
    async create(
      input: ProviderConnectionInput,
      suppliedTurnOptions?: ModelTurnGovernanceOptions,
    ): Promise<ModelConnection> {
      const activity = currentTaskActivity();
      const contextualObserver =
        suppliedTurnOptions && !suppliedTurnOptions.taskActivityObserver && activity?.childScopeId
          ? activity.observer.attachProviderConnection(
              input.profile.routeId,
              input.profile.transport,
              input.profile.modelId,
              {
                childScopeId: activity.childScopeId,
                producerSessionId: activity.producerSessionId,
              },
            )
          : undefined;
      const turnOptions: ModelTurnGovernanceOptions | undefined = suppliedTurnOptions
        ? contextualObserver
          ? { ...suppliedTurnOptions, taskActivityObserver: contextualObserver }
          : suppliedTurnOptions
        : undefined;
      if (input.profile.routeId !== options.routeId) {
        throw new Error("Provider connection route does not match the selected factory.");
      }
      if (input.profile.transport !== options.transport) {
        throw new Error("Provider connection transport does not match the selected factory.");
      }
      // The credential family stays bound to the route; the wire protocol is
      // the operator's choice, so any family runs over any transport.
      // A policy, when present, must match the route. A preset that runs
      // without its policy was warned about when it was bound.
      const policy = input.profile.compositionRequestPolicy;
      if (
        policy !== undefined &&
        (!isInstalledPolicyRoute(options.routeId) ||
          options.transport !== "openai-chat-completions" ||
          input.credential.family !== options.routeId ||
          policy.routeId !== options.routeId)
      ) {
        throw new Error("Provider request policy does not match the selected route.");
      }
      const apiKey = input.credential.apiKey;
      if (!apiKey) {
        throw new Error("The selected provider credential must contain one nonempty secret value.");
      }
      if (input.profile.apiFormat !== binding.apiFormat) {
        throw new Error("Provider API format does not match the selected transport.");
      }
      // Every model connection releases its key here, before any request.
      const released = releaseModelCredential(
        {
          endpoint: input.profile.baseUrl,
          endpointSource: input.profile.endpointSource,
          apiKey,
        },
        "model-connection",
      );
      return createBoundModelConnection(
        {
          profile: input.profile,
          credential: { family: input.credential.family, apiKey },
        },
        binding,
        providerFetch,
        released,
        turnOptions,
        options.onServedModel,
      );
    },
  });
}

async function createBoundModelConnection(
  input: ProviderConnectionInput,
  binding: TransportBinding,
  providerFetch: typeof globalThis.fetch | undefined,
  released: ReleasedModelCredential,
  turnOptions?: ModelTurnGovernanceOptions,
  onServedModel?: (observation: ServedModelObservation) => void,
): Promise<ModelConnection> {
  const config = input.profile;
  // Name the stop with its code before Pi can flatten a transport refusal.
  await assertLocalhostEndpointResolvesToLoopback(config.baseUrl);
  // The Switchyard GPT-5.6 Sol tool-reasoning workaround was removed with that
  // model's retirement (#1512): loading refuses the id before any connection.
  // Claude Sonnet 5 on the Inference Hub thinks by default without streaming
  // it, and the thinking counts against `max_completion_tokens`, so a turn can
  // spend its whole output limit and surface nothing. `thinking: {type:
  // "disabled"}` is honored; `reasoning_effort: "none"` is accepted but inert.
  // This makes the wire match a profile with `reasoning: false`. It keys on the
  // model id, not the origin, so the same model behind a gateway keeps it.
  const disableHubSonnetThinking =
    config.transport === "openai-chat-completions" &&
    config.modelId === "aws/anthropic/bedrock-claude-sonnet-5" &&
    config.profile.reasoning === false;
  // On Anthropic Messages, a model that thinks when a request omits
  // `thinking` gets `{type: "disabled"}` with reasoning off, where it accepts
  // it; the binding warns about one that cannot turn thinking off.
  const disableDefaultThinking =
    config.transport === "anthropic-messages" &&
    config.profile.reasoning === false &&
    anthropicDefaultThinking(config.modelId) === "disable";
  if (!config.profile.compatibility.apiFormats.includes(config.apiFormat)) {
    throw new Error(
      `Model ${config.providerId}/${config.modelId} is incompatible with API format ${config.apiFormat}.`,
    );
  }

  const runtime = await ModelRuntime.create({
    modelsPath: null,
    allowModelNetwork: false,
  });

  runtime.registerProvider(config.providerId, {
    name: "DocsFab hosted inference",
    baseUrl: providerSdkBaseUrl(config.baseUrl, config.transport),
    api: binding.api,
    authHeader: binding.authHeader,
    models: [
      {
        id: config.modelId,
        name: config.modelId,
        reasoning: config.compositionRequestPolicy ? false : config.profile.reasoning,
        input: config.profile.input,
        cost: {
          input: config.profile.costPerMillionTokens.input ?? 0,
          output: config.profile.costPerMillionTokens.output ?? 0,
          cacheRead: config.profile.costPerMillionTokens.cacheRead ?? 0,
          cacheWrite: config.profile.costPerMillionTokens.cacheWrite ?? 0,
        },
        contextWindow: config.profile.contextWindow,
        maxTokens: config.profile.maxOutputTokens,
        compat: {
          supportsDeveloperRole: config.compositionRequestPolicy
            ? false
            : config.profile.compatibility.supportsDeveloperRole,
          supportsReasoningEffort: config.profile.compatibility.supportsReasoningEffort,
          // Otherwise Pi adds `tools[].function.strict` to every tools-bearing
          // request, and some front doors reject it as an extra input. DocsFab
          // can only ever emit `false` there (no DocsFab tool declares
          // `constrainedSampling` and `PI_EXPERIMENTAL` is never set), so the
          // field is dropped on every route. A tool that requires strict
          // sampling fails by name in pi-ai instead of being sent unconstrained.
          supportsStrictMode: false,
          // Reasoning on Anthropic Messages is adaptive thinking with an effort
          // for a model Pi's catalog marks adaptive: current Claude models
          // refuse a thinking budget. Any other model keeps budget thinking.
          ...(config.transport === "anthropic-messages" &&
          anthropicThinking(config.modelId).adaptive
            ? { forceAdaptiveThinking: true }
            : {}),
          ...(config.compositionRequestPolicy
            ? {
                maxTokensField: "max_tokens" as const,
                supportsUsageInStreaming: true,
              }
            : {}),
        },
      },
    ],
  });
  // Registering the credential must not refresh unrelated credentials from Pi's
  // host auth store or cause ambient provider I/O. `setRuntimeApiKey()` performs
  // no catalog refresh unless a separate `refresh()` call opts in, which DocsFab
  // never makes, and the runtime pins `allowModelNetwork: false`.
  await runtime.setRuntimeApiKey(
    config.providerId,
    credentialForRequest(released, providerRequestUrl(config.baseUrl, config.transport)),
  );
  // The key in use may come from a file or a caller's environment rather than
  // this process's; the exact-match screens learn it either way (#1807).
  registerConfiguredCredential(input.credential.apiKey, "the model key in use");

  const providerStream = runtime.streamSimple.bind(runtime);
  // Whether the current physical request's response body has started to
  // arrive; reset with the exchange below.
  let bodyReceived = false;
  let responseLimitRefusal: ProviderResponseLimitError | undefined;
  let latestProviderRequestSequence = 0;
  const activityResponseSequence = new WeakMap<Response, number>();
  const responseSequences = new Set<number>();
  const responseObservations = new Map<number, ProviderResponseObservationV1>();
  const requestObservations: InferenceEfficiencyEvidenceV1["requests"] = [];
  const providerResponses = (): ProviderResponseEvidenceV1 | undefined => {
    if (responseSequences.size === 0) return undefined;
    const observations = [...responseObservations.values()]
      .sort((left, right) => left.requestSequence - right.requestSequence)
      .map((item) => ({ ...item }));
    const pendingRequestSequences = [...responseSequences]
      .filter((sequence) => !responseObservations.has(sequence))
      .sort((left, right) => left - right);
    return {
      schemaVersion: 1,
      state: pendingRequestSequences.length === 0 ? "complete" : "pending",
      observations,
      pendingRequestSequences,
    };
  };
  const taskEffectScope = `provider-${randomUUID()}`;
  const taskProviderTurnCharge: TaskBudgetEnvelope = {
    "provider-turns": 1,
    "tool-calls": 0,
    "input-tokens": 0,
    "output-tokens": 0,
    "source-bytes": 0,
    "elapsed-ms": 0,
    "cost-microusd": 0,
  };
  const providerBoundaryFetch = createProviderBoundaryFetch(config.baseUrl, providerFetch, {
    onFirstBodyByte: () => {
      bodyReceived = true;
    },
    onRequestStart: (requestSequence) => {
      latestProviderRequestSequence = requestSequence;
      responseLimitRefusal = undefined;
    },
    onPhysicalRequestStart: (requestSequence, body, turn) => {
      const scoped = taskBudgetScope.getStore();
      const scopedBudget = scoped?.owner;
      if (scopedBudget && turnOptions?.taskBudget && scopedBudget !== turnOptions.taskBudget) {
        // hygiene: ok -- the first argument is a typed budget code, not operator prose.
        throw new TaskBudgetError("invalid-shape", {
          message: "The provider task budget disagrees with its host scope.",
        });
      }
      const taskBudget = turnOptions?.taskBudget ?? scopedBudget;
      if (taskBudget) {
        try {
          settlePhysicalEffect(taskBudget, {
            effectId: `${taskEffectScope}:${requestSequence}`,
            charges: taskProviderTurnCharge,
          });
        } catch (error) {
          if (error instanceof TaskBudgetError) {
            (turnOptions?.onTaskBudgetRefusal ?? scoped?.onRefusal)?.(error);
          }
          throw error;
        }
      }
      responseSequences.add(requestSequence);
      // Every physical request has a row. An unexpected body form is explicit
      // unavailable evidence, never a dropped request or a zero-byte claim.
      const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : null;
      requestObservations.push({
        requestSequence,
        turn,
        bodyBytes: bytes?.byteLength ?? null,
        bodySha256: bytes ? createHash("sha256").update(bytes).digest("hex") : null,
      });
      try {
        turnOptions?.taskActivityObserver?.started(requestSequence, turn, body);
      } catch {
        turnOptions?.taskActivityObserver?.failed();
      }
    },
    onResponseObservation: (observation) => {
      if (responseSequences.has(observation.requestSequence)) {
        responseObservations.set(observation.requestSequence, { ...observation });
      }
      try {
        turnOptions?.taskActivityObserver?.settled(observation);
      } catch {
        turnOptions?.taskActivityObserver?.failed();
      }
    },
    onResponseReady: (response, requestSequence) => {
      activityResponseSequence.set(response, requestSequence);
    },
    onResponseLimit: (error, requestSequence) => {
      if (requestSequence === latestProviderRequestSequence) responseLimitRefusal = error;
    },
    captureResponseDigest: turnOptions?.taskActivityObserver !== undefined,
    ...(config.compositionPolicy
      ? {
          maxResponseBytes: config.compositionPolicy.maxResponseBytes,
          allowedRequestPath: new URL(providerRequestUrl(config.baseUrl, config.transport))
            .pathname,
          ...(config.transport === "anthropic-messages" ? { allowAnthropicBetaQuery: true } : {}),
          expectedModel: config.modelId,
          ...(onServedModel ? { onServedModel } : {}),
          transport: config.transport,
          forbiddenCredential: input.credential.apiKey,
        }
      : {}),
  });
  // Connection-scoped, like the attempt it serves. Reset on entry to every
  // governed turn and every physical request, before any guard can refuse
  // either; only the transport fetch marks a request sent or records a proxy
  // refusal.
  let exchange: ProviderExchangeObservation = { sent: false };
  let proxyRefusal: OutboundProxyRefusal | undefined;
  let credentialRefusal: CredentialBoundaryError | undefined;
  const retryBackoffListeners = new Set<(notice: ProviderRetryNotice) => void>();
  const boundaryProviderStream: ModelRuntime["streamSimple"] = (model, context, options) => {
    const scoped = taskBudgetScope.getStore();
    const scopedTaskBudget = scoped?.owner;
    if (
      scopedTaskBudget &&
      turnOptions?.taskBudget &&
      scopedTaskBudget !== turnOptions.taskBudget
    ) {
      // hygiene: ok -- the first argument is a typed budget code, not operator prose.
      throw new TaskBudgetError("invalid-shape", {
        message: "The provider task budget disagrees with its host scope.",
      });
    }
    const streamTaskBudget = turnOptions?.taskBudget ?? scopedTaskBudget;
    exchange = { sent: false };
    bodyReceived = false;
    proxyRefusal = undefined;
    credentialRefusal = undefined;
    responseLimitRefusal = undefined;
    // A local guard can refuse this retry before providerBoundaryFetch runs.
    // Make any delayed response from the preceding request stale immediately.
    latestProviderRequestSequence = 0;
    // C-04 outbound credential guard on the exact model message graph before the
    // transport can send it. The authorization header is applied later and is
    // never part of this graph, so the legitimate credential is unaffected.
    try {
      assertModelRequestCredentialFree(context);
      if (JSON.stringify(context).includes(input.credential.apiKey)) {
        throw new CredentialBoundaryError("model-request");
      }
    } catch (error) {
      // Recorded as the payload and transport refusals are, so the step ends
      // with this coded refusal rather than an unclassified provider failure
      // (#1807). It is thrown before any stream exists, so nothing replays it.
      if (error instanceof CredentialBoundaryError) credentialRefusal = error;
      throw error;
    }
    const pendingTurn = (
      options as (typeof options & { [FINAL_TURN_CONTEXT]?: PendingFinalTurn }) | undefined
    )?.[FINAL_TURN_CONTEXT];
    const priorOnPayload = options?.onPayload;
    const providerOptions = { ...options } as Record<PropertyKey, unknown>;
    delete providerOptions[FINAL_TURN_CONTEXT];
    // A Pi session passes a level on every turn, and the bound profile then
    // sets it, so the request carries what the run records (reasoning-wire.ts).
    // A one-shot call (request interpretation, the first-pass checks, the
    // judges) passes none and keeps its own policy, thinking off, as before,
    // unless an operator set reasoning for this model's slot.
    const thinkingLevel =
      options?.reasoning !== undefined || config.reasoningSetByOperator === true
        ? thinkingLevelFor(config)
        : undefined;
    if (thinkingLevel === undefined) delete providerOptions.reasoning;
    else providerOptions.reasoning = thinkingLevel;
    // Pi flattens every local rejection into a "Connection error" message the
    // classifier calls transient. Record DocsFab's own refusals so a policy stop
    // is never replayed or recorded as a transport fault.
    const localRejection = resetLocalRejection(options);
    const sendGate = createPayloadSendGate(
      (request, init) =>
        taskBudgetScope.run(
          streamTaskBudget
            ? {
                owner: streamTaskBudget,
                onRefusal: turnOptions?.onTaskBudgetRefusal ?? scoped?.onRefusal,
              }
            : undefined,
          () => providerBoundaryFetch(request, init),
        ),
      config.transport,
      pendingTurn?.evidence.turn ?? null,
    );
    return providerStream(model, context, {
      ...providerOptions,
      onPayload: async (payload, payloadModel) => {
        try {
          const replaced = await priorOnPayload?.(payload, payloadModel);
          const builtPayload = replaced === undefined ? payload : replaced;
          const toolChoice =
            config.transport === "openai-chat-completions"
              ? turnOptions?.toolChoice?.()
              : undefined;
          const priorPayload =
            toolChoice !== undefined &&
            builtPayload !== null &&
            typeof builtPayload === "object" &&
            !Array.isArray(builtPayload)
              ? { ...(builtPayload as Record<string, unknown>), tool_choice: toolChoice }
              : builtPayload;
          const authorizedOutputTokens = pendingTurn
            ? grantedTurnOutputTokens(pendingTurn.evidence)
            : config.profile.maxOutputTokens;
          const finalized = config.compositionRequestPolicy
            ? finalizeNvidiaApiCatalogPayload({
                rawPayload: ensureInstalledSystemInstruction(priorPayload),
                policy: config.compositionRequestPolicy,
                exactCredential: input.credential.apiKey,
                maxOutputTokens: authorizedOutputTokens,
              })
            : finalizeProviderPayload(
                priorPayload,
                input.credential.apiKey,
                config.transport,
                authorizedOutputTokens,
                {
                  disableThinking: disableHubSonnetThinking || disableDefaultThinking,
                  reasoningControl: config.measuredReasoningControl?.control,
                  ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
                },
              );
          if (pendingTurn) {
            const omitted =
              "replayedReasoningOmitted" in finalized ? finalized.replayedReasoningOmitted : 0;
            finalizeTurnEvidence(pendingTurn, {
              ...(finalized.requestPolicySha256
                ? { requestPolicySha256: finalized.requestPolicySha256 }
                : {}),
              finalPayloadSha256: finalized.finalPayloadSha256,
              ...(omitted > 0 ? { replayedReasoningOmitted: omitted } : {}),
            });
          }
          sendGate.authorize(finalized.payload, finalized.finalPayloadSha256);
          return finalized.payload;
        } catch (error) {
          sendGate.fail();
          if (localRejection) localRejection.rejected = true;
          if (pendingTurn) recordRequestPolicyRefusal(pendingTurn, error);
          if (error instanceof CredentialBoundaryError) credentialRefusal = error;
          throw error;
        }
      },
      // This assignment must remain last so a caller cannot replace the
      // connection's approved-origin transport through stream options.
      fetch: async (request, init) => {
        try {
          const response = await sendGate.fetch(request, init);
          if (response.ok) {
            const responseRequestSequence = activityResponseSequence.get(response);
            const sent: ProviderExchangeObservation = { sent: true };
            exchange = sent;
            // A 2xx stream can still end in a structured provider error event,
            // or close before its answer finished. A body read after the next
            // request reset the exchange is stale.
            return observeProviderStreamErrors(
              response,
              (streamError) => {
                if (exchange === sent) exchange = { sent: true, streamError };
                try {
                  if (responseRequestSequence === undefined)
                    turnOptions?.taskActivityObserver?.failed();
                  else
                    turnOptions?.taskActivityObserver?.streamError(
                      responseRequestSequence,
                      "provider-stream-error",
                    );
                } catch {
                  turnOptions?.taskActivityObserver?.failed();
                }
              },
              config.transport === "openai-chat-completions"
                ? () => {
                    if (exchange === sent) exchange = { sent: true, streamClosedBeforeDone: true };
                    try {
                      if (responseRequestSequence === undefined)
                        turnOptions?.taskActivityObserver?.failed();
                      else
                        turnOptions?.taskActivityObserver?.streamError(
                          responseRequestSequence,
                          "stream-incomplete",
                        );
                    } catch {
                      turnOptions?.taskActivityObserver?.failed();
                    }
                  }
                : undefined,
            );
          }
          const retryAfterMs = retryAfterMilliseconds(response.headers.get("retry-after"));
          if (localRejection) localRejection.retryAfterMs = retryAfterMs;
          exchange = {
            sent: true,
            httpStatus: response.status,
            ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
          };
          return response;
        } catch (error) {
          const local = isLocalPolicyRejection(error);
          if (localRejection && local) localRejection.rejected = true;
          if (pendingTurn) recordRequestPolicyRefusal(pendingTurn, error);
          // Response-size refusal follows a response from the provider; it is local
          // policy, but the physical request did leave the host.
          exchange = { sent: error instanceof ProviderResponseLimitError || !local };
          if (error instanceof OutboundProxyRefusal) proxyRefusal = error;
          if (error instanceof CredentialBoundaryError) credentialRefusal = error;
          throw error;
        }
      },
    });
  };
  const turnGovernance = turnOptions ? createActiveTurnGovernance(config, turnOptions) : undefined;
  // The connection is attempt-scoped, so its creation time is the attempt clock
  // the composition deadline bounds.
  const attemptStartedAt = Date.now();
  // Tokens of replayed empty turns, held for the harness to charge against the
  // turn that lands, because the lease observes one provider turn per governed
  // request. This is produced output, not an SDK-authority increase; each
  // request still sends the per-request grant.
  const discarded: DiscardedProviderTurnUsage = { turns: 0, inputTokens: 0, outputTokens: 0 };
  // Bounds the whole step attempt. It is consulted at both places a request can
  // start: before the governor admits a turn (`createContextBudgetedStream`) and
  // in the replay decision (`stepAttemptsRemaining`). Either alone leaves the
  // other class unbounded.
  const physicalAttempts: PhysicalProviderAttemptLedger = createPhysicalProviderAttemptLedger({
    ...(turnOptions?.aggregatePhysicalRequestLimit
      ? { aggregateRequestLimit: turnOptions.aggregatePhysicalRequestLimit }
      : {}),
    ...(turnOptions?.maxPhysicalRequestsPerStep === undefined
      ? {}
      : { maxPhysicalRequests: turnOptions.maxPhysicalRequestsPerStep }),
  });
  const retryingProviderStream = withBoundedProviderTurnRetry(boundaryProviderStream, {
    ...(turnOptions?.providerTurnRetry ? { policy: turnOptions.providerTurnRetry } : {}),
    ...(config.compositionPolicy && turnOptions?.aggregatePhysicalRequestLimit?.kind !== "absent"
      ? { deadlineAt: () => attemptStartedAt + config.compositionPolicy!.timeoutMs }
      : {}),
    isReplayable: (streamOptions) => !locallyRejected(streamOptions),
    retryAfterMs: (streamOptions) => observedRetryAfterMs(streamOptions),
    // The failed attempt is decided by its typed provider-error class.
    providerExchange: () => ({ ...exchange }),
    stepAttemptsRemaining: () => physicalAttempts.hasRemaining(),
    onPhysicalAttempt: () => physicalAttempts.record(),
    onReplayVeto: (event) => recordProviderReplayVeto(event.options, event.veto),
    onRetry: (event) => recordProviderTurnRetry(event.options, event.nudged),
    onBackoff: (event) => {
      const httpStatus = exchange.httpStatus ?? exchange.streamError?.status;
      const notice: ProviderRetryNotice = {
        ...event,
        ...(httpStatus === undefined ? {} : { httpStatus }),
      };
      for (const listener of retryBackoffListeners) {
        // A progress display must never end a turn the replay could still recover.
        try {
          listener(notice);
        } catch {
          retryBackoffListeners.delete(listener);
        }
      }
    },
    onBlankTurn: (event) => {
      recordProviderBlankTurn(event.options);
      if (!event.replayed) return;
      discarded.turns += 1;
      discarded.inputTokens += event.usage.inputTokens;
      discarded.outputTokens += event.usage.outputTokens;
    },
  });
  const governedProviderStream = createContextBudgetedStream(
    config,
    retryingProviderStream,
    turnGovernance,
    physicalAttempts,
  );
  // The governor and step ledger can refuse a turn before any physical request
  // starts, so the previous turn's exchange must not survive into it.
  runtime.streamSimple = (model, context, options) => {
    exchange = { sent: false };
    bodyReceived = false;
    proxyRefusal = undefined;
    credentialRefusal = undefined;
    responseLimitRefusal = undefined;
    // A late body error from a prior turn can no longer bind to a request that
    // has not started in this one. The fetch-local sequence is always positive.
    latestProviderRequestSequence = 0;
    return governedProviderStream(model, context, options);
  };

  const model = runtime.getModel(config.providerId, config.modelId);
  if (!model) {
    throw new Error(`Pi did not register model ${config.providerId}/${config.modelId}.`);
  }

  return {
    runtime,
    model,
    reportUsageCost: hasReportableUsageCost(config),
    providerResponses,
    providerRequests: () => requestObservations.map((observation) => ({ ...observation })),
    physicalProviderAttempts: {
      spent: () => physicalAttempts.spent(),
      remaining: () => physicalAttempts.remaining(),
      refusal: () => physicalAttempts.refusal(),
    },
    providerTransport: {
      lastExchange: () => ({
        ...exchange,
        ...(bodyReceived ? { bodyReceived: true as const } : {}),
      }),
      lastProxyRefusal: () => proxyRefusal,
      lastCredentialRefusal: () => credentialRefusal,
      lastResponseLimitRefusal: () => responseLimitRefusal,
      onRetryBackoff: (listener) => {
        retryBackoffListeners.add(listener);
        return () => retryBackoffListeners.delete(listener);
      },
    },
    discardedProviderUsage: {
      drain: () => {
        const observed: DiscardedProviderTurnUsage = { ...discarded };
        discarded.turns = 0;
        discarded.inputTokens = 0;
        discarded.outputTokens = 0;
        return observed;
      },
    },
    ...(turnGovernance
      ? {
          turnGovernance: {
            maxToolCalls: turnGovernance.policy.maxToolCalls,
            evidence: () => structuredClone(turnGovernance.ledger),
          },
        }
      : {}),
  };
}

function finalizeProviderPayload(
  rawPayload: unknown,
  exactCredential: string,
  transport: ProviderTransport,
  maxOutputTokens: number,
  laneRules: {
    readonly disableThinking: boolean;
    readonly reasoningControl?: InstalledReasoningControl;
    /** The operator's reasoning effort; never sent with thinking off. */
    readonly reasoningEffort?: string;
  },
): {
  payload: Readonly<Record<string, unknown>>;
  requestPolicySha256?: string;
  finalPayloadSha256: string;
} {
  let serialized: string;
  let payload: unknown;
  try {
    serialized = JSON.stringify(rawPayload);
    payload = JSON.parse(serialized);
  } catch {
    throw new ProviderRequestPolicyError("payload-shape", "not JSON data");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ProviderRequestPolicyError("payload-shape", "not an object");
  }
  const payloadRecord = payload as Record<string, unknown>;
  if (
    transport === "openai-chat-completions" &&
    payloadRecord.max_tokens !== undefined &&
    payloadRecord.max_completion_tokens !== undefined
  ) {
    throw new ProviderRequestPolicyError("output-limit", "max_tokens and max_completion_tokens");
  }
  const outputTokens =
    transport === "openai-responses"
      ? payloadRecord.max_output_tokens
      : transport === "openai-chat-completions"
        ? (payloadRecord.max_tokens ?? payloadRecord.max_completion_tokens)
        : payloadRecord.max_tokens;
  if (
    !Number.isSafeInteger(outputTokens) ||
    Number(outputTokens) < 1 ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < 1 ||
    Number(outputTokens) > maxOutputTokens
  ) {
    throw new ProviderRequestPolicyError("output-limit");
  }
  assertModelRequestCredentialFree(payload);
  if (serialized.includes(exactCredential)) throw new CredentialBoundaryError("model-request");
  assertToolHistoryCarriesTools(payloadRecord);
  if (laneRules.reasoningControl && transport === "openai-chat-completions") {
    applyReasoningControl(payloadRecord, laneRules.reasoningControl);
  }
  if (laneRules.disableThinking) {
    // Any `reasoning_effort` an earlier hook left is removed: on this route
    // "none" is inert and "low" was observed to be refused with a 408.
    delete payloadRecord.reasoning_effort;
    payloadRecord.thinking = { type: "disabled" };
  } else if (laneRules.reasoningEffort) {
    applyReasoningEffort(payloadRecord, transport, laneRules.reasoningEffort);
  }
  const frozen = deepFreeze(payload as Record<string, unknown>);
  return {
    payload: frozen,
    finalPayloadSha256: canonicalDigest(frozen),
  };
}

/**
 * Send the operator's reasoning effort, exactly as recorded, in the field the
 * transport reads: `reasoning_effort`, `reasoning.effort`, or, beside
 * adaptive thinking, `output_config.effort`.
 */
function applyReasoningEffort(
  payload: Record<string, unknown>,
  transport: ProviderTransport,
  effort: string,
): void {
  const nested = (field: string, value: string): void => {
    const existing = payload[field];
    payload[field] =
      existing && typeof existing === "object" && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>), effort: value }
        : { effort: value };
  };
  if (transport === "openai-chat-completions") {
    payload.reasoning_effort = effort;
  } else if (transport === "openai-responses") {
    nested("reasoning", effort);
  } else {
    const thinking = payload.thinking as { type?: unknown } | undefined;
    if (thinking?.type === "adaptive") {
      nested("output_config", anthropicEffort(effort as ReasoningEffortLevel));
    }
  }
}

/**
 * Name the installed request policy's refusal on the governed turn it stopped,
 * so the attempt is classified by the refusal's own code. Only a
 * `ProviderRequestPolicyError` is recorded; a lease or credential refusal
 * thrown through the same hooks names itself. Written once per turn: the
 * refusal ends the turn, and a refused request is never replayed.
 *
 * An unsealed entry issued no request. A sealed entry was refused while a
 * replay was finalized (`payload-authority`, before the replay was promoted
 * into `providerRetries`), or by the send gate: `payload-send` after promotion
 * and before sending, `payload-resend` for a second call after the send.
 */
function recordRequestPolicyRefusal(pending: PendingFinalTurn, error: unknown): void {
  if (!(error instanceof ProviderRequestPolicyError)) return;
  const finalized = pending.finalized;
  // Only a reason the record readers admit for this row is written, so a
  // refusal on an unexpected phase never makes the record unreadable; the
  // attempt then reads as uncoded rather than as a corrupt record.
  if (!isAdmissibleRequestPolicyRefusal(error.refusal, finalized !== undefined)) return;
  if (finalized) {
    // Never throw from here: the caller is rethrowing the refusal itself.
    if (finalized.requestPolicyRefusal || !pending.governance.ledger.includes(finalized)) return;
    // Counters are not refreshed: `providerRetries` keeps counting promoted
    // requests, and a `payload-send` refusal names the promoted one never sent.
    writeTurnEvidence(pending, { ...finalized, requestPolicyRefusal: error.refusal }, {});
    return;
  }
  if (pending.evidence.requestPolicyRefusal) return;
  const index = pending.governance.ledger.indexOf(pending.evidence);
  if (index < 0) return;
  const refused: InferenceTurnEvidence = {
    ...pending.evidence,
    requestPolicyRefusal: error.refusal,
  };
  pending.governance.ledger[index] = refused;
  pending.evidence = refused;
}

/**
 * Per-request record of whether DocsFab itself refused the outbound call.
 * Keyed by the exact stream-options object, which the retry wrapper reuses for
 * every attempt of one governed turn.
 */
interface LocalRejectionRecord {
  rejected: boolean;
  /** Retry-After observed on the last non-2xx response, if any. */
  retryAfterMs?: number;
}

const LOCAL_REJECTIONS = new WeakMap<object, LocalRejectionRecord>();

function resetLocalRejection(options: unknown): LocalRejectionRecord | undefined {
  if (!options || typeof options !== "object") return undefined;
  const existing = LOCAL_REJECTIONS.get(options);
  if (existing) {
    existing.rejected = false;
    delete existing.retryAfterMs;
    return existing;
  }
  const record: LocalRejectionRecord = { rejected: false };
  LOCAL_REJECTIONS.set(options, record);
  return record;
}

/**
 * Parse an RFC 9110 Retry-After: delta-seconds or an HTTP-date. An unparsable or
 * non-positive value means no request, not an instant replay.
 */
function retryAfterMilliseconds(header: string | null): number | undefined {
  const raw = header?.trim();
  if (!raw) return undefined;
  const seconds = /^\d+$/u.test(raw) ? Number(raw) : (Date.parse(raw) - Date.now()) / 1000;
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.ceil(seconds * 1000);
}

function observedRetryAfterMs(options: unknown): number | undefined {
  return options && typeof options === "object"
    ? LOCAL_REJECTIONS.get(options)?.retryAfterMs
    : undefined;
}

function locallyRejected(options: unknown): boolean {
  return (
    !!options && typeof options === "object" && LOCAL_REJECTIONS.get(options)?.rejected === true
  );
}

/** DocsFab's own deterministic refusals. Replaying one cannot change its answer. */
function isLocalPolicyRejection(error: unknown): boolean {
  // Recognized by type, never by wording, so a provider body cannot pass for
  // DocsFab's own refusal. A proxy's 403 or 407 tunnel reply is read from
  // undici's fixed message by the proxy classifier, never from a response
  // body; it answers the same on replay. An unreachable proxy is a transport
  // fault and stays replayable.
  return (
    error instanceof ProviderRequestPolicyError ||
    error instanceof TaskBudgetError ||
    error instanceof CredentialBoundaryError ||
    error instanceof ProviderResponseLimitError ||
    error instanceof ProviderBoundaryRefusalError ||
    (error instanceof OutboundProxyRefusal && error.kind !== "unreachable")
  );
}

/**
 * Attribute one in-turn retry to its governed turn. A nudged replay also arms
 * the one-shot expectation that the next finalization's digest differs.
 */
function recordProviderTurnRetry(options: unknown, nudged = false): void {
  const pending = (options as { [FINAL_TURN_CONTEXT]?: PendingFinalTurn } | undefined)?.[
    FINAL_TURN_CONTEXT
  ];
  if (!pending) return;
  pending.retries += 1;
  if (nudged) pending.nudgedReplayPending = true;
}

/**
 * Record the boundary that refused a replay of this governed turn. This is a
 * counter revision, not a new request, so the published digests stay untouched.
 * A turn that never sealed a payload has no entry to revise; the step's own
 * failure names that refusal.
 */
function recordProviderReplayVeto(options: unknown, veto: ProviderTurnReplayVeto): void {
  const pending = (options as { [FINAL_TURN_CONTEXT]?: PendingFinalTurn } | undefined)?.[
    FINAL_TURN_CONTEXT
  ];
  if (!pending || pending.replayVeto) return;
  pending.replayVeto = veto;
  const finalized = pending.finalized;
  if (!finalized?.finalPayloadSha256) return;
  // Other counters are not refreshed: a replay a local refusal stopped inside
  // finalization never reached the transport, and `providerRetries` counts only
  // requests that did.
  writeTurnEvidence(pending, finalized, { providerReplayVeto: veto });
}

/**
 * Attribute one empty provider turn to its governed turn.
 *
 * The last empty turn of a streak arrives after the final payload hook ran, so
 * the count is written here or the turn that failed the step is missing from
 * the evidence. Only the blank counter is revised: a blank turn about to be
 * replayed arrives after `onRetry` incremented `retries`, and that replay has
 * not reached the transport yet. Its own finalization promotes it.
 */
function recordProviderBlankTurn(options: unknown): void {
  const pending = (options as { [FINAL_TURN_CONTEXT]?: PendingFinalTurn } | undefined)?.[
    FINAL_TURN_CONTEXT
  ];
  if (!pending) return;
  pending.blankTurns += 1;
  const finalized = pending.finalized;
  if (!finalized?.finalPayloadSha256) return;
  writeTurnEvidence(pending, finalized, { providerBlankTurns: pending.blankTurns });
}

/**
 * Proves the request the SDK sends is the payload the request policy authorized,
 * then sends the gate's own serialization of it.
 *
 * Anthropic's SDK sends `betas` as the `anthropic-beta` header, not in the
 * body, so on that transport the wire form is the authorized payload without
 * `betas`, and the header must be exactly those values joined by "," in order.
 * That move is the only accepted difference; the recorded payload digest stays
 * the authorized payload's, `betas` included.
 */
export function createPayloadSendGate(
  delegate: typeof globalThis.fetch,
  transport: ProviderTransport,
  turn: number | null = null,
): {
  authorize(payload: Readonly<Record<string, unknown>>, sha256: string): void;
  fail(): void;
  fetch: typeof globalThis.fetch;
} {
  let state: "waiting" | "authorized" | "consumed" | "failed" = "waiting";
  let wireSha256: string | undefined;
  let wireBody: string | undefined;
  // `null` is an absent header; only read on the Anthropic transport.
  let betaHeader: string | null = null;
  const fail = (): void => {
    if (state !== "consumed") state = "failed";
  };
  return {
    authorize(payload, sha256) {
      if (state !== "waiting") {
        // hygiene: ok -- a reason code; the constructor makes it a sentence.
        throw new ProviderRequestPolicyError(
          state === "consumed" ? "payload-resend" : "payload-send",
        );
      }
      const authorizedBody = JSON.stringify(payload);
      const authorized = JSON.parse(authorizedBody) as Record<string, unknown>;
      if (canonicalDigest(authorized) !== sha256) {
        state = "failed";
        throw new ProviderRequestPolicyError("payload-send", "payload-digest");
      }
      const betas = transport === "anthropic-messages" ? headerBetas(authorized.betas) : undefined;
      if (betas) {
        delete authorized.betas;
        wireBody = JSON.stringify(authorized);
        wireSha256 = canonicalDigest(authorized);
        betaHeader = betas.join(",");
      } else {
        wireBody = authorizedBody;
        wireSha256 = sha256;
        betaHeader = null;
      }
      state = "authorized";
    },
    fail,
    fetch: async (request, init) => {
      if (state !== "authorized" || !wireSha256 || wireBody === undefined) {
        // A second transport call for a payload already sent is a resend.
        const refusal = state === "consumed" ? "payload-resend" : "payload-send";
        state = "failed";
        throw new ProviderRequestPolicyError(refusal);
      }
      state = "consumed";
      const suppliedBody = await requestBody(request, init);
      let suppliedPayload: unknown;
      try {
        suppliedPayload = JSON.parse(suppliedBody);
      } catch {
        throw new ProviderRequestPolicyError("payload-send", "payload-send-shape");
      }
      if (
        canonicalDigest(suppliedPayload) !== wireSha256 ||
        (transport === "anthropic-messages" &&
          requestHeaders(request, init).get("anthropic-beta") !== betaHeader)
      ) {
        throw new ProviderRequestPolicyError("payload-send", "payload-send-mismatch");
      }
      const sentInit: RequestInit & { [REQUEST_TURN]?: number | null } = {
        ...init,
        body: wireBody,
      };
      if (turn !== null) sentInit[REQUEST_TURN] = turn;
      return delegate(request, sentInit);
    },
  };
}

/**
 * The authorized `betas` when the header form carries each one unchanged: a
 * non-empty list of non-empty values with no "," or whitespace, which would
 * split or merge values in the header. Anything else keeps `betas` in the
 * expected body, so the SDK's move refuses as a mismatch.
 */
function headerBetas(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.every((beta) => typeof beta === "string" && /^[^\s,]+$/u.test(beta))
    ? (value as string[])
    : undefined;
}

/** Fetch semantics: `init.headers` replaces a Request's headers when present. */
function requestHeaders(request: RequestInfo | URL, init?: RequestInit): Headers {
  if (init?.headers !== undefined) return new Headers(init.headers);
  return typeof Request !== "undefined" && request instanceof Request
    ? new Headers(request.headers)
    : new Headers();
}

async function requestBody(request: RequestInfo | URL, init?: RequestInit): Promise<string> {
  const body = init?.body;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
  if (typeof Request !== "undefined" && request instanceof Request) {
    return request.clone().text();
  }
  throw new ProviderRequestPolicyError("payload-send", "payload-send-shape");
}

function createActiveTurnGovernance(
  config: ModelExecutionBudgetProfile,
  options: ModelTurnGovernanceOptions,
): ActiveTurnGovernance {
  const conflictingAggregateLimits = ["maxProviderTurns", "maxToolCalls", "maxCompactions"].filter(
    (name) => options.limits?.[name as keyof typeof DEFAULT_TURN_GOVERNANCE_LIMITS] !== undefined,
  );
  if (options.aggregatePolicy?.kind === "absent" && conflictingAggregateLimits.length > 0) {
    throw new Error(
      `The absent aggregate policy cannot be combined with explicit limits: ${conflictingAggregateLimits.join(", ")}. Omit those limits or use the ordinary finite-policy route.`,
    );
  }
  const limits =
    options.aggregatePolicy?.kind === "absent"
      ? {
          minRecentToolTurns:
            options.limits?.minRecentToolTurns ?? DEFAULT_TURN_GOVERNANCE_LIMITS.minRecentToolTurns,
        }
      : { ...DEFAULT_TURN_GOVERNANCE_LIMITS, ...options.limits };
  return {
    evidenceIdentity: {
      repositoryRevision: options.evidenceIdentity.repositoryRevision,
      ...(options.evidenceIdentity.contextPacketDigest
        ? { contextPacketDigest: options.evidenceIdentity.contextPacketDigest }
        : {}),
      ...(options.evidenceIdentity.consultedNodeIds
        ? {
            consultedNodeIds: [...new Set(options.evidenceIdentity.consultedNodeIds)].sort(),
          }
        : {}),
      ...(options.evidenceIdentity.technicalVerificationSha256
        ? {
            technicalVerificationSha256: options.evidenceIdentity.technicalVerificationSha256,
          }
        : {}),
      ...(options.evidenceIdentity.authoringPhaseSha256
        ? { authoringPhaseSha256: options.evidenceIdentity.authoringPhaseSha256 }
        : {}),
    },
    policy: {
      budget: {
        configuredContextWindow: config.profile.configuredLimits.contextWindow,
        effectiveContextWindow: config.profile.contextWindow,
        configuredMaxInputTokens: config.profile.configuredLimits.maxInputTokens,
        effectiveMaxInputTokens: config.profile.maxInputTokens,
        configuredMaxOutputTokens: config.profile.configuredLimits.maxOutputTokens,
        effectiveMaxOutputTokens: config.profile.maxOutputTokens,
        reservedTokens: config.requestPolicy.reservedContextTokens,
        requiredMinimumOutputTokens: config.requestPolicy.minimumOutputTokens,
      },
      ...(config.contextAdmission === "provider" ? { skipHostContextAdmission: true } : {}),
      ...(options.aggregatePolicy ? { aggregatePolicy: options.aggregatePolicy } : {}),
      ...limits,
    },
    state: {
      providerTurns: 0,
      toolCalls: 0,
      toolResults: 0,
      compactions: 0,
    },
    ledger: [],
    ...(options.beforeProviderTurn ? { beforeProviderTurn: options.beforeProviderTurn } : {}),
    ...(options.outputAuthority ? { outputAuthority: options.outputAuthority } : {}),
  };
}

function observeTurnContext(
  context: TurnRequestContext,
  identity: InferenceEvidenceIdentity,
): {
  pinnedMessageCount: number;
  toolCalls: number;
  toolResults: number;
  toolEvidence: TurnToolEvidence[];
} {
  const calls: Array<{ id: string; name: string; citations: string[] }> = [];
  const results: Array<{
    id: string;
    name: string;
    failed: boolean;
    denied: boolean;
  }> = [];
  let toolCalls = 0;
  let toolResults = 0;
  let firstAssistant = -1;
  for (const [index, message] of context.messages.entries()) {
    const item = asRecord(message);
    if (!item) continue;
    if (item.role === "assistant") {
      if (firstAssistant < 0) firstAssistant = index;
      if (!Array.isArray(item.content)) continue;
      for (const block of item.content) {
        const call = asRecord(block);
        if (
          call?.type !== "toolCall" ||
          typeof call.id !== "string" ||
          typeof call.name !== "string"
        )
          continue;
        toolCalls += 1;
        calls.push({
          id: call.id,
          name: call.name,
          citations: toolCitations(call.arguments, identity),
        });
      }
    }
    if (
      item.role === "toolResult" &&
      typeof item.toolCallId === "string" &&
      typeof item.toolName === "string"
    ) {
      toolResults += 1;
      results.push({
        id: item.toolCallId,
        name: item.toolName,
        failed: item.isError === true,
        denied: item.isError === true && isDeniedToolResult(item),
      });
    }
  }
  const toolEvidence = calls.flatMap((call) => {
    if (calls.filter((candidate) => candidate.id === call.id).length !== 1) return [];
    const matchingResults = results.filter((result) => result.id === call.id);
    if (matchingResults.length !== 1 || matchingResults[0]!.name !== call.name) return [];
    const result = matchingResults[0]!;
    return [
      {
        toolCallId: call.id,
        toolName: call.name,
        outcome: result.denied
          ? ("denied" as const)
          : result.failed
            ? ("failed" as const)
            : ("succeeded" as const),
        citations: call.citations,
      },
    ];
  });
  return {
    pinnedMessageCount: firstAssistant < 0 ? context.messages.length : firstAssistant,
    toolCalls,
    toolResults,
    toolEvidence,
  };
}

function isDeniedToolResult(value: Record<string, unknown>): boolean {
  if (!Array.isArray(value.content)) return false;
  return value.content.some((block) => {
    const item = asRecord(block);
    // A host refusal may follow the sentence with its scope and remedy.
    const denied = "DocsFab denied the requested tool path.";
    return (
      item?.type === "text" &&
      typeof item.text === "string" &&
      (item.text === denied || item.text.startsWith(`${denied} `))
    );
  });
}

function toolCitations(value: unknown, identity: InferenceEvidenceIdentity): string[] {
  const arguments_ = asRecord(value);
  const path =
    typeof arguments_?.path === "string" ? safeRepositoryCitation(arguments_.path) : undefined;
  return [
    ...(path ? [path] : []),
    ...(identity.consultedNodeIds ?? []).map((nodeId) => `node:${nodeId}`),
  ]
    .filter((item, index, values) => values.indexOf(item) === index)
    .sort();
}

function safeRepositoryCitation(value: string): string | undefined {
  const normalized = value.replaceAll("\\", "/");
  const withoutPrefix = normalized.replace(/^\.\//u, "");
  if (
    !withoutPrefix ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(withoutPrefix) ||
    isAbsolute(normalized) ||
    /^[A-Za-z]:/u.test(withoutPrefix) ||
    withoutPrefix.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return undefined;
  }
  return withoutPrefix;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
