// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The answer-submission qualification probe: `docsfab doctor --live
 * --answer-submission`. It sends content-free tool-call variants through the
 * bound composition's request path, then decides whether the route can take
 * the final quality evaluator's answer as a tool call, and with which
 * argument shell. Every sample is decided by the production decoder itself,
 * `decodeQualitySubmission` over the forwarded argument bytes: strict JSON,
 * then the exact member set and each member's type, where a member sent as
 * one JSON string is decoded once by the same strict parser (#1707).
 *
 * The observation it retains holds no model prose: per sample, the variant,
 * the HTTP status, the finish reason, the argument text's byte length and
 * SHA-256, closed findings, and for a request that got no HTTP response its
 * closed transport class, elapsed time, and streamed byte count. Its
 * canonical digest is the `evidenceSha256` a composition records with the
 * capability.
 */
import { createHash } from "node:crypto";

import { canonicalDigest } from "../content-ir/canonical.js";
import { OUTPUT_HOST_TEXT } from "../contracts/model-output.generated.js";
import { QUALITY_ARTIFACT_ANSWER_KEYS } from "../execution/response-contract-keys.js";
import {
  buildSubmissionShell,
  QUALITY_SUBMISSION_TOOL_NAME,
  type SubmissionMemberType,
} from "../harness/answer-submission.js";
import {
  decodeQualitySubmission,
  QualityArtifactEnvelopeError,
  type QualitySubmissionRejectionCode,
} from "../harness/quality-candidate-tool.js";
import {
  JsonEvidenceError,
  parseJsonEvidence,
  type JsonEvidenceErrorCode,
} from "../json-evidence.js";
import type { InstalledAnswerSubmission } from "../model-composition/types.js";
import {
  streamChatCompletion,
  type CompatibilityTurn,
  type ProbeProvider,
  type ProbeRequestShape,
  type TransportErrorClass,
} from "./probe-core.js";

export const ANSWER_SUBMISSION_PROBE_KIND = "docsfab-answer-submission-probe" as const;

/**
 * The probe's variants. V1 and V2 measure the untyped and the typed shell; V2
 * is sent only when V1 is not usable. V3 asks for a duplicate key; V4 a
 * string with a line break; V6 a large nested object whose strings carry
 * quotes, backslashes, fences, braces, and line breaks. There is no V5: the
 * report turn's `tool_choice` is not measured, and the capability records
 * `auto`, so the report turn uses the denial path.
 */
export const ANSWER_SUBMISSION_PROBE_VARIANTS = ["V1", "V2", "V3", "V4", "V6"] as const;
export type AnswerSubmissionProbeVariant = (typeof ANSWER_SUBMISSION_PROBE_VARIANTS)[number];

/** The nominal plan's variants, each sent `samplesPerVariant` times. */
const NOMINAL_VARIANTS = ["V1", "V3", "V4", "V6"] as const;
/** The shell-choice variant the nominal plan sends first. */
const SHELL_CHOICE_VARIANTS = ["V1"] as const;
/** The typed-shell contingency's variants, sent only with the opt-in. */
const CONTINGENCY_VARIANTS = ["V2", "V3", "V4", "V6"] as const;

type Shell = InstalledAnswerSubmission["argumentShell"];

/** A member's JSON type in the forwarded arguments, before any inner decode. */
export type AnswerSubmissionProbeMemberType =
  | "object"
  | "string"
  | "array"
  | "null"
  | "other"
  | "absent";

/** One probe request's closed findings; never the reply's text. */
export interface AnswerSubmissionProbeSample {
  readonly variant: AnswerSubmissionProbeVariant;
  readonly shell: Shell;
  /** `contingency` for a typed re-send after the untyped shell failed V4 or V6. */
  readonly round: "first" | "contingency";
  /** HTTP status; 0 when no response arrived. */
  readonly httpStatus: number;
  /** HTTP 0 only: the closed transport class; null otherwise. */
  readonly transportError: TransportErrorClass | null;
  /** HTTP 0 only: how long the request ran before it failed. */
  readonly elapsedMs: number | null;
  /** HTTP 0 only: the response bytes that arrived before it failed. */
  readonly streamedBytes: number | null;
  /** V6 only: this transport failure was sent again; the re-send names it in `retryOf`. */
  readonly retried: boolean;
  /** The index, in `samples`, of the transport failure this sample re-sends; null otherwise. */
  readonly retryOf: number | null;
  readonly finishReason: string | null;
  readonly toolCallPresent: boolean;
  /** The JSON type of the `evaluation` member as the strict parser read it. */
  readonly memberType: AnswerSubmissionProbeMemberType | "unparsed";
  /**
   * Each member's JSON type in the forwarded arguments, before any inner
   * decode; null when no call arrived or its text was not strict JSON.
   */
  readonly memberEncoding: {
    readonly evaluation: AnswerSubmissionProbeMemberType;
    readonly qualityScore: AnswerSubmissionProbeMemberType;
  } | null;
  /** The strict parser's verdict on the raw argument text. */
  readonly parse: "ok" | "missing" | JsonEvidenceErrorCode;
  /**
   * The production decoder's verdict on the same bytes: `admitted`, the
   * catalog code it refused with, or `missing` when no submission call arrived.
   */
  readonly decode: "admitted" | "missing" | QualitySubmissionRejectionCode;
  /** Where the production decoder refused; null when it admitted or nothing arrived. */
  readonly decodeLocation: string | null;
  readonly rawBytes: number;
  readonly rawSha256: string | null;
  /**
   * V3: the requested duplicate key reached the host in the forwarded bytes,
   * in the arguments themselves or inside a member sent as a JSON string.
   */
  readonly duplicatePresent: boolean;
  /** V6: the decoded `evaluation` equals the host's object; recorded only. */
  readonly deepEqual: boolean | null;
}

export interface AnswerSubmissionProbeObservation {
  /** 2: transport classes and retries, member encodings, and no V5. */
  readonly schemaVersion: 2;
  readonly kind: typeof ANSWER_SUBMISSION_PROBE_KIND;
  readonly modelId: string;
  readonly maxOutputTokens: number;
  readonly samplesPerVariant: number;
  /** Reproduces the V6 object with {@link answerSubmissionProbeObject}. */
  readonly largeObjectSeed: string;
  readonly samples: readonly AnswerSubmissionProbeSample[];
}

/** One transport failure that kept the probe from a verdict. */
export interface AnswerSubmissionProbeTransportError {
  readonly variant: AnswerSubmissionProbeVariant;
  readonly class: TransportErrorClass;
  readonly elapsedMs: number;
  readonly streamedBytes: number;
  readonly retried: boolean;
}

export type AnswerSubmissionProbeVerdict =
  | {
      readonly decision: "go";
      readonly capability: InstalledAnswerSubmission;
      readonly observation: AnswerSubmissionProbeObservation;
      readonly evidenceSha256: string;
      readonly notes: readonly string[];
    }
  | {
      readonly decision: "no-go";
      readonly stopClass: "provider-compatibility";
      readonly cause:
        | "no-usable-shell"
        | "arguments-not-strict"
        | "output-allowance-reached"
        | "response-byte-bound"
        | "timer-fit"
        | "tool-call-not-returned"
        | "provider-request-refused";
      readonly reason: string;
      readonly nextAction: string;
      readonly observation: AnswerSubmissionProbeObservation;
      readonly evidenceSha256: string;
    }
  | {
      /**
       * The untyped shell is not usable for every sample, and the typed-shell
       * contingency was not opted into, so the probe stopped before spending
       * on it. No stop class, and nothing is recorded.
       */
      readonly decision: "contingency-required";
      readonly reason: string;
      /** Most requests the contingency would add to this run. */
      readonly contingencyRequests: number;
      /** Most requests a rerun with the contingency flag sends in all. */
      readonly rerunMaxRequests: number;
      readonly nextAction: string;
      readonly observation: AnswerSubmissionProbeObservation;
      readonly evidenceSha256: string;
    }
  | {
      /**
       * Transport failures kept the probe from a verdict. No stop class: it is
       * not a provider-compatibility finding, and nothing is recorded.
       */
      readonly decision: "inconclusive";
      readonly reason: string;
      readonly transportErrors: readonly AnswerSubmissionProbeTransportError[];
      readonly nextAction: string;
      readonly observation: AnswerSubmissionProbeObservation;
      readonly evidenceSha256: string;
    };

export interface AnswerSubmissionProbeTarget {
  readonly modelId: string;
  readonly provider: ProbeProvider;
  /** The bound profile's effective output limit, sent as `max_tokens`. */
  readonly maxOutputTokens: number;
  readonly samplesPerVariant: number;
  readonly systemPrompt: string;
  /** The token field, instruction role, and `store` flag DocsFab's provider sends on this route. */
  readonly shape: Required<ProbeRequestShape>;
  readonly fetch: typeof globalThis.fetch;
  /** Request timeout for every variant but V6 (`endpointProbe.requestTimeoutMs`). */
  readonly timeoutMs: number;
  /**
   * V6's request timeout: the bound attempt timer, the most time a production
   * submission turn can have.
   */
  readonly largeVariantTimeoutMs: number;
  /**
   * Most V6 re-sends after a transport failure that is not a byte bound
   * (`endpointProbe.answerSubmissionTransportRetries`); each sample at most once.
   */
  readonly transportRetries: number;
  /**
   * Opt-in to the typed-shell contingency (`--answer-submission-typed-contingency`):
   * V2, then V3, V4, and V6 again under the typed shell. Without it the probe
   * stops with `contingency-required` before sending any of them, so one run
   * stays within the nominal plan's spend.
   */
  readonly typedContingency: boolean;
  /** Clock for each transport failure's `elapsedMs`; `Date.now` by default. */
  readonly now?: () => number;
  readonly errorBodyMaxChars: number;
  readonly credentialEchoMinChars: number;
  /** The bound request policy's finalizer: sampling, reasoning control, and payload checks. */
  readonly finalizeBody?: (body: Record<string, unknown>) => Record<string, unknown>;
}

const NEXT_ACTION =
  "Keep the route on the text answer and record no answerSubmission capability for it; review the retained probe observation before probing again.";

const INCONCLUSIVE_NEXT_ACTION = "Probe again later; transport failures prevented a verdict.";

/** The seed the retained observation names for the V6 object. */
export const ANSWER_SUBMISSION_PROBE_SEED = "docsfab-answer-submission-probe-v1";

/**
 * The V6 object's serialized size in characters, and its depth: the size of a
 * realistic evaluation (hosted submissions were sized at about 20 KiB)
 * and four levels deep. This is what the probe asks the model to copy, a
 * synthetic payload size; nothing is refused or cut at it, so it is not an
 * operational bound.
 */
const LARGE_OBJECT_CHARACTERS = 20_480;
const LARGE_OBJECT_DEPTH = 4;

/** The strings V6 repeats: quotes, backslashes, fences, braces, and line breaks. */
const LARGE_OBJECT_TEXTS = [
  'A finding "quoted" in the report',
  "A path C:\\docs\\guide.md and a backslash \\ alone",
  '```json\n{"fenced": true}\n```',
  "Braces {inside} a string and [brackets]",
  "Line one\nLine two\n\tTabbed line",
] as const;

/**
 * The host-generated V6 object for `seed`: deterministic, at least
 * {@link LARGE_OBJECT_CHARACTERS} serialized, nested
 * {@link LARGE_OBJECT_DEPTH} levels, with every string shape the evaluation
 * text carries.
 */
export function answerSubmissionProbeObject(seed: string): Record<string, unknown> {
  const findings: Record<string, unknown>[] = [];
  let index = 0;
  const serialized = () => JSON.stringify({ probe: "V6", findings }).length;
  while (serialized() < LARGE_OBJECT_CHARACTERS) {
    const digest = createHash("sha256").update(`${seed}:${index}`).digest("hex");
    let nested: Record<string, unknown> = {
      text: LARGE_OBJECT_TEXTS[index % LARGE_OBJECT_TEXTS.length],
      digest,
    };
    for (let level = 1; level < LARGE_OBJECT_DEPTH; level += 1) {
      nested = { level, detail: nested };
    }
    findings.push({ id: `finding-${index}`, evidence: nested });
    index += 1;
  }
  return { probe: "V6", findings };
}

const SMALL_OBJECT = Object.freeze({ probe: "V1", nested: { level: 2, items: ["a", "b"] } });
const LINE_BREAK_OBJECT = Object.freeze({ probe: "V4", text: "line one\nline two" });
const DUPLICATE_KEY_TEXT = '{"probe":"V3","key":"first","key":"second"}';

const SUBMISSION_TYPES: Readonly<Record<string, SubmissionMemberType>> = Object.freeze({
  evaluation: "object",
  qualityScore: ["object", "null"] as const,
});

function submissionTool(shell: Shell): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: QUALITY_SUBMISSION_TOOL_NAME,
      description: OUTPUT_HOST_TEXT["quality-submission-tool-description"],
      parameters: buildSubmissionShell({
        keys: QUALITY_ARTIFACT_ANSWER_KEYS,
        argumentShell: shell,
        descriptions: {
          evaluation: OUTPUT_HOST_TEXT["quality-submission-evaluation-description"],
          qualityScore: OUTPUT_HOST_TEXT["quality-submission-quality-score-description"],
        },
        types: SUBMISSION_TYPES,
      }),
    },
  };
}

function callPrompt(evaluation: string): string {
  return [
    `Call ${QUALITY_SUBMISSION_TOOL_NAME} once. Set qualityScore to null.`,
    "Set evaluation to exactly this JSON value, copied character for character:",
    evaluation,
  ].join("\n");
}

interface VariantRequest {
  readonly variant: AnswerSubmissionProbeVariant;
  readonly shell: Shell;
  readonly body: Record<string, unknown>;
}

function requestBody(
  target: AnswerSubmissionProbeTarget,
  messages: readonly Record<string, unknown>[],
  tools: readonly Record<string, unknown>[],
  toolChoice: "required",
): Record<string, unknown> {
  return {
    model: target.modelId,
    messages: [{ role: target.shape.systemRole, content: target.systemPrompt }, ...messages],
    stream: true,
    stream_options: { include_usage: true },
    ...(target.shape.store ? { store: false } : {}),
    [target.shape.tokenField]: target.maxOutputTokens,
    tools: structuredClone(tools),
    tool_choice: toolChoice,
  };
}

function callVariant(
  target: AnswerSubmissionProbeTarget,
  variant: AnswerSubmissionProbeVariant,
  shell: Shell,
  evaluation: string,
): VariantRequest {
  return {
    variant,
    shell,
    body: requestBody(
      target,
      [{ role: "user", content: callPrompt(evaluation) }],
      [submissionTool(shell)],
      "required",
    ),
  };
}

function memberTypeOf(value: unknown): AnswerSubmissionProbeMemberType {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "string") return "string";
  return "other";
}

function sampleOf(
  request: VariantRequest,
  round: AnswerSubmissionProbeSample["round"],
  turn: CompatibilityTurn,
  largeObject: Record<string, unknown>,
  retryOf: number | null,
): AnswerSubmissionProbeSample {
  const base = {
    variant: request.variant,
    shell: request.shell,
    round,
    httpStatus: turn.status,
    retried: false,
    retryOf,
  };
  if (!turn.ok) {
    const transport = turn.status === 0 ? turn.transport : undefined;
    return {
      ...base,
      transportError: transport?.class ?? (turn.status === 0 ? "other" : null),
      elapsedMs: transport?.elapsedMs ?? (turn.status === 0 ? 0 : null),
      streamedBytes: transport?.streamedBytes ?? (turn.status === 0 ? 0 : null),
      finishReason: null,
      toolCallPresent: false,
      memberType: "absent",
      memberEncoding: null,
      parse: "missing",
      decode: "missing",
      decodeLocation: null,
      rawBytes: 0,
      rawSha256: null,
      duplicatePresent: false,
      deepEqual: null,
    };
  }
  const call = turn.toolCalls.find((entry) => entry.name === QUALITY_SUBMISSION_TOOL_NAME);
  const raw = call?.arguments;
  let parse: AnswerSubmissionProbeSample["parse"] = raw === undefined ? "missing" : "ok";
  let root: Record<string, unknown> | undefined;
  let parsed = false;
  if (raw !== undefined) {
    try {
      const value = parseJsonEvidence(raw);
      parsed = true;
      root =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : undefined;
    } catch (error) {
      parse = error instanceof JsonEvidenceError ? error.code : "malformed-json";
    }
  }
  const decoded = decodeVerdict(raw);
  const evaluation = decodedEvaluation(raw);
  return {
    ...base,
    transportError: null,
    elapsedMs: null,
    streamedBytes: null,
    finishReason: turn.finishReason,
    toolCallPresent: call !== undefined,
    memberType: raw === undefined ? "absent" : parsed ? memberTypeOf(root?.evaluation) : "unparsed",
    memberEncoding:
      raw !== undefined && parsed
        ? {
            evaluation: memberTypeOf(root?.evaluation),
            qualityScore: memberTypeOf(root?.qualityScore),
          }
        : null,
    parse,
    decode: decoded.decode,
    decodeLocation: decoded.decodeLocation,
    rawBytes: raw === undefined ? 0 : Buffer.byteLength(raw, "utf8"),
    rawSha256: raw === undefined ? null : createHash("sha256").update(raw).digest("hex"),
    duplicatePresent:
      request.variant === "V3" &&
      (parse === "duplicate-key" || decoded.decode === "quality-submission-duplicate-key"),
    deepEqual:
      request.variant === "V6" && evaluation !== undefined
        ? canonicalDigest(evaluation) === canonicalDigest(largeObject)
        : null,
  };
}

/**
 * V6's decoded `evaluation`, as production reads it: the member itself, or
 * the one strict decode of a member sent as a JSON string. Undefined when the
 * production decoder refuses the arguments.
 */
function decodedEvaluation(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return decodeQualitySubmission(raw).evaluation;
  } catch {
    return undefined;
  }
}

/** Run the production decoder over one sample's argument bytes. */
function decodeVerdict(
  raw: string | undefined,
): Pick<AnswerSubmissionProbeSample, "decode" | "decodeLocation"> {
  if (raw === undefined) return { decode: "missing", decodeLocation: null };
  try {
    decodeQualitySubmission(raw);
    return { decode: "admitted", decodeLocation: null };
  } catch (error) {
    if (!(error instanceof QualityArtifactEnvelopeError)) throw error;
    const { code, location } = error.rejection;
    if (!code.startsWith("quality-submission-")) throw error;
    return {
      decode: code as QualitySubmissionRejectionCode,
      decodeLocation: String(location),
    };
  }
}

/** The request got an HTTP 2xx response, so its findings are complete. */
function completed(sample: AnswerSubmissionProbeSample): boolean {
  return sample.httpStatus >= 200 && sample.httpStatus < 300;
}

/** Production would admit these bytes: the submission call's raw text passes `decodeQualitySubmission`. */
function admissible(sample: AnswerSubmissionProbeSample): boolean {
  return completed(sample) && sample.toolCallPresent && sample.decode === "admitted";
}

/** An HTTP response outside 2xx: the route refused the request. */
function refusedByHttp(sample: AnswerSubmissionProbeSample): boolean {
  return sample.httpStatus !== 0 && !completed(sample);
}

/**
 * A completed sample production would not admit: a submission call the
 * decoder refuses, or no submission call at all, so the shell cannot carry
 * every answer. A call cut at the output limit is not one; it is the
 * output-allowance cause.
 */
function shellFailure(sample: AnswerSubmissionProbeSample): boolean {
  return completed(sample) && sample.finishReason !== "length" && !admissible(sample);
}

/** A variant whose completed samples all came back without a tool call. */
function silent(sent: readonly AnswerSubmissionProbeSample[]): boolean {
  const done = sent.filter(completed);
  return done.length > 0 && done.every((sample) => !sample.toolCallPresent);
}

/** A shell or decoder failure in a variant that is not wholly silent, which is its own cause. */
function shellFailureIn(sent: readonly AnswerSubmissionProbeSample[]): boolean {
  return !silent(sent) && sent.some(shellFailure);
}

/** A member arrived as a JSON string. */
function stringifiedMembers(sample: AnswerSubmissionProbeSample): boolean {
  return (
    sample.memberEncoding?.evaluation === "string" ||
    sample.memberEncoding?.qualityScore === "string"
  );
}

/**
 * Run the probe and apply its gate (design §10). The plan is V1 under the
 * untyped shell; V2 typed only when V1 is not usable; then V3, V4, and V6
 * under the chosen shell. A refused (HTTP 4xx or 5xx) request, or a variant
 * whose completed samples carry no tool call, ends the probe. V6 runs on the
 * bound attempt timer, and only V6 is re-sent after a transport failure,
 * within `transportRetries`. The verdict names the first cause that applies:
 * a shell or decoder failure in a completed sample; then a V6 cut, byte
 * bound, or timer fit; then a missing tool call; then an HTTP refusal; then
 * unrecovered transport failures, which are `inconclusive`, never GO.
 */
export async function probeAnswerSubmission(
  target: AnswerSubmissionProbeTarget,
): Promise<AnswerSubmissionProbeVerdict> {
  const largeObject = answerSubmissionProbeObject(ANSWER_SUBMISSION_PROBE_SEED);
  const samples: AnswerSubmissionProbeSample[] = [];
  const finalize = target.finalizeBody ?? ((body: Record<string, unknown>) => body);
  let retriesLeft = target.transportRetries;

  const sendOne = async (
    request: VariantRequest,
    round: AnswerSubmissionProbeSample["round"],
    retryOf: number | null,
  ): Promise<number> => {
    const turn = await streamChatCompletion(target.provider, finalize(request.body), {
      fetch: target.fetch,
      timeoutMs: request.variant === "V6" ? target.largeVariantTimeoutMs : target.timeoutMs,
      errorBodyMaxChars: target.errorBodyMaxChars,
      credentialEchoMinChars: target.credentialEchoMinChars,
      ...(target.now ? { now: target.now } : {}),
    });
    samples.push(sampleOf(request, round, turn, largeObject, retryOf));
    return samples.length - 1;
  };
  /** A V6 timeout that recurred on its re-send while output was still streaming. */
  const timerFit = (sent: readonly AnswerSubmissionProbeSample[]): boolean =>
    sent.some((retry) => {
      if (retry.retryOf === null) return false;
      const original = samples[retry.retryOf]!;
      return (
        original.transportError === "timeout" &&
        retry.transportError === "timeout" &&
        (original.streamedBytes ?? 0) > 0 &&
        (retry.streamedBytes ?? 0) > 0
      );
    });
  const send = async (
    request: VariantRequest,
    round: AnswerSubmissionProbeSample["round"],
  ): Promise<AnswerSubmissionProbeSample[]> => {
    const sent: number[] = [];
    for (let count = 0; count < target.samplesPerVariant; count += 1) {
      const index = await sendOne(request, round, null);
      sent.push(index);
      const sample = samples[index]!;
      if (refusedByHttp(sample)) break;
      if (request.variant !== "V6" || sample.transportError === null) continue;
      if (sample.transportError === "byte-bound") break;
      if (retriesLeft > 0) {
        retriesLeft -= 1;
        samples[index] = { ...sample, retried: true };
        const retry = await sendOne(request, round, index);
        sent.push(retry);
        if (refusedByHttp(samples[retry]!) || samples[retry]!.transportError === "byte-bound") {
          break;
        }
        if (timerFit([samples[retry]!])) break;
      }
    }
    return sent.map((index) => samples[index]!);
  };
  /** A refused request, or a variant whose completed samples carry no tool call. */
  const hardStop = (sent: readonly AnswerSubmissionProbeSample[]): boolean =>
    sent.some(refusedByHttp) || silent(sent);
  /**
   * Stop before the typed-shell contingency, which the operator did not opt
   * into. The contingency is V2, V3, V4, and V6 under the typed shell, plus
   * whatever V6 transport retries remain.
   */
  const contingencyRequired = (
    reason: string,
    at: "shell-choice" | "fidelity",
  ): AnswerSubmissionProbeVerdict => {
    const contingencyRequests =
      CONTINGENCY_VARIANTS.length * target.samplesPerVariant + retriesLeft;
    // The rerun bound covers the worst rerun, whatever this run saw: the
    // route may serve V1 usably next time and then fail untyped V4 or V6, so
    // a rerun can send the whole untyped round before the contingency. When
    // V1 is unusable again, the rerun goes straight to the typed shell, which
    // the next action states as the expected figure.
    const rerunMaxRequests =
      (NOMINAL_VARIANTS.length + CONTINGENCY_VARIANTS.length) * target.samplesPerVariant +
      target.transportRetries;
    const expected =
      at === "shell-choice"
        ? ` (${String(
            (SHELL_CHOICE_VARIANTS.length + CONTINGENCY_VARIANTS.length) *
              target.samplesPerVariant +
              target.transportRetries,
          )} if V1 is unusable again)`
        : "";
    const retained = observation();
    return {
      decision: "contingency-required",
      reason,
      contingencyRequests,
      rerunMaxRequests,
      nextAction: `Ask the cost owner to approve the typed-shell contingency (up to ${String(contingencyRequests)} more requests; a rerun sends at most ${String(rerunMaxRequests)} in all${expected}), then run docsfab doctor --live --answer-submission --answer-submission-typed-contingency.`,
      observation: retained,
      evidenceSha256: canonicalDigest(retained),
    };
  };
  const usable = (sent: readonly AnswerSubmissionProbeSample[]): boolean =>
    sent.filter(admissible).length === target.samplesPerVariant && sent.every(admissible);

  const observation = (): AnswerSubmissionProbeObservation => ({
    schemaVersion: 2,
    kind: ANSWER_SUBMISSION_PROBE_KIND,
    modelId: target.modelId,
    maxOutputTokens: target.maxOutputTokens,
    samplesPerVariant: target.samplesPerVariant,
    largeObjectSeed: ANSWER_SUBMISSION_PROBE_SEED,
    samples: [...samples],
  });
  const noGo = (
    cause: Extract<AnswerSubmissionProbeVerdict, { decision: "no-go" }>["cause"],
    reason: string,
    nextAction = NEXT_ACTION,
  ): AnswerSubmissionProbeVerdict => {
    const retained = observation();
    return {
      decision: "no-go",
      stopClass: "provider-compatibility",
      cause,
      reason,
      nextAction,
      observation: retained,
      evidenceSha256: canonicalDigest(retained),
    };
  };

  // What the gate reads: the shell-choice variants and the last fidelity
  // round under the chosen shell.
  let v1: readonly AnswerSubmissionProbeSample[] = [];
  let v2: readonly AnswerSubmissionProbeSample[] | undefined;
  let shell: Shell | undefined;
  let measured:
    | {
        readonly v3: readonly AnswerSubmissionProbeSample[];
        readonly v4: readonly AnswerSubmissionProbeSample[];
        readonly v6: readonly AnswerSubmissionProbeSample[];
      }
    | undefined;

  const judge = (): AnswerSubmissionProbeVerdict => {
    // 1. A shell or decoder failure in a completed sample.
    if (shellFailureIn(v1) && v2 !== undefined && shellFailureIn(v2)) {
      return noGo(
        "no-usable-shell",
        "Neither argument shell carried a submission the production decoder admits in every completed sample.",
      );
    }
    if (measured && (shellFailureIn(measured.v4) || shellFailureIn(measured.v6))) {
      return noGo(
        "arguments-not-strict",
        `Under the ${shell ?? "untyped"} shell, a completed V4 or V6 sample carried no submission call, or arguments the production decoder refused, so production would not admit every real submission of that shape.`,
      );
    }
    // 2. The realistic submission does not fit the production bounds.
    const v6 = measured?.v6 ?? [];
    if (v6.some((sample) => completed(sample) && sample.finishReason === "length")) {
      return noGo(
        "output-allowance-reached",
        `A V6 sample ended finish_reason=length at the bound output limit of ${String(target.maxOutputTokens)} tokens, so production would cut a realistic submission.`,
        "Measure the evaluation's submission size against the bound output limit, then run docsfab doctor --live --answer-submission again.",
      );
    }
    if (v6.some((sample) => sample.transportError === "byte-bound")) {
      return noGo(
        "response-byte-bound",
        "A V6 response exceeded the provider response byte bound, so production would refuse a realistic submission's response.",
      );
    }
    if (timerFit(v6)) {
      return noGo(
        "timer-fit",
        `A V6 request timed out at the bound attempt timer (${String(target.largeVariantTimeoutMs)} ms) while output was still streaming, and again when it was re-sent, so a realistic submission does not fit the production timer.`,
      );
    }
    // 3. A required call that never carried a tool call.
    const sentVariants = [v1, v2 ?? [], measured?.v3 ?? [], measured?.v4 ?? [], v6];
    const silentVariant = sentVariants.find(silent);
    if (silentVariant) {
      return noGo(
        "tool-call-not-returned",
        `No completed ${silentVariant[0]!.variant} sample returned a tool call although tool_choice was required.`,
      );
    }
    // 4. An HTTP refusal.
    const refusal = samples.find(refusedByHttp);
    if (refusal) {
      return noGo(
        "provider-request-refused",
        `The route refused the ${refusal.variant} tools request with HTTP ${String(refusal.httpStatus)}.`,
      );
    }
    // 5. Unrecovered transport failures, or a plan that could not finish.
    const relevant = measured ? [...measured.v3, ...measured.v4, ...measured.v6] : samples;
    const recovered = new Set(
      samples
        .filter((sample) => sample.retryOf !== null && completed(sample))
        .map((sample) => sample.retryOf),
    );
    const unrecovered = relevant.filter(
      (sample) => sample.transportError !== null && !recovered.has(samples.indexOf(sample)),
    );
    if (!measured || !shell || unrecovered.length > 0) {
      const failures = samples.filter((sample) => sample.transportError !== null);
      const retained = observation();
      return {
        decision: "inconclusive",
        reason: `${String(failures.length)} request(s) ended without an HTTP response, so the probe could not complete its plan.`,
        transportErrors: failures.map((sample) => ({
          variant: sample.variant,
          class: sample.transportError!,
          elapsedMs: sample.elapsedMs ?? 0,
          streamedBytes: sample.streamedBytes ?? 0,
          retried: sample.retried,
        })),
        nextAction: INCONCLUSIVE_NEXT_ACTION,
        observation: retained,
        evidenceSha256: canonicalDigest(retained),
      };
    }
    // GO.
    const shellSamples = [
      ...(shell === "untyped" ? v1 : (v2 ?? [])),
      ...measured.v3,
      ...measured.v4,
      ...measured.v6,
    ].filter((sample) => completed(sample) && sample.memberEncoding !== null);
    const stringCount = shellSamples.filter(stringifiedMembers).length;
    const capability: InstalledAnswerSubmission = {
      kind: "host-tool-call",
      argumentShell: shell,
      duplicateKeys: measured.v3.some((sample) => sample.duplicatePresent)
        ? "forwarded"
        : "unobserved",
      reportTurnToolChoice: "auto",
      objectMembers:
        stringCount === 0
          ? "object"
          : stringCount === shellSamples.length
            ? "stringified"
            : "mixed",
      evidenceSha256: "",
    };
    const retained = observation();
    const evidenceSha256 = canonicalDigest(retained);
    const notes = [
      ...(capability.duplicateKeys === "unobserved"
        ? [
            "Duplicate-key detection is unverified on this route: no V3 sample forwarded the duplicate.",
          ]
        : []),
      ...(measured.v6.some((sample) => sample.deepEqual === false)
        ? [
            "A V6 sample decoded as strict JSON but did not equal the host's object (a copying slip, recorded only).",
          ]
        : []),
      ...(shell === "typed" ? ["The typed shell was chosen as the contingency."] : []),
    ];
    return {
      decision: "go",
      capability: { ...capability, evidenceSha256 },
      observation: retained,
      evidenceSha256,
      notes,
    };
  };

  const smallText = JSON.stringify(SMALL_OBJECT);
  const fidelity = async (
    chosen: Shell,
    round: AnswerSubmissionProbeSample["round"],
  ): Promise<boolean> => {
    const v3 = await send(callVariant(target, "V3", chosen, DUPLICATE_KEY_TEXT), round);
    measured = { v3, v4: [], v6: [] };
    if (hardStop(v3)) return false;
    const v4 = await send(
      callVariant(target, "V4", chosen, JSON.stringify(LINE_BREAK_OBJECT)),
      round,
    );
    measured = { v3, v4, v6: [] };
    if (hardStop(v4)) return false;
    const v6 = await send(callVariant(target, "V6", chosen, JSON.stringify(largeObject)), round);
    measured = { v3, v4, v6 };
    return !hardStop(v6);
  };
  const sendTyped = async (round: AnswerSubmissionProbeSample["round"]): Promise<boolean> => {
    v2 = await send(callVariant(target, "V2", "typed", smallText), round);
    return !hardStop(v2) && usable(v2);
  };

  v1 = await send(callVariant(target, "V1", "untyped", smallText), "first");
  if (hardStop(v1)) return judge();
  if (usable(v1)) shell = "untyped";
  else if (v1.some(shellFailure)) {
    if (!target.typedContingency) {
      return contingencyRequired(
        "A completed V1 sample under the untyped shell carried no submission call, or arguments the production decoder refused, so only the typed shell can qualify the route.",
        "shell-choice",
      );
    }
    if (!(await sendTyped("first"))) return judge();
    shell = "typed";
  } else return judge();

  if (!(await fidelity(shell, "first"))) return judge();
  const strictFailure = shellFailureIn(measured!.v4) || shellFailureIn(measured!.v6);
  const fits =
    !measured!.v6.some(
      (sample) =>
        (completed(sample) && sample.finishReason === "length") ||
        sample.transportError === "byte-bound",
    ) && !timerFit(measured!.v6);
  if (strictFailure && fits && shell === "untyped") {
    if (!target.typedContingency) {
      return contingencyRequired(
        "Under the untyped shell, a completed V4 or V6 sample carried no submission call, or arguments the production decoder refused, so only the typed shell can qualify the route.",
        "fidelity",
      );
    }
    // The typed contingency: V2, then V3, V4, and V6 typed.
    if (v2 === undefined ? await sendTyped("contingency") : usable(v2)) {
      shell = "typed";
      await fidelity(shell, "contingency");
    }
  }
  return judge();
}
