// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The request interpretation: ask the model once for its reading of the
 * operator's request, re-ask on a correctable rejection, and admit the result.
 *
 * Pure orchestration over injected ports: no provider, file, or clock
 * import. The caller supplies the model port, the existence oracle, the
 * inventories, the run's documentation roots and navigation set, the resolved
 * limits, the re-ask bound, and the deadline. An admitted intent is recorded
 * and shown; nothing downstream consumes it yet.
 */
import { createHash } from "node:crypto";

import { assertWorkflowActive } from "../execution/cancellation.js";
import {
  OUTPUT_CONTRACTS,
  OUTPUT_RULE_HINTS,
  renderResponseContract,
} from "../contracts/model-output.js";
import { estimateModelRequestTokens } from "../model/context-budget.js";
import { refuseLimit, type ResolvedLimit } from "../config/limits.js";
import { admitRequestIntent } from "./admit.js";
import type {
  RequestIntentBoundary,
  RequestIntentExistenceAnswer,
  RequestIntentOperation,
  RequestIntentPathScope,
  RequestIntentProposal,
  RequestIntentQuestion,
  RequestIntentV1,
} from "./contract.js";
import { decodeRequestIntentProposal } from "./decode.js";
import { requestIntentExistencePaths } from "./host-input.js";
import {
  requestIntentExistenceAnswers,
  type RequestIntentExistenceOracle,
} from "./interpret-existence.js";
import type { RequestIntentInterpretationCallV1 } from "./interpret-record.js";
import type { RequestIntentPromptInventory } from "./interpret-inventory.js";
import type { RequestIntentAdmissionInput, RequestIntentLimits } from "./limits.js";

/**
 * The operation each workflow declares, by exact workflow name. A workflow
 * missing here declares none and is never interpreted.
 */
export const REQUEST_INTENT_DECLARED_OPERATIONS: Readonly<Record<string, RequestIntentOperation>> =
  Object.freeze({
    "create-documentation": "create",
    "update-documentation": "update",
    "restructure-documentation": "restructure",
    "review-documentation": "review",
  });

export function declaredRequestIntentOperation(
  workflow: string,
): RequestIntentOperation | undefined {
  return Object.hasOwn(REQUEST_INTENT_DECLARED_OPERATIONS, workflow)
    ? REQUEST_INTENT_DECLARED_OPERATIONS[workflow]
    : undefined;
}

export interface RequestIntentInterpreterCall {
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly maxOutputTokens: number;
  /** Aborts on an operator cancel or the interpretation's own deadline. */
  readonly signal: AbortSignal;
}

export interface RequestIntentInterpreterReply {
  readonly text: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

/**
 * One model call per `call`. A port reports a provider or connection failure
 * by throwing `RequestIntentModelUnavailableError`; any other error is a
 * defect and propagates out of the interpretation unchanged.
 */
export interface RequestIntentInterpreterPort {
  call(request: RequestIntentInterpreterCall): Promise<RequestIntentInterpreterReply>;
}

/** The provider or its connection failed; the run stops `request-intent-model-unavailable`. */
export class RequestIntentModelUnavailableError extends Error {
  public readonly name = "RequestIntentModelUnavailableError";
  public readonly code = "request-intent-model-unavailable";

  public constructor(options?: ErrorOptions) {
    super("The request interpretation could not reach the bound model.", options);
  }
}

/** The rendered prompt is larger than the bound model's input window. */
export class RequestIntentInputBudgetError extends Error {
  public readonly name = "RequestIntentInputBudgetError";
  public readonly code = "request-intent-model-input-budget";

  public constructor(
    public readonly estimatedInputTokens: number,
    public readonly maxInputTokens: number,
  ) {
    super(
      `The request interpretation prompt needs about ${estimatedInputTokens} input tokens and the bound model profile admits ${maxInputTokens} (code request-intent-model-input-budget, scope per-run). Shorten the request, or bind a model profile with a larger input window.`,
    );
  }
}

/** Codes of the recorded stops the host itself raises, never the catalog. */
export const REQUEST_INTENT_HOST_STOP_CODES = [
  "request-intent-model-unavailable",
  "request-intent-model-deadline",
] as const;
export type RequestIntentHostStopCode = (typeof REQUEST_INTENT_HOST_STOP_CODES)[number];

interface OutcomeBase {
  readonly calls: readonly RequestIntentInterpretationCallV1[];
}

export type InterpretationOutcome =
  | (OutcomeBase & { readonly outcome: "admitted"; readonly intent: RequestIntentV1 })
  | (OutcomeBase & {
      readonly outcome: "advisory";
      readonly code: string;
      readonly at: string;
      readonly intent: RequestIntentV1;
    })
  | (OutcomeBase & {
      readonly outcome: "question";
      readonly code: string;
      readonly at: string;
      readonly question: RequestIntentQuestion;
      readonly intent: RequestIntentV1;
    })
  | (OutcomeBase & {
      readonly outcome: "refused";
      readonly code: string;
      readonly at: string;
      readonly boundary: RequestIntentBoundary | null;
    })
  | (OutcomeBase & { readonly outcome: "rejected"; readonly code: string; readonly at: string })
  | (OutcomeBase & { readonly outcome: "unavailable"; readonly code: RequestIntentHostStopCode });

/**
 * The host inputs that hold for the whole run: the request, the repository
 * inventory, the declared operation, the documentation roots a new page must
 * sit under, the roots the run grants every page it writes, and the
 * navigation set.
 */
export interface RequestIntentRunInputs {
  readonly instruction: string;
  readonly inventory: readonly string[];
  readonly limits: RequestIntentLimits;
  /** From the run's workflow by exact name; never from the proposal. */
  readonly declaredOperation: RequestIntentOperation;
  readonly docsRoot: readonly RequestIntentPathScope[];
  /** The write roots the run grants every page it writes, named, new, or planned. */
  readonly writeRoots: readonly RequestIntentPathScope[];
  readonly navigationSet: readonly string[];
}

/** Every admission input for one decoded proposal: the run's inputs plus this attempt's. */
export function buildRequestIntentHostInputs(
  run: RequestIntentRunInputs,
  attempt: {
    readonly proposal: RequestIntentProposal;
    readonly existence: readonly RequestIntentExistenceAnswer[];
  },
): RequestIntentAdmissionInput {
  return {
    instruction: run.instruction,
    inventory: run.inventory,
    limits: run.limits,
    declaredOperation: run.declaredOperation,
    docsRoot: run.docsRoot,
    // Every plan writes only inside the roots, so every reading, of the
    // declared operation or another, gets them and no file grant beyond them.
    grantedWriteScope: [...run.writeRoots],
    navigationSet: run.navigationSet,
    existence: attempt.existence,
  };
}

/**
 * Refuse a question admission returns when any field is over the bound the
 * model's own question meets at decode. A host question embeds the observed
 * path, which no decode bound limits, so a long named path can carry it over.
 * Never clipped: the operator answers the question as it was asked.
 */
export function enforceRequestIntentQuestionBounds(
  question: RequestIntentQuestion,
  limits: Pick<RequestIntentLimits, "maxQuestionChars" | "maxQuestionOptions" | "maxOptionChars">,
): void {
  const over = (bound: ResolvedLimit, observed: number) => {
    if (observed > bound.value) refuseLimit(bound, observed);
  };
  over(limits.maxQuestionChars, question.question.length);
  over(limits.maxQuestionChars, question.consequence.length);
  over(limits.maxQuestionOptions, question.options.length);
  for (const option of question.options) over(limits.maxOptionChars, option.length);
}

/** The rendered request-intent contract the model reads. */
export function renderRequestIntentPrompt(input: {
  readonly workflow: string;
  readonly operation: RequestIntentOperation;
  readonly instruction: string;
  readonly inventory: RequestIntentPromptInventory;
  readonly documentationRoots: readonly RequestIntentPathScope[];
  readonly navigationSet: readonly string[];
}): string {
  return renderResponseContract("request-intent", {
    "declared-workflow": JSON.stringify({ workflow: input.workflow, operation: input.operation }),
    "documentation-roots": JSON.stringify(input.documentationRoots.map((root) => root.path)),
    "navigation-set": JSON.stringify(input.navigationSet),
    "documentation-inventory": input.inventory.entries
      .map((entry) => JSON.stringify(entry))
      .join("\n"),
    "operator-request": input.instruction,
  });
}

/** The system prompt is the contract's own title; the rules travel in the prompt. */
export const REQUEST_INTENT_SYSTEM_PROMPT = OUTPUT_CONTRACTS["request-intent"].title;

export interface InterpretRequestInput {
  readonly port: RequestIntentInterpreterPort;
  readonly workflow: string;
  readonly operation: RequestIntentOperation;
  readonly instruction: string;
  readonly promptInventory: RequestIntentPromptInventory;
  readonly admissionInventory: readonly string[];
  /** Resolved documentation roots: where a create target must sit. */
  readonly documentationRoots: readonly RequestIntentPathScope[];
  /** The roots the run grants a named or new page. */
  readonly writeRoots: readonly RequestIntentPathScope[];
  /** Existing navigation and index files a companion target may name. */
  readonly navigationSet: readonly string[];
  /** Asked once per decoded proposal, before admission reads it. */
  readonly existence: RequestIntentExistenceOracle;
  readonly limits: RequestIntentLimits;
  /** Re-asks after a correctable rejection: `retry.maxRetries`, so 1 + this many calls. */
  readonly maxRetries: number;
  /** The bound model's windows. */
  readonly window: { readonly maxInputTokens: number; readonly maxOutputTokens: number };
  /** Milliseconds for every call of this interpretation together. */
  readonly deadlineMs: number;
  /** The operator's cancellation; an abort takes the workflow cancellation path. */
  readonly signal?: AbortSignal;
}

/**
 * Interpret the request. Returns a closed outcome; throws for a cancelled run,
 * a prompt over the input window, a host-input fault, an existence oracle
 * failure, or a limit refusal.
 */
export async function interpretRequest(
  input: InterpretRequestInput,
): Promise<InterpretationOutcome> {
  const deadline = AbortSignal.timeout(input.deadlineMs);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  const prompt = renderRequestIntentPrompt({ ...input, inventory: input.promptInventory });
  const run: RequestIntentRunInputs = {
    instruction: input.instruction,
    inventory: input.admissionInventory,
    limits: input.limits,
    declaredOperation: input.operation,
    docsRoot: input.documentationRoots,
    writeRoots: input.writeRoots,
    navigationSet: input.navigationSet,
  };
  const calls: RequestIntentInterpretationCallV1[] = [];
  let correction: string | undefined;
  let rejection: { code: string; at: string } | undefined;
  for (let attempt = 0; attempt <= input.maxRetries; attempt += 1) {
    assertWorkflowActive(input.signal);
    if (deadline.aborted)
      return { outcome: "unavailable", code: "request-intent-model-deadline", calls };
    const text = correction === undefined ? prompt : `${prompt}\n${correction}`;
    const estimated = estimateModelRequestTokens({
      systemPrompt: REQUEST_INTENT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: text }],
    });
    if (estimated > input.window.maxInputTokens) {
      throw new RequestIntentInputBudgetError(estimated, input.window.maxInputTokens);
    }
    const promptSha256 = sha256(text);
    let reply: RequestIntentInterpreterReply;
    try {
      reply = await input.port.call({
        systemPrompt: REQUEST_INTENT_SYSTEM_PROMPT,
        prompt: text,
        maxOutputTokens: input.window.maxOutputTokens,
        signal,
      });
    } catch (error) {
      // Three conditions, kept apart: the operator's cancel takes the workflow
      // cancellation path, this step's own deadline is the deadline stop, and
      // only a port-reported provider failure is unavailable. Anything else is
      // a defect and propagates.
      assertWorkflowActive(input.signal);
      if (deadline.aborted) {
        calls.push({ promptSha256, responseSha256: null, inputTokens: 0, outputTokens: 0 });
        return { outcome: "unavailable", code: "request-intent-model-deadline", calls };
      }
      if (error instanceof RequestIntentModelUnavailableError) {
        calls.push({ promptSha256, responseSha256: null, inputTokens: 0, outputTokens: 0 });
        return { outcome: "unavailable", code: "request-intent-model-unavailable", calls };
      }
      throw error;
    }
    calls.push({
      promptSha256,
      responseSha256: sha256(reply.text),
      inputTokens: reply.usage.inputTokens,
      outputTokens: reply.usage.outputTokens,
    });
    const parsed = firstJsonObject(reply.text);
    const decoded =
      parsed === undefined
        ? ({ outcome: "rejected", code: "request-intent-shape", at: "$", location: "$" } as const)
        : decodeRequestIntentProposal(parsed, run);
    let result;
    if (decoded.outcome === "decoded") {
      // Asked for this attempt's proposal: a re-ask may name other targets.
      // An oracle failure propagates; it is never read as an answer.
      const asked = requestIntentExistencePaths(decoded);
      const existence = requestIntentExistenceAnswers(asked, await input.existence(asked));
      result = admitRequestIntent(
        decoded,
        buildRequestIntentHostInputs(run, { proposal: decoded.proposal, existence }),
      );
    } else {
      result = decoded;
    }
    switch (result.outcome) {
      case "admitted":
        return { outcome: "admitted", intent: result.intent, calls };
      case "advisory":
        return {
          outcome: "advisory",
          code: result.code,
          at: result.at,
          intent: result.intent,
          calls,
        };
      case "question":
        enforceRequestIntentQuestionBounds(result.question, input.limits);
        return {
          outcome: "question",
          code: result.code,
          at: result.at,
          question: result.question,
          intent: result.intent,
          calls,
        };
      case "refused":
        return {
          outcome: "refused",
          code: result.code,
          at: result.at,
          boundary: "boundary" in result ? result.boundary : null,
          calls,
        };
      case "rejected": {
        rejection = { code: result.code, at: result.at };
        const hint = OUTPUT_RULE_HINTS[result.code];
        const sentence = hint?.atLocation?.[result.location] ?? hint?.rule;
        correction = `Correction (${result.code} at ${result.at}): ${sentence ?? ""}`.trimEnd();
        break;
      }
    }
  }
  // The loop runs at least once, and only a rejection reaches here.
  return { outcome: "rejected", code: rejection!.code, at: rejection!.at, calls };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The first complete JSON object in a reply, or undefined. Braces inside
 * strings do not count, so a quote holding `{` cannot cut the object short.
 */
export function firstJsonObject(text: string): Record<string, unknown> | undefined {
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            const value = JSON.parse(text.slice(start, index + 1)) as unknown;
            return typeof value === "object" && value !== null && !Array.isArray(value)
              ? (value as Record<string, unknown>)
              : undefined;
          } catch {
            break;
          }
        }
      }
    }
  }
  return undefined;
}
