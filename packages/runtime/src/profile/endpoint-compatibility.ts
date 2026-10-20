// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Endpoint compatibility verdict for `docsfab profile probe --live` and
 * `docsfab doctor --live`: whether a serving route can run DocsFab's harness
 * shape (streamed chat completions, native tool calls, one JSON reply) inside
 * an output limit, with an owner, a cause, and one next action for every
 * failed check.
 *
 * Reply text stays in memory. The report carries closed findings and, for a
 * refused request, the provider's own message after credential, URL, contact,
 * and account-identifier redaction.
 */

import { limit } from "../config/limits.js";
import { jsonEnvelopeBody } from "../execution/json-envelope.js";
import { parseJsonEvidence } from "../json-evidence.js";
import { assertLocalhostEndpointResolvesToLoopback } from "../model/endpoint-transport.js";
import { OutboundProxyRefusal } from "../model/outbound-http-policy.js";
import { createProviderBoundaryFetch } from "../model/provider.js";
import { readProviderStreamErrorEvent } from "../model/provider-stream-error.js";
import { DOCSFAB_SYSTEM_PROMPT } from "../model/request-policy.js";
import { sanitizeDisplayText } from "../operator/error-envelope.js";
import {
  releaseModelCredential,
  type EndpointSource,
} from "../security/model-credential-release.js";
import {
  COMPATIBILITY_TOOL_NAME,
  probeCompatibility,
  providerErrorMessage,
  redactProviderText,
  type CompatibilityProbeObservation,
  type CompatibilityTurn,
  type ProbeProvider,
  type ProbeRequestShape,
  type StreamErrorEvent,
} from "./probe-core.js";

export const ENDPOINT_COMPATIBILITY_KIND = "docsfab-endpoint-compatibility";

export const COMPATIBILITY_CHECK_IDS = [
  "availability",
  "streaming",
  "tool-calls",
  "structured-output",
  "output-limit",
] as const;

export type CompatibilityCheckId = (typeof COMPATIBILITY_CHECK_IDS)[number];

/**
 * The causes this probe reports and the owner class each belongs to. The
 * strings match the diagnosis owner classes and cause vocabulary (Epic #1687),
 * so `docsfab why`, doctor, and the probe name one failure the same way.
 */
export const COMPATIBILITY_CAUSE_OWNERS = Object.freeze({
  "provider-rate-limited": "provider-capacity",
  "provider-server-error": "provider-capacity",
  "provider-stream-error": "provider-capacity",
  "provider-timeout": "provider-capacity",
  "output-allowance-reached": "output-limit",
  "reply-not-json": "contract-shape",
  "reply-shape-rejected": "contract-shape",
  "reply-content-rejected": "model-content",
  "reply-blank": "model-content",
  "provider-model-retired": "operator-configuration",
  "provider-auth-refused": "operator-configuration",
  "provider-request-refused": "operator-configuration",
  "request-not-sent": "operator-configuration",
  "operational-limit-reached": "operator-configuration",
  "uncatalogued-failure": "docsfab-defect",
} as const);

export type CompatibilityCause = keyof typeof COMPATIBILITY_CAUSE_OWNERS;

/** Who must act on a failed check. */
export type CompatibilityOwner = (typeof COMPATIBILITY_CAUSE_OWNERS)[CompatibilityCause];

export type CompatibilityStatus = "pass" | "fail" | "inconclusive" | "not-checked";

export type CompatibilityVerdict = "compatible" | "incompatible" | "inconclusive" | "not-checked";

export interface EndpointCompatibilityCheck {
  readonly id: CompatibilityCheckId;
  readonly status: CompatibilityStatus;
  /** Stable kebab-case finding. */
  readonly finding: string;
  readonly detail: string;
  readonly cause: CompatibilityCause | null;
  readonly owner: CompatibilityOwner | null;
  readonly nextAction: string | null;
  readonly httpStatus?: number;
  readonly providerMessage?: string;
  readonly providerMessageTruncated?: boolean;
}

export interface EndpointCompatibilityReport {
  readonly schemaVersion: 1;
  readonly kind: typeof ENDPOINT_COMPATIBILITY_KIND;
  readonly verdict: CompatibilityVerdict;
  readonly maxOutputTokens: number;
  readonly checks: readonly EndpointCompatibilityCheck[];
}

/** Where the output limit sent with the probe came from; it selects the fix. */
export type OutputLimitSource = "configured" | "probe-default";

export interface ClassifyOptions {
  readonly maxOutputTokens: number;
  readonly outputLimitSource: OutputLimitSource;
  /** Credential value; every run of it is removed from quoted provider text. */
  readonly credential?: string;
}

/** A refused request, as the availability check reads it. */
export interface ProviderRefusal {
  readonly status: number;
  readonly body: string;
  readonly bodyTruncated: boolean;
}

const RETIRED_MODEL_NEXT_ACTION =
  "Select a model the provider still serves: run `docsfab composition list`, then `docsfab setup --profile <composition-id>`.";
const CAPACITY_NEXT_ACTION = "Wait for provider capacity, then rerun the probe with --live.";

/** Thrown by the doctor live check when the endpoint cannot run DocsFab. */
export class EndpointCompatibilityError extends Error {
  public readonly code = "endpoint-incompatible" as const;
  public readonly nextAction: string;
  public readonly report: EndpointCompatibilityReport;

  public constructor(report: EndpointCompatibilityReport) {
    const failed = firstFailedCheck(report);
    super(
      failed
        ? `Endpoint compatibility: ${failed.id} failed (${failed.finding}). ${failed.detail}`
        : "Endpoint compatibility could not be established.",
    );
    this.name = "EndpointCompatibilityError";
    this.report = report;
    this.nextAction = failed?.nextAction ?? CAPACITY_NEXT_ACTION;
  }
}

export function firstFailedCheck(
  report: EndpointCompatibilityReport,
): EndpointCompatibilityCheck | undefined {
  return report.checks.find((check) => check.status === "fail");
}

const IDENTIFIER_LABEL =
  /\b(account|function|organization|org|team|request|instance|invocation|nca|project|user|tenant)(\s*(?:[_-]?id)?\s*[:=]?\s*)(['"]?)([A-Za-z0-9][A-Za-z0-9_-]{3,})\3/giu;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/gu;
// Control, format (bidi and zero-width), and line or paragraph separators.
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Single-line, control-free, credential-free, identifier-free provider text. */
export function sanitizeProviderMessage(value: string, credential?: string): string {
  const text = redactProviderText(
    value,
    credential,
    limit("endpointProbe.credentialEchoMinChars").value,
  )
    .replace(CONTROL, " ")
    .replace(EMAIL, "[redacted-email]")
    .replace(UUID, "[redacted-id]")
    // An unquoted plain word after a label is prose ("account cannot invoke");
    // a quoted value, a marked value (`:`, `=`, `id`), or a token with a digit,
    // underscore, or hyphen is an identifier.
    .replace(
      IDENTIFIER_LABEL,
      (match, label: string, separator: string, quote: string, token: string) =>
        quote === "" && !/[:=]|id/iu.test(separator) && !/[0-9_-]/u.test(token)
          ? match
          : `${label}${separator}${quote}[redacted-id]${quote}`,
    )
    .replace(/\s+/gu, " ")
    .trim();
  return sanitizeDisplayText(text).trim();
}

/** The provider's own sentence from an OpenAI, problem-details, or plain body. */
export const providerMessageOf: (body: string) => string = providerErrorMessage;

const END_OF_LIFE = /\bend[ -]of[ -]life\b|\bno longer (?:available|served|supported)\b/iu;
const OUTPUT_LIMIT_REFUSAL =
  /\bmax(?:imum)?[_ ](?:completion[_ ])?tokens?\b|\bcontext length\b|\bmaximum context\b/iu;

function pass(
  id: CompatibilityCheckId,
  finding: string,
  detail: string,
  extra: Partial<EndpointCompatibilityCheck> = {},
): EndpointCompatibilityCheck {
  return Object.freeze({
    id,
    status: "pass",
    finding,
    detail,
    cause: null,
    owner: null,
    nextAction: null,
    ...extra,
  });
}

function notChecked(
  id: CompatibilityCheckId,
  finding: string,
  detail: string,
): EndpointCompatibilityCheck {
  return Object.freeze({
    id,
    status: "not-checked",
    finding,
    detail,
    cause: null,
    owner: null,
    nextAction: null,
  });
}

function problem(
  id: CompatibilityCheckId,
  status: "fail" | "inconclusive",
  finding: string,
  detail: string,
  cause: CompatibilityCause,
  nextAction: string,
  extra: Partial<EndpointCompatibilityCheck> = {},
): EndpointCompatibilityCheck {
  return Object.freeze({
    id,
    status,
    finding,
    detail,
    cause,
    owner: COMPATIBILITY_CAUSE_OWNERS[cause],
    nextAction,
    ...extra,
  });
}

/** Classify a probe request that returned no usable response. */
export function classifyProviderRefusal(
  refusal: ProviderRefusal,
  options: Pick<ClassifyOptions, "credential" | "maxOutputTokens">,
  id: CompatibilityCheckId = "availability",
): EndpointCompatibilityCheck {
  const message = quotedProviderMessage(
    providerMessageOf(refusal.body),
    options.credential,
    refusal.bodyTruncated,
  );
  const quoted = message.providerMessage ?? "";
  const provider = {
    ...(refusal.status > 0 ? { httpStatus: refusal.status } : {}),
    ...message,
  };
  const fail = (
    finding: string,
    detail: string,
    cause: CompatibilityCause,
    nextAction: string,
  ): EndpointCompatibilityCheck =>
    problem(id, "fail", finding, detail, cause, nextAction, provider);
  const { status } = refusal;
  if (status === 0) {
    if (/^(?:AbortError|TimeoutError)\b/u.test(refusal.body)) {
      const timeoutMs = limit("endpointProbe.requestTimeoutMs").value;
      return fail(
        "timeout",
        `The endpoint did not answer within endpointProbe.requestTimeoutMs (${timeoutMs} ms).`,
        "provider-timeout",
        CAPACITY_NEXT_ACTION,
      );
    }
    if (/^ProviderResponseLimitError\b/u.test(refusal.body)) {
      return fail(
        "response-too-large",
        `The response exceeded compositionExecution.maxResponseBytes (${limit("compositionExecution.maxResponseBytes").value} bytes).`,
        "operational-limit-reached",
        "Lower the output token limit so the response fits compositionExecution.maxResponseBytes (a host override can only lower that bound), or select a model that answers within it, then rerun the probe with --live.",
      );
    }
    // The provider boundary's refusals keep the plain `Error` name and fixed sentences.
    if (
      /^Error: Provider response rejected because redirects are not allowed\b/u.test(refusal.body)
    ) {
      return fail(
        "redirected",
        "The request, with its credential, reached the configured endpoint, which answered with a redirect; DocsFab did not follow it.",
        "provider-request-refused",
        "Configure the base URL the endpoint serves directly, then rerun the probe with --live.",
      );
    }
    if (/^Error: Provider response rejected\b/u.test(refusal.body)) {
      return fail(
        "response-rejected",
        "The endpoint answered, but DocsFab's provider boundary rejected the response's framing.",
        "reply-shape-rejected",
        "Select a route that returns well-formed HTTP responses, then rerun the probe with --live.",
      );
    }
    if (/^Error: Provider request rejected\b/u.test(refusal.body)) {
      return fail(
        "boundary-refused",
        "DocsFab refused the request before it left the host: the URL left its configured origin or path, or plain HTTP pointed at a host that is not loopback.",
        "request-not-sent",
        "Configure the exact base URL the endpoint serves (HTTPS, or plain HTTP to loopback), then rerun the probe with --live.",
      );
    }
    return fail(
      "unreachable",
      "The endpoint could not be reached.",
      "request-not-sent",
      "Check the base URL and network access to the endpoint, then rerun the probe with --live.",
    );
  }
  if (status >= 300 && status < 400) {
    return fail(
      "redirected",
      `HTTP ${status}: the endpoint redirected the request; the probe does not follow redirects.`,
      "provider-request-refused",
      "Configure the base URL the endpoint serves directly, then rerun the probe with --live.",
    );
  }
  if (status === 410 || ((status === 404 || status === 400) && END_OF_LIFE.test(quoted))) {
    return fail(
      "end-of-life",
      `HTTP ${status}: the provider no longer serves this model.`,
      "provider-model-retired",
      RETIRED_MODEL_NEXT_ACTION,
    );
  }
  if (status === 404) {
    return fail(
      "model-not-found",
      "HTTP 404: this credential cannot invoke the model on this route. A route's model list can name ids the account cannot call.",
      "provider-request-refused",
      "Use a model id this credential can invoke on the route, then rerun the probe with --live.",
    );
  }
  if (status === 401 || status === 403) {
    return fail(
      "credential-rejected",
      `HTTP ${status}: the provider rejected the credential.`,
      "provider-auth-refused",
      "Export a valid credential for this route, then rerun the probe with --live.",
    );
  }
  if (status === 429) {
    return fail(
      "rate-limited",
      "HTTP 429: the provider refused the request for capacity.",
      "provider-rate-limited",
      CAPACITY_NEXT_ACTION,
    );
  }
  if (status >= 500) {
    return fail(
      "provider-unavailable",
      `HTTP ${status}: the provider failed to serve the request.`,
      "provider-server-error",
      CAPACITY_NEXT_ACTION,
    );
  }
  if (OUTPUT_LIMIT_REFUSAL.test(quoted)) {
    return fail(
      "output-limit-rejected",
      `HTTP ${status}: the endpoint refused an output limit of ${options.maxOutputTokens} tokens.`,
      "provider-request-refused",
      `Lower the output token limit to one the endpoint accepts, or select a model that accepts ${options.maxOutputTokens} output tokens.`,
    );
  }
  return fail(
    "request-rejected",
    `HTTP ${status}: the endpoint refused a streamed, tool-bearing chat-completions request.`,
    "provider-request-refused",
    "Select a route and model that accept OpenAI-compatible streamed chat completions with tools.",
  );
}

/** A sanitized provider message bounded by `endpointProbe.providerMessageMaxChars`. */
function quotedProviderMessage(
  text: string,
  credential: string | undefined,
  alreadyTruncated = false,
): Pick<EndpointCompatibilityCheck, "providerMessage" | "providerMessageTruncated"> {
  const maxChars = limit("endpointProbe.providerMessageMaxChars").value;
  const quoted = sanitizeProviderMessage(text, credential);
  if (quoted.length === 0) return {};
  const truncated = alreadyTruncated || quoted.length > maxChars;
  return {
    providerMessage: quoted.slice(0, maxChars),
    ...(truncated ? { providerMessageTruncated: true } : {}),
  };
}

function streamErrorCheck(
  event: StreamErrorEvent,
  credential: string | undefined,
): EndpointCompatibilityCheck {
  const observed = readProviderStreamErrorEvent(
    JSON.stringify({ error: { code: event.code, type: event.type } }),
  );
  const capacity =
    observed?.serverFault === true ||
    (observed?.status !== undefined && (observed.status === 429 || observed.status >= 500));
  return problem(
    "streaming",
    "fail",
    "stream-error-event",
    "HTTP 200, then the event stream carried a provider error instead of a completion.",
    capacity ? "provider-stream-error" : "provider-request-refused",
    capacity
      ? CAPACITY_NEXT_ACTION
      : "Correct the request settings the provider's error names, or select another route.",
    {
      ...(observed?.status !== undefined ? { httpStatus: observed.status } : {}),
      ...quotedProviderMessage(event.message, credential),
    },
  );
}

type AnsweredTurn = Extract<CompatibilityTurn, { ok: true }>;

function answered(turn: CompatibilityTurn | null): AnsweredTurn | undefined {
  return turn?.ok ? turn : undefined;
}

function streamingCheck(
  turns: readonly AnsweredTurn[],
  credential: string | undefined,
): EndpointCompatibilityCheck {
  for (const turn of turns) {
    if (turn.errorEvent) return streamErrorCheck(turn.errorEvent, credential);
    if (!turn.eventStream) {
      return problem(
        "streaming",
        "fail",
        "not-event-stream",
        "The endpoint answered a streamed request without server-sent events.",
        "reply-shape-rejected",
        "Select a route that streams chat completions as server-sent events; DocsFab always streams.",
      );
    }
    if (turn.finishReason === null && !turn.done) {
      return problem(
        "streaming",
        "fail",
        "unterminated-stream",
        "The event stream ended without a finish reason or [DONE].",
        "reply-shape-rejected",
        "Select a route whose event streams finish with a finish reason and [DONE].",
      );
    }
  }
  const events = turns.reduce((sum, turn) => sum + turn.events, 0);
  return pass(
    "streaming",
    "event-stream",
    `${turns.length} streamed ${turns.length === 1 ? "response" : "responses"}, ${events} events, each finished.`,
  );
}

function lengthCutCheck(
  id: "tool-calls" | "structured-output",
  options: ClassifyOptions,
): EndpointCompatibilityCheck {
  return problem(
    id,
    "inconclusive",
    "cut-by-output-limit",
    `finish_reason=length at an output limit of ${options.maxOutputTokens} tokens before the ${id === "tool-calls" ? "tool call" : "JSON reply"}; the cut hides whether the model can answer.`,
    "output-allowance-reached",
    outputLimitNextAction(options),
  );
}

function outputLimitNextAction(options: ClassifyOptions): string {
  return options.outputLimitSource === "configured"
    ? `Raise MODEL_MAX_OUTPUT_TOKENS above ${options.maxOutputTokens}, or select a model that finishes within it, then rerun docsfab doctor --live.`
    : `Select a model that finishes within ${options.maxOutputTokens} output tokens, or probe with docsfab doctor --live at the output limit your profile sets.`;
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value = parseJsonEvidence(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const TEXT_TOOL_CALL = new RegExp(
  `<tool_call>|<\\|python_tag\\|>|"name"\\s*:\\s*"${COMPATIBILITY_TOOL_NAME}"`,
  "u",
);

function toolCallsCheck(
  turn: AnsweredTurn | undefined,
  options: ClassifyOptions,
): EndpointCompatibilityCheck {
  if (!turn || turn.errorEvent) {
    return notChecked("tool-calls", "no-completion", "No completion to inspect.");
  }
  const call = turn.toolCalls[0];
  if (call) {
    if (call.name !== COMPATIBILITY_TOOL_NAME) {
      return problem(
        "tool-calls",
        "fail",
        "unknown-tool",
        "The model called a tool that was not offered.",
        "reply-content-rejected",
        "Select a model that calls only the tools DocsFab offers.",
      );
    }
    if (!parseObject(call.arguments)) {
      return problem(
        "tool-calls",
        "fail",
        "malformed-arguments",
        "The tool call's arguments are not one JSON object.",
        "reply-not-json",
        "Select a model whose tool-call arguments are one JSON object; DocsFab refuses other arguments.",
      );
    }
    return pass(
      "tool-calls",
      "native-tool-call",
      `Native tool call with JSON arguments (finish_reason=${turn.finishReason ?? "none"}).`,
    );
  }
  if (turn.finishReason === "length") return lengthCutCheck("tool-calls", options);
  if (TEXT_TOOL_CALL.test(turn.content)) {
    return problem(
      "tool-calls",
      "fail",
      "tool-call-in-text",
      "The model wrote the tool call as text; the endpoint returned no `tool_calls`.",
      "reply-shape-rejected",
      "Enable the endpoint's tool-call parser, or select a route that returns OpenAI `tool_calls`.",
    );
  }
  return problem(
    "tool-calls",
    "fail",
    "no-tool-call",
    `The model answered without a tool call (finish_reason=${turn.finishReason ?? "none"}).`,
    "reply-content-rejected",
    "Select a model that returns native OpenAI `tool_calls` when a tool is offered; DocsFab does not read tool calls from text.",
  );
}

function structuredOutputCheck(
  turn: CompatibilityTurn | null,
  options: ClassifyOptions,
): EndpointCompatibilityCheck {
  if (turn === null) {
    return notChecked(
      "structured-output",
      "not-requested",
      "Not requested: the tool-call request was refused.",
    );
  }
  if (!turn.ok) return classifyProviderRefusal(turn, options, "structured-output");
  if (turn.errorEvent) {
    return notChecked("structured-output", "no-completion", "No completion to inspect.");
  }
  const content = turn.content.trim();
  if (content.length === 0) {
    if (turn.finishReason === "length") return lengthCutCheck("structured-output", options);
    return turn.reasoningPresent
      ? problem(
          "structured-output",
          "fail",
          "reasoning-only-reply",
          "The reply text arrived in reasoning_content and content stayed empty.",
          "reply-blank",
          "Select a composition whose request policy disables reasoning for this model, or a model that answers in content.",
        )
      : problem(
          "structured-output",
          "fail",
          "empty-reply",
          "The reply carried no content.",
          "reply-blank",
          "Select a model that answers a JSON request in content.",
        );
  }
  const body = jsonEnvelopeBody(content);
  const value = parseObject(body);
  if (!value) {
    if (turn.finishReason === "length") return lengthCutCheck("structured-output", options);
    return problem(
      "structured-output",
      "fail",
      "malformed-json",
      "The reply is not one JSON document; DocsFab refuses such replies as invalid-json.",
      "reply-not-json",
      "Select a model that returns one JSON document when the contract asks for one.",
    );
  }
  if (value.result !== "ok" || !Array.isArray(value.checks)) {
    return problem(
      "structured-output",
      "fail",
      "contract-mismatch",
      "The reply is JSON but not the requested object.",
      "reply-shape-rejected",
      "Select a model that returns the exact JSON object a contract asks for.",
    );
  }
  return pass(
    "structured-output",
    body === content ? "json-document" : "json-document-wrapped",
    body === content
      ? "One JSON document, as requested."
      : "One JSON document inside a wrapper that DocsFab extracts.",
  );
}

function outputLimitCheck(
  turns: readonly AnsweredTurn[],
  options: ClassifyOptions,
): EndpointCompatibilityCheck {
  const finished = turns.filter((turn) => !turn.errorEvent);
  if (finished.length === 0) {
    return notChecked("output-limit", "no-completion", "No completion to inspect.");
  }
  const reasons = finished.map((turn) => turn.finishReason ?? "none").join(", ");
  const tokens = finished
    .map((turn) => turn.completionTokens)
    .filter((value): value is number => value !== null);
  const used = tokens.length > 0 ? `; most completion tokens ${Math.max(...tokens)}` : "";
  if (finished.some((turn) => turn.finishReason === "length")) {
    return problem(
      "output-limit",
      "fail",
      "length-cut",
      `finish_reason=length at an output limit of ${options.maxOutputTokens} tokens (finish reasons: ${reasons}${used}).`,
      "output-allowance-reached",
      outputLimitNextAction(options),
    );
  }
  return pass(
    "output-limit",
    "within-limit",
    `Finished within an output limit of ${options.maxOutputTokens} tokens (finish reasons: ${reasons}${used}).`,
  );
}

function verdictOf(checks: readonly EndpointCompatibilityCheck[]): CompatibilityVerdict {
  if (checks.some((entry) => entry.status === "fail")) return "incompatible";
  if (checks.every((entry) => entry.status === "pass")) return "compatible";
  if (checks.every((entry) => entry.status === "not-checked")) return "not-checked";
  return "inconclusive";
}

function report(
  checks: readonly EndpointCompatibilityCheck[],
  maxOutputTokens: number,
): EndpointCompatibilityReport {
  return Object.freeze({
    schemaVersion: 1,
    kind: ENDPOINT_COMPATIBILITY_KIND,
    verdict: verdictOf(checks),
    maxOutputTokens,
    checks: Object.freeze([...checks]),
  });
}

function notReached(id: CompatibilityCheckId, reason: string): EndpointCompatibilityCheck {
  return notChecked(id, "not-reached", reason);
}

/** A report for an endpoint whose first probe request was refused. */
export function refusedEndpointReport(
  refusal: ProviderRefusal,
  options: ClassifyOptions,
): EndpointCompatibilityReport {
  return report(
    [
      classifyProviderRefusal(refusal, options),
      ...COMPATIBILITY_CHECK_IDS.filter((id) => id !== "availability").map((id) =>
        notReached(id, "Not checked: the endpoint refused the request."),
      ),
    ],
    options.maxOutputTokens,
  );
}

/** A report for a transport the probe does not speak. */
export function notCheckedReport(
  reason: string,
  maxOutputTokens: number,
): EndpointCompatibilityReport {
  return report(
    COMPATIBILITY_CHECK_IDS.map((id) => notReached(id, reason)),
    maxOutputTokens,
  );
}

/** A report for a probe that failed inside DocsFab before it could classify the endpoint. */
function defectReport(maxOutputTokens: number): EndpointCompatibilityReport {
  return report(
    [
      problem(
        "availability",
        "fail",
        "probe-defect",
        "The probe failed inside DocsFab before it could classify the endpoint.",
        "uncatalogued-failure",
        "Report this DocsFab defect with the command you ran; the endpoint was not judged.",
      ),
      ...COMPATIBILITY_CHECK_IDS.filter((id) => id !== "availability").map((id) =>
        notReached(id, "Not checked: the probe failed inside DocsFab."),
      ),
    ],
    maxOutputTokens,
  );
}

export function classifyEndpointCompatibility(
  observation: CompatibilityProbeObservation,
  options: ClassifyOptions,
): EndpointCompatibilityReport {
  const { toolCall, structuredOutput } = observation;
  if (!toolCall.ok) return refusedEndpointReport(toolCall, options);
  const turns = [toolCall, answered(structuredOutput)].filter(
    (turn): turn is AnsweredTurn => turn !== undefined,
  );
  return report(
    [
      pass("availability", "served", `HTTP ${toolCall.status}.`, { httpStatus: toolCall.status }),
      streamingCheck(turns, options.credential),
      toolCallsCheck(toolCall, options),
      structuredOutputCheck(structuredOutput, options),
      outputLimitCheck(turns, options),
    ],
    options.maxOutputTokens,
  );
}

const STANDARD_TOKEN_FIELD_PROVIDERS = new Set([
  "zai",
  "zai-coding-cn",
  "together",
  "moonshotai",
  "moonshotai-cn",
  "cloudflare-ai-gateway",
  "nvidia",
  "ant-ling",
  "deepseek",
]);
const MAX_TOKENS_HOSTS = [
  "chutes.ai",
  "deepseek.com",
  "api.moonshot.",
  "gateway.ai.cloudflare.com",
  "api.together.ai",
  "api.together.xyz",
  "integrate.api.nvidia.com",
  "api.ant-ling.com",
  "api.z.ai",
  "open.bigmodel.cn",
];
const NON_STANDARD_HOSTS = [
  ...MAX_TOKENS_HOSTS,
  "cerebras.ai",
  "api.x.ai",
  "opencode.ai",
  "api.cloudflare.com",
];
const NON_STANDARD_PROVIDERS = new Set([
  ...STANDARD_TOKEN_FIELD_PROVIDERS,
  "cerebras",
  "xai",
  "opencode",
  "cloudflare-workers-ai",
]);

/**
 * The request shape DocsFab's chat-completions provider sends on an endpoint:
 * an installed request policy sends `max_tokens` and a system message;
 * otherwise the provider SDK picks the token field and `store` flag from the
 * endpoint, and the instruction role from the registered profile. Tests pin
 * this against the provider's real request per route kind.
 */
export function chatCompletionsProbeShape(input: {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly requestPolicy: boolean;
  readonly reasoning: boolean;
  readonly supportsDeveloperRole: boolean;
}): Required<ProbeRequestShape> {
  if (input.requestPolicy) {
    return { tokenField: "max_tokens", systemRole: "system", store: false };
  }
  const url = input.baseUrl.toLowerCase();
  const onHost = (hosts: readonly string[]): boolean => hosts.some((host) => url.includes(host));
  const maxTokens =
    STANDARD_TOKEN_FIELD_PROVIDERS.has(input.providerId) || onHost(MAX_TOKENS_HOSTS);
  const nonStandard = NON_STANDARD_PROVIDERS.has(input.providerId) || onHost(NON_STANDARD_HOSTS);
  return {
    tokenField: maxTokens ? "max_tokens" : "max_completion_tokens",
    systemRole: input.reasoning && input.supportsDeveloperRole ? "developer" : "system",
    store: !nonStandard,
  };
}

/**
 * The network boundary every probe request uses: the provider's origin
 * pinning, redirect refusal, loopback-only plain HTTP, and response bound.
 */
export function createProbeFetch(baseUrl: string): typeof globalThis.fetch {
  const base = new URL(baseUrl);
  return createProviderBoundaryFetch(baseUrl, undefined, {
    maxResponseBytes: limit("compositionExecution.maxResponseBytes").value,
    allowedRequestPath: `${base.pathname.replace(/\/+$/u, "")}/chat/completions`,
  });
}

/**
 * A probe fetch that keeps the first proxy refusal. The probe turns a thrown
 * request error into a status-0 observation, which would read as an
 * unreachable endpoint; a refusal sent nothing and has its own code and next
 * action, so the caller throws it instead. Every refusal kind is kept, and a
 * captured refusal throws even when a later request succeeded: invalid,
 * not-enabled, denied, and auth-required are deterministic for an origin, and
 * an unreachable proxy that recovers mid-probe still left a sample unmeasured.
 */
export interface ProxyRefusalCapture {
  readonly fetch: typeof globalThis.fetch;
  /** Throws the first captured refusal; returns when there was none. */
  throwIfRefused(): void;
}

export function captureProxyRefusal(send: typeof globalThis.fetch): ProxyRefusalCapture {
  let refusal: OutboundProxyRefusal | undefined;
  return {
    fetch: async (input, init) => {
      try {
        return await send(input, init);
      } catch (error) {
        if (error instanceof OutboundProxyRefusal) refusal ??= error;
        throw error;
      }
    },
    throwIfRefused() {
      if (refusal) throw refusal;
    },
  };
}

export interface EndpointProbeTarget {
  readonly modelId: string;
  readonly baseUrl: string;
  /** Where `baseUrl` came from; absent is unlabelled operator configuration. */
  readonly endpointSource?: EndpointSource;
  readonly apiKey: string;
  readonly maxOutputTokens: number;
  readonly outputLimitSource: OutputLimitSource;
  readonly shape: Required<ProbeRequestShape>;
  readonly extraBody?: Record<string, unknown>;
  readonly finalizeBody?: (body: Record<string, unknown>) => Record<string, unknown>;
}

export type CompatibilityProbe = typeof probeCompatibility;

/**
 * Probe one endpoint live and classify the result. A plain-HTTP `localhost`
 * that does not resolve only to loopback is refused before any request.
 */
export async function probeEndpointCompatibility(
  target: EndpointProbeTarget,
  probe: CompatibilityProbe = probeCompatibility,
): Promise<EndpointCompatibilityReport> {
  // Released before anything is sent, outside the catch below that reports a probe defect.
  const credential = releaseModelCredential(
    { endpoint: target.baseUrl, endpointSource: target.endpointSource, apiKey: target.apiKey },
    "endpoint-probe",
  );
  await assertLocalhostEndpointResolvesToLoopback(target.baseUrl);
  const provider: ProbeProvider = { baseUrl: target.baseUrl, credential };
  // An endpoint the boundary does not admit is refused here, not reported as a probe defect.
  const capture = captureProxyRefusal(createProbeFetch(target.baseUrl));
  let observation: CompatibilityProbeObservation;
  try {
    observation = await probe(target.modelId, provider, {
      ...target.shape,
      fetch: capture.fetch,
      maxTokens: target.maxOutputTokens,
      systemPrompt: DOCSFAB_SYSTEM_PROMPT,
      timeoutMs: limit("endpointProbe.requestTimeoutMs").value,
      errorBodyMaxChars: limit("endpointProbe.providerMessageMaxChars").value,
      credentialEchoMinChars: limit("endpointProbe.credentialEchoMinChars").value,
      ...(target.extraBody ? { extraBody: target.extraBody } : {}),
      ...(target.finalizeBody ? { finalizeBody: target.finalizeBody } : {}),
    });
  } catch {
    // Transport failures return as refusals inside the probe; a throw here is
    // ours, unless a proxy refusal came first: that names the real cause.
    capture.throwIfRefused();
    return defectReport(target.maxOutputTokens);
  }
  capture.throwIfRefused();
  return classifyEndpointCompatibility(observation, {
    maxOutputTokens: target.maxOutputTokens,
    outputLimitSource: target.outputLimitSource,
    credential: target.apiKey,
  });
}

/** Human lines for a report, indented under a caller's heading. */
export function formatEndpointCompatibility(
  compatibility: EndpointCompatibilityReport,
  indent = "  ",
): string[] {
  const lines = [
    `Endpoint compatibility: ${compatibility.verdict} (max output tokens ${compatibility.maxOutputTokens})`,
  ];
  for (const entry of compatibility.checks) {
    lines.push(`${indent}${entry.id}: ${entry.status} (${entry.finding}). ${entry.detail}`);
    if (entry.providerMessage) {
      lines.push(
        `${indent}${indent}Provider said: "${entry.providerMessage}"${entry.providerMessageTruncated ? " (truncated)" : ""}`,
      );
    }
    if (entry.owner) lines.push(`${indent}${indent}Owner: ${entry.owner} (cause ${entry.cause})`);
    if (entry.nextAction) lines.push(`${indent}${indent}Next action: ${entry.nextAction}`);
  }
  return lines;
}
