// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal, sanitized run records shaped like the thirteen hosted Nemotron runs
 * of September 30, 2026: the same steps, attempt outcomes, rejection codes,
 * parse codes, finish reasons, token counts, provider error classes, and HTTP
 * statuses the run index held for them, plus each attempt's whole-attempt
 * output total and turn stop reasons, which only the saved record keeps. Run
 * IDs are synthetic; records carry no repository path, credential, message,
 * or model prose.
 */

const COMPATIBLE = "operator-configured-openai-compatible";
const CATALOG = "nvidia-api-catalog";
const NANO = "nvidia/nemotron-3-nano-30b-a3b";
const SUPER = "nvidia/nemotron-3-super-120b-a12b";
const OMNI = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
const ULTRA = "nvidia/nemotron-3-ultra-550b-a55b";

type Json = Record<string, unknown>;

interface AttemptSpec {
  readonly outcome: string;
  readonly finishReason?: string;
  readonly outputTokens?: number;
  readonly allowance?: number;
  readonly providerError?: { readonly class: string; readonly httpStatus?: number };
  readonly rejection?: { readonly code: string; readonly location: string };
  readonly parse?: "parsed" | "unexpected-token" | "unexpected-end";
  /** No model and no telemetry: the request never left DocsFab. */
  readonly unsent?: boolean;
  readonly retryDecision?: string;
  /** Output tokens over the whole attempt; defaults to the last turn's. */
  readonly attemptOutput?: number;
  /** Provider stop reason of each turn; defaults to one turn with the finish reason. */
  readonly turnStops?: readonly string[];
}

const RAW_STOP: Readonly<Record<string, string>> = { stop: "stop", length: "length" };

function attempt(
  number: number,
  model: { readonly provider: string; readonly model: string },
  spec: AttemptSpec,
): Json {
  const telemetry: Json | undefined = spec.unsent
    ? undefined
    : {
        schemaVersion: 1,
        providerLatencyMs: 1000,
        ...(spec.finishReason !== undefined ? { finishReason: spec.finishReason } : {}),
        ...(spec.outputTokens !== undefined ? { outputTokens: spec.outputTokens } : {}),
        ...(spec.allowance !== undefined ? { outputAllowance: spec.allowance } : {}),
        ...(spec.providerError !== undefined ? { providerError: spec.providerError } : {}),
      };
  return {
    attempt: number,
    outcome: spec.outcome,
    retryable: false,
    durationMs: 10,
    ...(spec.unsent ? {} : { model }),
    ...(telemetry ? { modelTelemetry: telemetry } : {}),
    ...(spec.rejection ? { rejection: spec.rejection } : {}),
    ...(spec.parse === "parsed"
      ? { rejectedReplyShape: { parse: { status: "parsed" } } }
      : spec.parse
        ? {
            rejectedReplyShape: {
              parse: { status: "failed", code: "malformed-json", detail: spec.parse },
            },
          }
        : {}),
    ...(spec.retryDecision ? { retryDecision: spec.retryDecision } : {}),
    ...(spec.attemptOutput !== undefined || spec.outputTokens !== undefined
      ? { usage: { output: spec.attemptOutput ?? spec.outputTokens } }
      : {}),
    ...(spec.unsent ? {} : { turns: turnsOf(spec) }),
  };
}

function turnsOf(spec: AttemptSpec): Json[] {
  const stops =
    spec.turnStops ??
    (spec.finishReason !== undefined && RAW_STOP[spec.finishReason] !== undefined
      ? [RAW_STOP[spec.finishReason]!]
      : []);
  // A continuation issues no tool call and nothing is compacted, so both
  // ledger counters stay level, as the harness records them.
  return stops.map((rawStopReason, index) => ({
    turn: index + 1,
    toolCalls: 0,
    compactions: 0,
    decision: "proceed",
    rawStopReason,
    ...(spec.allowance !== undefined ? { requestedOutputTokens: spec.allowance } : {}),
  }));
}

function step(
  id: string,
  status: "succeeded" | "failed",
  model: { readonly provider: string; readonly model: string },
  attempts: readonly AttemptSpec[],
): Json {
  return {
    id,
    status,
    skill: id,
    inference: { attempts: attempts.map((spec, index) => attempt(index + 1, model, spec)) },
  };
}

function record(id: string, createdAt: string, steps: readonly Json[]): Json {
  return {
    schemaVersion: 2,
    id,
    workflow: "review-documentation",
    status: "failed",
    createdAt,
    steps,
  };
}

const ok = (outputTokens: number, allowance = 4096): AttemptSpec => ({
  outcome: "succeeded",
  finishReason: "stop",
  outputTokens,
  allowance,
});
const streamError: AttemptSpec = {
  outcome: "provider-terminal",
  finishReason: "error",
  allowance: 4096,
  providerError: { class: "unknown" },
};
const boundary: AttemptSpec = {
  outcome: "provider-transient",
  finishReason: "error",
  allowance: 8192,
  retryDecision: "retried",
};
const notJson = (outputTokens: number, allowance: number, code = "malformed-json") =>
  ({
    outcome: "malformed-response",
    finishReason: "stop",
    outputTokens,
    allowance,
    rejection: { code, location: code === "invalid-json" ? "$" : "$response" },
    parse: "unexpected-token",
  }) satisfies AttemptSpec;

const compatible = (model: string) => ({ provider: COMPATIBLE, model });
const catalog = (model: string) => ({ provider: CATALOG, model });

/** The expected terminal owner and cause of each fixture run. */
export const NIM_FIXTURE_EXPECTATIONS = Object.freeze({
  "nim-nano-retired": { ownerClass: "operator-configuration", cause: "provider-model-retired" },
  "nim-super-stream-a": { ownerClass: "provider-capacity", cause: "provider-stream-error" },
  "nim-super-stream-b": { ownerClass: "provider-capacity", cause: "provider-stream-error" },
  "nim-endpoint-refused": { ownerClass: "operator-configuration", cause: "request-not-sent" },
  "nim-super-stream-c": { ownerClass: "provider-capacity", cause: "provider-stream-error" },
  "nim-super-stream-verify": { ownerClass: "provider-capacity", cause: "provider-stream-error" },
  "nim-super-stream-audit": { ownerClass: "provider-capacity", cause: "provider-stream-error" },
  "nim-omni-stream": { ownerClass: "provider-capacity", cause: "provider-stream-error" },
  "nim-super-not-json": { ownerClass: "output-limit", cause: "reply-continued-over-allowance" },
  "nim-omni-content": { ownerClass: "model-content", cause: "reply-content-rejected" },
  "nim-ultra-truncated": { ownerClass: "output-limit", cause: "output-allowance-reached" },
  "nim-super-composition": { ownerClass: "docsfab-defect", cause: "boundary-refusal" },
  "nim-ultra-composition": { ownerClass: "contract-shape", cause: "reply-not-json" },
} as const);

export function nimFixtureRecords(): Json[] {
  const superModel = compatible(SUPER);
  const omni = compatible(OMNI);
  return [
    record("nim-nano-retired", "2026-09-30T13:00:18.304Z", [
      step("audit-documentation", "failed", compatible(NANO), [
        {
          outcome: "invalid-request",
          finishReason: "error",
          allowance: 4096,
          providerError: { class: "invalid-request", httpStatus: 410 },
        },
      ]),
    ]),
    record("nim-super-stream-a", "2026-09-30T13:03:18.159Z", [
      step("audit-documentation", "succeeded", superModel, [ok(868)]),
      step("derive-source-obligations", "failed", superModel, [streamError]),
    ]),
    record("nim-super-stream-b", "2026-09-30T13:07:09.880Z", [
      step("audit-documentation", "succeeded", superModel, [ok(2214)]),
      step("derive-source-obligations", "failed", superModel, [streamError]),
    ]),
    record("nim-endpoint-refused", "2026-09-30T13:08:43.256Z", [
      step("audit-documentation", "failed", superModel, [
        { outcome: "provider-terminal", unsent: true },
      ]),
    ]),
    record("nim-super-stream-c", "2026-09-30T13:09:03.136Z", [
      step("audit-documentation", "succeeded", superModel, [ok(888)]),
      step("derive-source-obligations", "failed", superModel, [streamError]),
    ]),
    record("nim-super-stream-verify", "2026-09-30T13:10:52.492Z", [
      step("audit-documentation", "succeeded", superModel, [ok(3417)]),
      step("derive-source-obligations", "succeeded", superModel, [ok(197)]),
      step("provisional-technical-verification", "succeeded", superModel, [
        {
          outcome: "malformed-response",
          finishReason: "stop",
          outputTokens: 2044,
          allowance: 4096,
          rejection: { code: "invalid-accounting", location: "$response" },
          parse: "parsed",
        },
        { outcome: "succeeded", finishReason: "length", outputTokens: 4096, allowance: 4096 },
      ]),
      step("verify-technical-accuracy", "failed", superModel, [streamError]),
    ]),
    record("nim-super-stream-audit", "2026-09-30T13:16:09.252Z", [
      step("audit-documentation", "failed", superModel, [streamError]),
    ]),
    record("nim-omni-stream", "2026-09-30T13:16:42.505Z", [
      step("audit-documentation", "succeeded", omni, [ok(3350)]),
      step("derive-source-obligations", "succeeded", omni, [ok(4135)]),
      step("provisional-technical-verification", "succeeded", omni, [{ outcome: "succeeded" }]),
      step("verify-technical-accuracy", "succeeded", omni, [{ outcome: "succeeded" }]),
      step("review-documentation", "failed", omni, [streamError]),
    ]),
    record("nim-super-not-json", "2026-09-30T15:49:13.148Z", [
      step("audit-documentation", "succeeded", superModel, [ok(3399)]),
      step("derive-source-obligations", "succeeded", superModel, [ok(1412)]),
      step("provisional-technical-verification", "succeeded", superModel, [ok(3290)]),
      step("verify-technical-accuracy", "succeeded", superModel, [ok(669)]),
      { id: "lint-documentation", status: "succeeded", skill: "lint-documentation" },
      step("review-documentation", "failed", superModel, [
        {
          ...notJson(2266, 4096, "invalid-json"),
          retryDecision: "declined-host-refusal",
          // Cut at 4,096, continued once, and the stitched reply still refused.
          attemptOutput: 7062,
          turnStops: ["length", "stop"],
        },
      ]),
    ]),
    record("nim-omni-content", "2026-09-30T15:59:25.649Z", [
      step("audit-documentation", "succeeded", omni, [ok(2940)]),
      step("derive-source-obligations", "failed", omni, [
        notJson(402, 4096),
        {
          outcome: "malformed-response",
          finishReason: "stop",
          outputTokens: 3403,
          allowance: 4096,
          rejection: { code: "inconsistent-status", location: "$.dimensions[].status" },
          parse: "parsed",
        },
        {
          outcome: "malformed-response",
          finishReason: "stop",
          outputTokens: 9608,
          allowance: 4096,
          rejection: { code: "malformed-json", location: "$response" },
          parse: "unexpected-end",
        },
        {
          outcome: "malformed-response",
          finishReason: "stop",
          outputTokens: 2955,
          allowance: 4096,
          rejection: { code: "inconsistent-status", location: "$.dimensions[].status" },
          parse: "parsed",
          retryDecision: "exhausted",
        },
      ]),
    ]),
    record("nim-ultra-truncated", "2026-09-30T16:06:30.775Z", [
      step("audit-documentation", "failed", compatible(ULTRA), [
        {
          outcome: "malformed-response",
          finishReason: "length",
          outputTokens: 4096,
          allowance: 4096,
          rejection: { code: "text-truncated", location: "$response" },
        },
      ]),
    ]),
    record("nim-super-composition", "2026-09-30T16:11:55.957Z", [
      step("audit-documentation", "failed", catalog(SUPER), [
        boundary,
        boundary,
        boundary,
        boundary,
      ]),
    ]),
    record("nim-ultra-composition", "2026-09-30T16:12:27.625Z", [
      step("audit-documentation", "succeeded", catalog(ULTRA), [
        boundary,
        boundary,
        boundary,
        ok(287, 8192),
      ]),
      step("derive-source-obligations", "failed", catalog(ULTRA), [
        boundary,
        notJson(1628, 8192),
        notJson(1771, 8192),
        notJson(1484, 8192),
      ]),
    ]),
  ];
}
