// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Shared fixtures for the tool-call answer path (#1707): raw-string chunked
// SSE tool calls, a PiHarness bound to a route that recorded an answer
// submission, and the final quality evaluator's step input.

import { resolve } from "node:path";

import { vi } from "vitest";

import type { HarnessStepInput } from "../../src/execution/contracts.js";
import { QUALITY_SUBMISSION_TOOL_NAME } from "../../src/harness/answer-submission.js";
import type { InstalledAnswerSubmission } from "../../src/model-composition/types.js";
import {
  type PiHarnessOptions,
  boundStyleContext,
  canonicalDigest,
  createProviderConnectionFactory,
  fixtureCompositionExecutionProfile,
  PiHarness,
  projectRoot,
  skillCrateDirectory,
  sseResponse,
  stepInput,
  validModelConfig,
  verificationResultFixture,
  verifyQualityPackContext,
} from "./pi-harness-session-fixtures.js";

/** Run admission resolves the bound style profile once; every harness here reads it. */
const styleContext = await boundStyleContext();

export const SUBMIT = QUALITY_SUBMISSION_TOOL_NAME;

/** The capability a GO probe would record; the digest is a fixture value. */
export const RECORDED_CAPABILITY: InstalledAnswerSubmission = Object.freeze({
  kind: "host-tool-call",
  argumentShell: "untyped",
  duplicateKeys: "forwarded",
  reportTurnToolChoice: "none",
  evidenceSha256: "e".repeat(64),
});

/** One tool call whose argument text arrives as these raw string fragments. */
export interface RawToolCall {
  readonly id: string;
  readonly name: string;
  readonly chunks: readonly string[];
}

const chunk = (created: number, delta: Record<string, unknown>, finish: string | null = null) => ({
  id: "completion-raw-tool-turn",
  object: "chat.completion.chunk",
  created,
  model: validModelConfig.modelId,
  choices: [{ index: 0, delta, finish_reason: finish }],
});

/**
 * An assistant turn whose tool calls stream their arguments as the given raw
 * fragments, never `JSON.stringify` of an object, so a duplicate key, a raw
 * line break, or trailing text reaches the host exactly as written.
 */
export function rawToolCallTurn(
  calls: readonly RawToolCall[],
  options: {
    readonly finishReason?: "tool_calls" | "length";
    readonly preamble?: string;
    readonly usage?: Record<string, number>;
    readonly created?: number;
  } = {},
): Response {
  const created = options.created ?? 1;
  const events: object[] = [];
  calls.forEach((call, index) => {
    call.chunks.forEach((fragment, position) => {
      events.push(
        chunk(created, {
          ...(index === 0 && position === 0
            ? { role: "assistant", ...(options.preamble ? { content: options.preamble } : {}) }
            : {}),
          tool_calls: [
            {
              index,
              ...(position === 0 ? { id: call.id, type: "function" } : {}),
              function: {
                ...(position === 0 ? { name: call.name } : {}),
                arguments: fragment,
              },
            },
          ],
        }),
      );
    });
  });
  events.push({
    ...chunk(created, {}, options.finishReason ?? "tool_calls"),
    usage: options.usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  return sseResponse(events);
}

/** A submission call whose raw argument text is split into `parts` fragments. */
export function submissionCall(id: string, raw: string, parts = 3): RawToolCall {
  const size = Math.max(1, Math.ceil(raw.length / parts));
  const chunks: string[] = [];
  for (let start = 0; start < raw.length; start += size)
    chunks.push(raw.slice(start, start + size));
  return { id, name: SUBMIT, chunks: chunks.length > 0 ? chunks : [""] };
}

/** A text turn streamed as several fragments. */
export function chunkedTextTurn(
  fragments: readonly string[],
  finishReason: "stop" | "length" = "stop",
  usage: Record<string, number> = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
): Response {
  return sseResponse([
    ...fragments.map((content, index) =>
      chunk(2, index === 0 ? { role: "assistant", content } : { content }),
    ),
    { ...chunk(2, {}, finishReason), usage },
  ]);
}

/** A provider that answers in order and records each request body. */
export function recordingProvider(responses: readonly Response[]): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    const response = responses[bodies.length - 1];
    if (!response) throw new Error("Unexpected provider request.");
    return response.clone();
  });
  return bodies;
}

export interface ToolPathHarnessOptions {
  readonly capability?: InstalledAnswerSubmission | null;
  /** Collapse replay waits in fixtures that assert refusals, not elapsed time. */
  readonly instantReplay?: boolean;
  readonly maxProviderTurns?: number;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly environment?: Record<string, string>;
  readonly now?: () => number;
  /** Per-turn output limit and context window overrides for the bound profile. */
  readonly maxOutputTokens?: number;
  readonly contextWindow?: number;
  /**
   * `false` binds the route without composition ceilings, as an unmatched
   * operator endpoint borrows the capability: no attempt timer and no
   * response buffering at the transport.
   */
  readonly composition?: boolean;
  readonly beforeToolCall?: PiHarnessOptions["beforeToolCall"];
  readonly configureSession?: PiHarnessOptions["configureSession"];
}

/** A PiHarness on a composition route that recorded an answer submission. */
export function toolPathHarness(options: ToolPathHarnessOptions = {}): PiHarness {
  const base = fixtureCompositionExecutionProfile({
    maxProviderTurns: options.maxProviderTurns ?? 16,
    timeoutMs: options.timeoutMs ?? 60_000,
    maxResponseBytes: options.maxResponseBytes ?? 4 * 1024 * 1024,
  });
  const capability = options.capability === undefined ? RECORDED_CAPABILITY : options.capability;
  const contextWindow = options.contextWindow ?? base.profile.contextWindow;
  const maxOutputTokens = options.maxOutputTokens ?? base.profile.maxOutputTokens;
  const sized = {
    ...base,
    profile: {
      ...base.profile,
      configuredLimits: { contextWindow, maxInputTokens: contextWindow, maxOutputTokens },
      contextWindow,
      maxInputTokens: contextWindow,
      maxOutputTokens,
    },
  };
  const { compositionPolicy: _compositionPolicy, ...operatorLane } = sized;
  const lane = options.composition === false ? operatorLane : sized;
  const executionProfile = capability ? { ...lane, answerSubmission: capability } : lane;
  const factory = createProviderConnectionFactory({
    routeId: executionProfile.routeId,
    transport: executionProfile.transport,
  });
  return new PiHarness({
    skillCrateDirectory,
    executionProfile,
    qualityDirectory: resolve(projectRoot, "quality"),
    styleContext,
    limits: { environment: options.environment ?? {}, hostFile: null, projectFile: null },
    credential: { family: "nvidia-inference-api", apiKey: validModelConfig.apiKey },
    providerConnectionFactory: options.instantReplay
      ? {
          ...factory,
          create: (input, turnOptions) =>
            factory.create(
              input,
              turnOptions
                ? {
                    ...turnOptions,
                    providerTurnRetry: {
                      ...turnOptions.providerTurnRetry,
                      baseDelayMs: 0,
                      maxDelayMs: 0,
                    },
                  }
                : turnOptions,
            ),
        }
      : factory,
    ...(options.now ? { now: options.now } : {}),
    ...(options.beforeToolCall ? { beforeToolCall: options.beforeToolCall } : {}),
    ...(options.configureSession ? { configureSession: options.configureSession } : {}),
  });
}

/** The bound final quality evaluator's step input, on the given answer path. */
export async function qualityStepInput(
  repositoryPath: string,
  answerSubmission: HarnessStepInput["answerSubmission"] = {
    path: "tool-call",
    reason: "recorded-route",
  },
): Promise<HarnessStepInput> {
  const pack = await verifyQualityPackContext({
    skillCrateDirectory,
    qualityDirectory: resolve(projectRoot, "quality"),
    qualityPackDirectory: resolve(projectRoot, "quality-pack"),
  });
  const base = stepInput(repositoryPath);
  const technicalVerification = verificationResultFixture(["README.md"]);
  const profileAssetPath = "profiles/docsfab-documentation-quality/profile.json";
  return {
    ...base,
    step: base.workflow.steps.find((step) => step.skill === "evaluate-document-quality")!,
    evidenceIdentity: {
      ...base.evidenceIdentity!,
      technicalVerificationSha256: canonicalDigest(technicalVerification),
    },
    technicalVerification,
    reviewScope: {
      scope: "focused-set",
      reason: "operator-named",
      targetPaths: ["README.md"],
      deferredPaths: [],
      scopeSha256: "c".repeat(64),
      corpusFileCount: 1,
    },
    qualityProfileSelection: {
      skillLockSha256: pack.evidence.skillLockSha256,
      qualityLockSha256: pack.evidence.qualityLockSha256,
      qualityBundleSha256: pack.evidence.qualityBundleSha256,
      profileAssetPath,
      profilePayloadSha256: pack.qualityLock.files.find((file) => file.path === profileAssetPath)!
        .sha256,
      profileId: "docsfab-documentation-quality",
      profileVersion: "v0.1",
      profileModel: "documentation-quality-model-v0.2",
      repositoryRevision: base.evidenceIdentity!.repositoryRevision,
      selectionSha256: "b".repeat(64),
    } as NonNullable<HarnessStepInput["qualityProfileSelection"]>,
    ...(answerSubmission ? { answerSubmission } : {}),
  };
}

/** The user messages of one recorded request, joined. */
export function userText(body: Record<string, unknown>): string {
  const messages = (body.messages ?? []) as Array<{ role?: string; content?: unknown }>;
  return messages
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content.map((part) => (part as { text?: string }).text ?? "").join("\n")
          : "",
    )
    .join("\n");
}

/** The tool results the model saw in one recorded request, by call ID. */
export function toolResults(body: Record<string, unknown>): Map<string, string> {
  const results = new Map<string, string>();
  for (const message of (body.messages ?? []) as Array<Record<string, unknown>>) {
    if (message.role !== "tool" || typeof message.tool_call_id !== "string") continue;
    const content = message.content;
    results.set(
      message.tool_call_id,
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((part) => (part as { text?: string }).text ?? "").join("\n")
          : "",
    );
  }
  return results;
}

/** A report reply with fences, braces, and quotes that every report rule admits. */
export const FIXTURE_REPORT = [
  "# Documentation quality evaluation report",
  "",
  'The guide quotes "consumer" behavior and shows {braces} in prose.',
  "",
  "```text",
  'a fenced "sample" with {braces} and a \\ backslash',
  "```",
  "",
  "## Evidence gaps and limitations",
  "",
  "- Limitation: Direct outcome evidence is unavailable.",
].join("\n");
