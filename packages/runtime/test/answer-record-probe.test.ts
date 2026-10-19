// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The answer-record premise probe (#1967, `docsfab doctor --live
 * --answer-records`, design §6.1, MR 1a) over offline SSE fixtures: GO, each
 * NO-GO cause, transport retries, a proxy refusal, the input-token guard, the
 * timing fields, and the retained content-free observation whose digest is
 * its `evidenceSha256`.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { rm as rmPromise, writeFile as writeFilePromise } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseDoctorArguments } from "../src/cli/profile-arguments.js";
import { limit } from "../src/config/limits.js";
import { canonicalDigest, canonicalJson } from "../src/content-ir/canonical.js";
import {
  answerRecordProbeExitCode,
  answerRecordProbeResult,
  answerRecordTypedLedger,
  formatAnswerRecordProbe,
  formatAnswerRecordProbePlan,
  planAnswerRecordDiagnostic,
  planAnswerRecordQualification,
  probeConfiguredAnswerRecords,
  recordAnswerRecordProbe,
  ANSWER_RECORD_LEDGER_LOCK,
  ANSWER_RECORD_TYPED_CONTEXT_PARTIAL_EVIDENCE_SHA256,
  type AnswerRecordProbeFiles,
} from "../src/doctor.js";
import { OutboundProxyRefusal } from "../src/model/outbound-http-policy.js";
import { resolveOperatorExecutionBinding } from "../src/model/operator-execution-binding.js";
import { DOCSFAB_SYSTEM_PROMPT } from "../src/model/request-policy.js";
import {
  ANSWER_RECORD_CORPUS_SHA256,
  ANSWER_RECORD_PREMISE_EVIDENCE_SHA256,
  ANSWER_RECORD_RESERVATION_KIND,
  ANSWER_RECORD_TYPES,
  ANSWER_RECORD_TOOL_NAME,
  AnswerRecordCorpusError,
  answerRecordTool,
  buildAnswerRecordQualificationPlan,
  buildAnswerRecordDiagnosticPlan,
  decodeAnswerRecordArguments,
  decodeAnswerRecordCorpus,
  exactQualificationEvidence,
  isAnswerRecordExactQualificationEvidence,
  loadPiToolArgumentValidation,
  messageBudgetBytes,
  probeAnswerRecords,
  sampleDecodeRate,
  type AnswerRecordCorpus,
  type AnswerRecordProbePlan,
  type AnswerRecordProbeTarget,
  type AnswerRecordProbeVerdict,
  type AnswerRecordType,
} from "../src/profile/answer-record-probe.js";
import { captureProxyRefusal } from "../src/profile/endpoint-compatibility.js";
import { validModelConfig } from "./helpers.js";
import { internalOnly } from "./helpers/internal-path.js";
import { sseResponse } from "./support/pi-harness-session-fixtures.js";
import { releasedProbeProvider } from "./helpers/released-probe-provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const CORPUS_FILE =
  "packages/runtime/docs/internal/evidence/answer-record-corpus-2026-10/corpus.json";
const OBSERVATIONS_DIRECTORY =
  "packages/runtime/docs/internal/evidence/answer-record-corpus-2026-10/probe-observations";
const corpusFile = internalOnly(
  [CORPUS_FILE, OBSERVATIONS_DIRECTORY],
  "the probe sends the committed record corpus and reads the retained premise observation, which are not exported",
);
/** Tests that send or read the committed corpus; they skip only in the exported tree. */
const describeCorpus = describe.skipIf(corpusFile.skip);
const CORPUS_PATH = fileURLToPath(new URL(`../../../${CORPUS_FILE}`, import.meta.url));
/** The retained premise-run observation, the ledger every small-group run starts from. */
const PREMISE_FILE = `${ANSWER_RECORD_PREMISE_EVIDENCE_SHA256}.json`;
const RETAINED_K_FILE = "6f1add22933da65d6eaa88a726dbfa983d8fbd27b28b93eb2e33c61e06e02077.json";
const RETAINED_A_T_FILE = "44e76d415b9e4f285a7b7c2f9183f34f347d9d30463391bf19baf74d96d72bb3.json";
const OBSERVATIONS_PATH = fileURLToPath(
  new URL(`../../../${OBSERVATIONS_DIRECTORY}`, import.meta.url),
);
const CORPUS_TEXT = corpusFile.skip ? "" : readFileSync(CORPUS_PATH, "utf8");
const CORPUS = (corpusFile.skip ? undefined : decodeAnswerRecordCorpus(CORPUS_TEXT))!;
const PI = (await loadPiToolArgumentValidation())!;

type Phase = "A" | "A-t" | "A-t-context" | "B" | "C" | "K";

interface RecordRequest {
  readonly phase: Phase;
  /** The argument texts the prompt asks for, in order. */
  readonly calls: readonly string[];
  readonly body: Record<string, any>;
}

/**
 * The phase and the asked-for calls of one probe request, read from its
 * prompt. Phases B and K share the padded message prompt; `padded` names
 * which one the run sends.
 */
function classify(
  body: Record<string, any>,
  padded: "A-t-context" | "B" | "K" = "B",
): RecordRequest {
  const prompt = String(body.messages.find((m: { role: string }) => m.role === "user").content);
  const lines = prompt.split("\n");
  if (prompt.includes("Reading context")) {
    const calls: string[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (/^Call \d+:$/u.test(lines[index]!)) calls.push(lines[index + 1]!);
    }
    return { phase: padded, calls, body };
  }
  const call = lines.at(-1)!;
  const typed = body.tools?.[0]?.function?.parameters?.properties?.type?.enum !== undefined;
  // Phase C's escape mix opens every string it hardens with the same fragment.
  return {
    phase: call.includes('A finding \\"quoted\\"') ? "C" : typed ? "A-t" : "A",
    calls: [call],
    body,
  };
}

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  id: "probe",
  object: "chat.completion.chunk",
  created: 1,
  model: "probe-model",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

function callsReply(
  args: readonly string[],
  finish = "tool_calls",
  usage: Record<string, unknown> = { prompt_tokens: 10, completion_tokens: 5 },
  name = ANSWER_RECORD_TOOL_NAME,
  headers: Record<string, string> = {},
): Response {
  const response = sseResponse([
    chunk({ role: "assistant" }),
    chunk({
      tool_calls: args.map((raw, index) => ({
        index,
        id: `call-${String(index)}`,
        type: "function",
        function: { name, arguments: raw },
      })),
    }),
    { ...chunk({}, finish), usage: { total_tokens: 15, ...usage } },
  ]);
  return Object.keys(headers).length === 0
    ? response
    : new Response(response.body, {
        status: response.status,
        headers: { "content-type": "text/event-stream", ...headers },
      });
}

/** A faithful route: every asked-for call comes back byte for byte. */
const faithful = (request: RecordRequest): Response => callsReply(request.calls);

function replaceFirstString(value: unknown): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    if (value.length === 0) return { value, changed: false };
    const replacement = value[0] === "x" ? "y" : "x";
    return { value: `${replacement}${value.slice(1)}`, changed: true };
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const result = replaceFirstString(value[index]);
      if (result.changed) {
        value[index] = result.value;
        return { value, changed: true };
      }
    }
  } else if (typeof value === "object" && value !== null) {
    for (const [key, field] of Object.entries(value)) {
      const result = replaceFirstString(field);
      if (result.changed) {
        (value as Record<string, unknown>)[key] = result.value;
        return { value, changed: true };
      }
    }
  }
  return { value, changed: false };
}

type Answer = (request: RecordRequest, nth: number) => Response | Promise<Response>;

function route(
  answer: Answer,
  padded: "A-t-context" | "B" | "K" = "B",
): { fetch: typeof fetch; requests: RecordRequest[] } {
  const requests: RecordRequest[] = [];
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    const request = classify(JSON.parse(String(init?.body)) as Record<string, any>, padded);
    requests.push(request);
    return answer(request, requests.filter((sent) => sent.phase === request.phase).length - 1);
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

function target(
  fetch: typeof globalThis.fetch,
  overrides: Partial<AnswerRecordProbeTarget> = {},
): AnswerRecordProbeTarget {
  const resolved: AnswerRecordProbeTarget = {
    modelId: "probe-model",
    deploymentBinding: {
      status: "bound",
      routeId: "probe-route",
      deploymentIdentitySha256: "a".repeat(64),
      transport: "openai-chat-completions",
    },
    compositionBinding: {
      compositionId: "probe-composition",
      compositionSha256: "b".repeat(64),
      requestPolicySha256: "c".repeat(64),
    },
    provider: releasedProbeProvider("https://probe.example.test/v1", "probe-key"),
    maxOutputTokens: 8192,
    samplesPerRung: 3,
    decodeWindowMinBasisPoints: limit("endpointProbe.answerRecordDecodeWindowMinBasisPoints").value,
    maxProviderTurns: 128,
    answerNowShareBasisPoints: 4000,
    systemPrompt: DOCSFAB_SYSTEM_PROMPT,
    shape: { tokenField: "max_tokens", systemRole: "system", store: false },
    fetch,
    timeoutMs: 5_000,
    transportRetries: 2,
    requestBudget: limit("endpointProbe.answerRecordRequestBudget"),
    inputTokenBudget: limit("endpointProbe.answerRecordInputTokenBudget"),
    corpus: CORPUS,
    corpusSha256: ANSWER_RECORD_CORPUS_SHA256,
    pi: PI,
    errorBodyMaxChars: 400,
    credentialEchoMinChars: 6,
    ...overrides,
  };
  return resolved.qualificationCells && !resolved.expectedQualificationFingerprint
    ? {
        ...resolved,
        expectedQualificationFingerprint:
          buildAnswerRecordQualificationPlan(resolved).qualificationFingerprint,
      }
    : resolved;
}

async function probe(answer: Answer, overrides: Partial<AnswerRecordProbeTarget> = {}) {
  const replay = route(
    answer,
    overrides.selection === "small-groups" ? "K" : overrides.typedContextMix ? "A-t-context" : "B",
  );
  const verdict = await probeAnswerRecords(target(replay.fetch, overrides));
  return { verdict, requests: replay.requests };
}

/** A temporary observation directory holding only the retained premise observation. */
function ledgerDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "docsfab-answer-record-ledger-"));
  writeFileSync(
    join(directory, PREMISE_FILE),
    readFileSync(join(OBSERVATIONS_PATH, PREMISE_FILE), "utf8"),
  );
  return directory;
}

function writeLedgerJson(directory: string, value: unknown): void {
  const text = canonicalJson(value as never);
  const name = `${createHash("sha256").update(text).digest("hex")}.json`;
  writeFileSync(join(directory, name), text);
}

/** What a run charged: each sample at the larger of its reported and estimated input. */
function chargedBy(
  samples: readonly { promptTokens: number | null; estimatedInputTokens: number }[],
): number {
  return samples.reduce(
    (sum, sample) => sum + Math.max(sample.promptTokens ?? 0, sample.estimatedInputTokens),
    0,
  );
}

/** Thrown from `onPlan` to stop a run after its plan and before any request. */
const STOP_AT_PLAN = new Error("stop at the plan");

/**
 * The small-group plan the guarded entry would send from `directory`, read
 * through `onPlan` and stopped there, or the refusal it gives instead.
 */
async function planOf(
  directory: string,
): Promise<AnswerRecordProbePlan | { decision: "not-checked"; code?: string; reason: string }> {
  let shown: AnswerRecordProbePlan | undefined;
  try {
    const { verdict } = await recordAnswerRecordProbe(SUPER, {
      corpusPath: CORPUS_PATH,
      selection: "small-groups",
      observationDirectory: directory,
      onPlan: (plan) => {
        shown = plan;
        throw STOP_AT_PLAN;
      },
    });
    if (verdict.decision === "not-checked") return verdict;
    throw new Error("the run went past its plan");
  } catch (error) {
    if (error !== STOP_AT_PLAN) throw error;
    return shown!;
  }
}

/** The small-group run's target, its budgets reduced by a ledger that holds the premise run. */
const SMALL_GROUPS: Partial<AnswerRecordProbeTarget> = {
  selection: "small-groups",
  requestBudget: { ...limit("endpointProbe.answerRecordGroupRequestBudget"), value: 11 },
  inputTokenBudget: { ...limit("endpointProbe.answerRecordGroupInputTokenBudget"), value: 521_807 },
  ledger: { observations: 1, reservations: 0, requests: 13, inputTokens: 78_193 },
  onReserve: async () => {},
};

function expectDecision<D extends AnswerRecordProbeVerdict["decision"]>(
  verdict: AnswerRecordProbeVerdict,
  decision: D,
): Extract<AnswerRecordProbeVerdict, { decision: D }> {
  if (verdict.decision !== decision) {
    throw new Error(`expected ${decision}, got ${verdict.decision}: ${JSON.stringify(verdict)}`);
  }
  return verdict as Extract<AnswerRecordProbeVerdict, { decision: D }>;
}

const phases = (requests: readonly RecordRequest[]) => requests.map((request) => request.phase);
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

describeCorpus(corpusFile.title("the answer-record corpus"), () => {
  it("decodes the committed corpus, built from the fixtures it names", () => {
    expect(CORPUS.padding.targetTokens).toBe(60_588);
    const provenance = CORPUS.provenance as {
      fixtures: Array<{ path: string; sha256: string }>;
    };
    expect(provenance.fixtures).toHaveLength(2);
    for (const fixture of provenance.fixtures) {
      const current = readFileSync(new URL(`../../../${fixture.path}`, import.meta.url));
      expect(createHash("sha256").update(current).digest("hex")).toBe(fixture.sha256);
    }
    const largest = Math.max(...CORPUS.records.map((entry) => bytes(JSON.stringify(entry.record))));
    expect(largest).toBe(2695);
  });

  it("refuses a record whose key does not match its type", () => {
    const tampered = JSON.parse(CORPUS_TEXT) as {
      records: Array<Record<string, unknown>>;
    };
    const finding = tampered.records.find((entry) => entry.type === "finding")!;
    finding.key = "F-1";
    expect(() => decodeAnswerRecordCorpus(JSON.stringify(tampered))).toThrow(
      AnswerRecordCorpusError,
    );
  });
});

describe("the strict record decode", () => {
  const keys = new Map<AnswerRecordType, Set<string>>([
    ["dimension", new Set(["examples"])],
    ["layer-note", new Set(["effective_experience"])],
  ]);
  const decode = (raw: string) => decodeAnswerRecordArguments(raw, keys);

  it("admits an object record, and a record sent as one JSON string", () => {
    expect(decode('{"type":"dimension","key":"examples","record":{"a":1}}')).toMatchObject({
      decode: "admitted",
      recordEncoding: "object",
    });
    expect(
      decode(JSON.stringify({ type: "finding", record: JSON.stringify({ a: 1 }) })),
    ).toMatchObject({ decode: "admitted", recordEncoding: "string" });
    expect(decode('{"type":"quality-score","record":null}')).toMatchObject({
      decode: "admitted",
      recordEncoding: "null",
    });
  });

  it("keeps strict raw null decoding distinct from Pi's optional-null normalization", () => {
    const raw = '{"type":"quality-score","record":null}';
    const tool = answerRecordTool("typed").function;
    expect(tool.parameters.properties.record!.type).toEqual(["object", "string"]);
    const piReturned = PI.validateToolArguments(tool, {
      type: "toolCall",
      id: "quality-score-null",
      name: ANSWER_RECORD_TOOL_NAME,
      arguments: PI.parseStreamingJson(raw),
    });

    // Pi 0.86.0 deletes this optional null because it is outside object|string,
    // then passes the still-valid shell because `record` is not required.
    expect(piReturned).toEqual({ type: "quality-score" });
    expect(decodeAnswerRecordArguments(raw, new Map())).toMatchObject({
      decode: "admitted",
      recordEncoding: "null",
      envelope: { type: "quality-score", record: null },
    });
    expect(bytes(raw)).toBe(38);
  });

  it("refuses duplicates, extra members, unknown keys, and a twice-encoded record", () => {
    expect(decode('{"type":"finding","record":{"a":1,"a":2}}')).toEqual({
      decode: "answer-record-duplicate-key",
      location: "$",
    });
    expect(decode('{"type":"finding","record":{},"extra":1}')).toEqual({
      decode: "answer-record-shape",
      location: "$",
    });
    expect(decode('{"type":"dimension","key":"invented","record":{}}')).toEqual({
      decode: "answer-record-key",
      location: "$.key",
    });
    expect(decode('{"type":"finding","key":"F-1","record":{}}')).toEqual({
      decode: "answer-record-key",
      location: "$.key",
    });
    expect(
      decode(JSON.stringify({ type: "finding", record: JSON.stringify(JSON.stringify({})) })),
    ).toEqual({ decode: "answer-record-shape", location: "$.record" });
    expect(decode('{"type":"finding","record":{"a":"x\ny"}}')).toEqual({
      decode: "answer-record-json",
      location: "$",
    });
  });
});

describeCorpus(corpusFile.title("the answer-record probe gate"), () => {
  it("is GO on a faithful route, within 24 requests, with a content-free observation", async () => {
    let plan: AnswerRecordProbePlan | undefined;
    const { verdict, requests } = await probe(faithful, {
      onPlan: (shown) => {
        plan = shown;
      },
    });

    const result = expectDecision(verdict, "go");
    expect(phases(requests)).toEqual([
      ...Array(12).fill("A"),
      ...Array(9).fill("B"),
      ...Array(3).fill("C"),
    ]);
    expect(result.measurement).toMatchObject({
      maxRecordBytes: 8192,
      // ⌈1.5 × 2,723⌉: the largest corpus call, wrapper included, in the rungs' unit.
      requiredRecordBytes: 4085,
      messageBudgetBytes: 18_743,
      escapeMix: "admitted",
      recordMembers: "object",
      requests: 24,
      transportRetriesUsed: 0,
    });
    expect(result.measurement.maxMessageBytes).toBeLessThanOrEqual(18_743);
    expect(result.evidenceSha256).toBe(canonicalDigest(result.observation));
    expect(result.observation.samples[0]?.transportObservation).toMatchObject({
      streamClass: "done-with-finish",
      stream: {
        eventCount: 3,
        malformedEventCount: 0,
        doneMarkerPresent: true,
        toolCallDeltaCount: 1,
        callStartCount: 1,
        indexedDeltaCount: 1,
        distinctIndexCount: 1,
        identifiedDeltaCount: 1,
        distinctCallIdCount: 1,
        assembledCallCount: 1,
      },
    });
    expect(JSON.stringify(result.observation.samples[0]?.transportObservation)).not.toContain(
      "call-0",
    );
    expect(JSON.stringify(result.observation.samples[0]?.transportObservation)).not.toContain(
      result.observation.samples[0]?.calls[0]?.rawSha256,
    );
    expect(plan).toMatchObject({
      requests: 24,
      paddedRequests: 9,
      paddingTargetTokens: 60_588,
      inputTokenBudget: 600_000,
    });
    expect(plan!.plannedInputTokens).toBeLessThanOrEqual(600_000);
    // At P = 60,588 one more phase B request never fits beside the plan.
    expect(plan!.paddedRetryFits).toBe(false);
    expect(formatAnswerRecordProbePlan(plan!)).toContain(
      "A phase B transport failure cannot be re-sent within that budget and ends the run INCONCLUSIVE.",
    );
    expect(result.observation.skippedPhases).toEqual([]);
    // Phase A asks for exact rungs; phase B's padded prompts reach P but not past it.
    for (const request of requests.filter((sent) => sent.phase === "A")) {
      expect([512, 2048, 4096, 8192]).toContain(bytes(request.calls[0]!));
    }
    for (const sample of result.observation.samples) {
      expect(sample).toHaveProperty("elapsedMs");
      expect(sample).toHaveProperty("ttftMs");
      expect(sample.outputTokens).toBe(5);
      expect(sample.finishReason).toBe("tool_calls");
      expect(sample.calls.every((call) => call.piValidation === "ok" && call.deepEqual)).toBe(true);
      if (sample.phase === "B") {
        expect(sample.estimatedInputTokens).toBeLessThanOrEqual(60_588);
        expect(sample.estimatedInputTokens).toBeGreaterThan(60_000);
        expect(sample.expectedCalls).toBeGreaterThan(1);
      }
    }
    // No record text, prose, or prompt is retained.
    const retained = JSON.stringify(result.observation);
    const rationale = (
      CORPUS.records.find((entry) => entry.type === "dimension")!.record as {
        rationale: string;
      }
    ).rationale;
    expect(retained).not.toContain(rationale);
    expect(retained).not.toContain("Probe request");
  });

  it("sends the production shell: the untyped record tool, tool_choice required, the output limit", async () => {
    const { requests } = await probe(faithful);
    for (const request of requests) {
      expect(request.body).toMatchObject({
        model: "probe-model",
        stream: true,
        max_tokens: 8192,
        tool_choice: "required",
      });
      expect(request.body.tools).toEqual([
        {
          type: "function",
          function: {
            name: ANSWER_RECORD_TOOL_NAME,
            description: expect.any(String),
            parameters: {
              type: "object",
              properties: {
                type: { description: expect.any(String) },
                key: { description: expect.any(String) },
                record: { description: expect.any(String) },
              },
            },
          },
        },
      ]);
    }
    // A leading per-request nonce keeps every prompt distinct, so no prefix cache shortens prefill.
    const prompts = requests.map((request) => request.body.messages[1].content as string);
    expect(new Set(prompts.map((prompt) => prompt.split("\n")[0])).size).toBe(prompts.length);
    // A per-run salt keeps a re-run's prompts distinct from this run's.
    const again = await probe(faithful);
    const opening = (request: RecordRequest) =>
      (request.body.messages[1].content as string).split("\n")[0];
    expect(opening(again.requests[0]!)).not.toBe(opening(requests[0]!));
  });

  it("is NO-GO record-bound-below-record when records above 2 KiB are not strict JSON", async () => {
    const { verdict, requests } = await probe((request) =>
      callsReply(
        request.calls.map((call) => (bytes(call) > 2048 ? call.replace("}", ",}") : call)),
      ),
    );
    const result = expectDecision(verdict, "no-go");
    expect(result.cause).toBe("record-bound-below-record");
    expect(result.stopClass).toBe("provider-compatibility");
    expect(result.measurement.maxRecordBytes).toBe(2048);
    // The ladder stops at the first refused 4 KiB seed and sends no 8 KiB rung,
    // and GO is out of reach, so phases B and C are not sent.
    expect(phases(requests)).toEqual(Array(7).fill("A"));
    expect(result.observation.skippedPhases).toEqual(["B", "C"]);
    expect(result.nextAction).toContain("#1970");
    expect(answerRecordProbeExitCode(result)).toBe(1);
  });

  it("never credits a rung with a condensed copy: a short call is not admitted (B1)", async () => {
    // The model returns a valid, admissible record at 4 and 8 KiB, but only the
    // first evidence item and a one-word rationale: a few hundred bytes.
    const condensed = (call: string): string => {
      const envelope = JSON.parse(call) as {
        record: { evidence: unknown[]; rationale: string };
      };
      envelope.record.evidence = envelope.record.evidence.slice(0, 1);
      envelope.record.rationale = "Condensed.";
      return JSON.stringify(envelope);
    };
    const { verdict, requests } = await probe((request) =>
      request.phase === "A" && bytes(request.calls[0]!) > 2048
        ? callsReply(request.calls.map(condensed))
        : faithful(request),
    );
    const result = expectDecision(verdict, "no-go");
    expect(result.cause).toBe("record-bound-below-record");
    expect(result.measurement.maxRecordBytes).toBe(2048);
    const short = result.observation.samples.find((sample) => sample.failure === "short-copy")!;
    expect(short).toMatchObject({ phase: "A", rungBytes: 4096, admitted: false });
    expect(short.calls[0]).toMatchObject({ piValidation: "ok", decode: "admitted" });
    expect(short.calls[0]!.rawBytes).toBeLessThan(4096);
    expect(phases(requests)).toEqual(Array(7).fill("A"));
  });

  it("takes maxRecordBytes from the bytes the largest admitted rung carried", async () => {
    // A copy with one added space is admitted and carries one byte more than its rung.
    const { verdict } = await probe((request) =>
      request.phase === "A"
        ? callsReply(request.calls.map((call) => call.replace(":", ": ")))
        : faithful(request),
    );
    const result = expectDecision(verdict, "go");
    expect(result.measurement.maxRecordBytes).toBe(8193);
  });

  it("never admits a call cut at the output limit", async () => {
    const { verdict } = await probe((request) =>
      request.phase === "A" && bytes(request.calls[0]!) === 4096
        ? callsReply(request.calls, "length")
        : faithful(request),
    );
    const result = expectDecision(verdict, "no-go");
    expect(result.cause).toBe("record-bound-below-record");
    expect(result.measurement.maxRecordBytes).toBe(2048);
    const cut = result.observation.samples.find((sample) => sample.failure === "length");
    expect(cut).toMatchObject({ phase: "A", rungBytes: 4096, admitted: false });
  });

  it("decides each call with Pi's validation first: a non-object root is a Pi refusal", async () => {
    const { verdict } = await probe((request, nth) =>
      request.phase === "A" && nth === 0 ? callsReply(["[1,2]"]) : faithful(request),
    );
    const result = expectDecision(verdict, "no-go");
    const first = result.observation.samples[0]!;
    expect(first.failure).toBe("pi-validation");
    expect(first.calls[0]).toMatchObject({
      piValidation: "refused",
      decode: "answer-record-shape",
    });
    expect(result.measurement.maxRecordBytes).toBeNull();
  });

  it("is NO-GO r9-one-record-per-message when a message carries only one of its calls", async () => {
    const { verdict, requests } = await probe((request) =>
      request.phase === "B"
        ? callsReply(
            request.calls.slice(0, 1),
            "tool_calls",
            { prompt_tokens: 10, completion_tokens: 5 },
            ANSWER_RECORD_TOOL_NAME,
            { "x-request-id": "private-provider-request-id" },
          )
        : faithful(request),
    );
    const result = expectDecision(verdict, "no-go");
    expect(result.cause).toBe("r9-one-record-per-message");
    expect(result.measurement.maxMessageBytes).toBeNull();
    expect(result.observation.samples.find((sample) => sample.phase === "B")!.failure).toBe(
      "call-count",
    );
    const bObservation = result.observation.samples.find((sample) => sample.phase === "B")!;
    expect(bObservation.transportObservation).toMatchObject({
      requestIdentifier: {
        present: true,
        source: "x-request-id",
        sha256: createHash("sha256").update("private-provider-request-id").digest("hex"),
      },
      streamClass: "done-with-finish",
      stream: {
        toolCallDeltaCount: 1,
        callStartCount: 1,
        distinctIndexCount: 1,
        distinctCallIdCount: 1,
        assembledCallCount: 1,
      },
    });
    expect(JSON.stringify(bObservation.transportObservation)).not.toContain(
      "private-provider-request-id",
    );
    expect(result.evidenceSha256).toBe(canonicalDigest(result.observation));
    // Phase B stops at its first refused seed; GO is then out of reach, so C is not sent.
    expect(phases(requests).filter((phase) => phase === "B")).toHaveLength(1);
    expect(phases(requests).filter((phase) => phase === "C")).toHaveLength(0);
    expect(result.observation.skippedPhases).toEqual(["C"]);
  });

  it("is GO with maxMessageBytes from the largest admitted phase B rung", async () => {
    const { verdict } = await probe((request) =>
      request.phase === "B" && request.calls.join("").length > 10_240
        ? callsReply(request.calls.slice(1))
        : faithful(request),
    );
    const result = expectDecision(verdict, "go");
    const tenKiB = result.observation.samples.filter(
      (sample) => sample.phase === "B" && sample.rungBytes === 10_240,
    );
    expect(result.measurement.maxMessageBytes).toBe(
      Math.min(
        ...tenKiB.map((sample) => sample.calls.reduce((sum, call) => sum + call.rawBytes, 0)),
      ),
    );
    // Messages are packed close to their rung.
    for (const sample of tenKiB) expect(sample.plannedBytes).toBeGreaterThan(10_240 * 0.97);
  });

  it("is NO-GO r9 when the output limit's budget term is below the 6 KiB rung (NB2)", async () => {
    const { verdict, requests } = await probe(faithful, { maxOutputTokens: 2048 });
    const result = expectDecision(verdict, "no-go");
    expect(result.cause).toBe("r9-one-record-per-message");
    expect(result.reason).toContain("below the 6144-byte rung");
    expect(phases(requests).filter((phase) => phase === "C")).toHaveLength(0);
  });

  it("is NO-GO escape-mix-not-admitted when phase C's escapes arrive unescaped", async () => {
    const { verdict } = await probe((request) =>
      request.phase === "C"
        ? callsReply(request.calls.map((call) => call.replaceAll("\\n", "\n")))
        : faithful(request),
    );
    const result = expectDecision(verdict, "no-go");
    expect(result.cause).toBe("escape-mix-not-admitted");
    expect(result.measurement.escapeMix).toBe("refused");
    const escapeSamples = result.observation.samples.filter((sample) => sample.phase === "C");
    expect(escapeSamples.every((sample) => sample.escapesPerKiB > 10)).toBe(true);
    // Pi's lenient parse takes the raw line breaks; only the strict decode refuses.
    expect(escapeSamples[0]!.calls[0]).toMatchObject({
      piValidation: "ok",
      decode: "answer-record-json",
    });
  });

  it("excuses a phase C refusal above the measured record bound", async () => {
    // Records above 4 KiB fail, so maxRecordBytes is 4096; the escape record's
    // forwarded bytes grow past it when the route spaces out its members.
    const { verdict } = await probe((request) => {
      if (request.phase === "A" && bytes(request.calls[0]!) > 4096) {
        return callsReply(request.calls, "length");
      }
      if (request.phase === "C") {
        return callsReply(
          request.calls.map((call) => call.replaceAll(',"', ', "')),
          "length",
        );
      }
      return faithful(request);
    });
    const result = expectDecision(verdict, "go");
    expect(result.measurement.maxRecordBytes).toBe(4096);
    expect(result.measurement.escapeMix).toBe("admitted");
  });

  it("never excuses a phase C decode refusal, even above the record bound (NB7)", async () => {
    // Records above 4 KiB are cut, so maxRecordBytes is 4096; the route escapes
    // non-ASCII text and spaces its members, which takes C past 4096 bytes, and
    // sends raw line breaks, a decode refusal.
    const asciiEscaped = (call: string): string =>
      call.replace(/[^\x00-\x7f]/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
    const { verdict } = await probe((request) => {
      if (request.phase === "A" && bytes(request.calls[0]!) > 4096) {
        return callsReply(request.calls, "length");
      }
      if (request.phase === "C") {
        return callsReply(
          request.calls.map((call) =>
            asciiEscaped(call).replaceAll("\\n", "\n").replaceAll('":', '": '),
          ),
        );
      }
      return faithful(request);
    });
    const result = expectDecision(verdict, "no-go");
    expect(result.cause).toBe("escape-mix-not-admitted");
    const escaped = result.observation.samples.filter((sample) => sample.phase === "C");
    expect(escaped.every((sample) => sample.calls[0]!.rawBytes > 4096)).toBe(true);
  });

  it("is NO-GO provider-request-refused and stops at an HTTP refusal", async () => {
    const { verdict, requests } = await probe(
      () => new Response('{"error":"tools unsupported"}', { status: 400 }),
    );
    const result = expectDecision(verdict, "no-go");
    expect(result.cause).toBe("provider-request-refused");
    expect(requests).toHaveLength(1);
  });
});

/** A cut connection, as undici reports one. */
function connectionReset(): Promise<Response> {
  return Promise.reject(
    new TypeError("terminated", {
      cause: Object.assign(new Error("other side closed"), { code: "ECONNRESET" }),
    }),
  );
}

describeCorpus(corpusFile.title("transport retries and the input-token budget"), () => {
  it("re-sends a reset once and is GO when the re-send completes", async () => {
    const { verdict, requests } = await probe((request, nth) =>
      request.phase === "A" && nth === 4 ? connectionReset() : faithful(request),
    );
    const result = expectDecision(verdict, "go");
    expect(requests).toHaveLength(25);
    expect(result.measurement.transportRetriesUsed).toBe(1);
    const failed = result.observation.samples.findIndex((sample) => sample.transportError !== null);
    expect(result.observation.samples[failed]).toMatchObject({
      retried: true,
      transportError: "reset",
    });
    expect(result.observation.samples[failed + 1]).toMatchObject({
      retryOf: failed,
      admitted: true,
    });
  });

  it("spends at most answerRecordTransportRetries re-sends, then is inconclusive", async () => {
    expect(limit("endpointProbe.answerRecordTransportRetries").value).toBe(2);
    const { verdict, requests } = await probe((request) =>
      request.phase === "C" ? connectionReset() : faithful(request),
    );
    const result = expectDecision(verdict, "inconclusive");
    expect(requests).toHaveLength(26);
    expect(result.measurement.transportRetriesUsed).toBe(2);
    expect(result.transportErrors).toHaveLength(5);
    expect(result.measurement.escapeMix).toBe("unmeasured");
    expect(formatAnswerRecordProbe(result, "/state/probe.json").join("\n")).toContain(
      "Answer record probe: INCONCLUSIVE (26 requests",
    );
    const json = answerRecordProbeResult(result, "/state/probe.json");
    expect(json).not.toHaveProperty("stopClass");
    expect(answerRecordProbeExitCode(result)).toBe(1);
  });

  it("withholds a phase B re-send that would cross the input-token budget", async () => {
    const { verdict, requests } = await probe((request, nth) =>
      request.phase === "B" && nth === 0 ? connectionReset() : faithful(request),
    );
    const result = expectDecision(verdict, "inconclusive");
    // The reset B sample is not re-sent: 9 × P plus the rest leaves no room for another P.
    expect(requests.filter((request) => request.phase === "B")).toHaveLength(1);
    expect(result.observation.samples.find((sample) => sample.phase === "B")).toMatchObject({
      retried: false,
      retryWithheld: "input-budget",
    });
    expect(result.transportErrors).toEqual([
      expect.objectContaining({ phase: "B", retried: false, retryWithheld: "input-budget" }),
    ]);
    expect(result.reason).toContain("1 not re-sent because the re-send does not fit");
    const lines = formatAnswerRecordProbe(result).join("\n");
    expect(lines).toContain("not re-sent: the re-send does not fit the input-token budget");
    expect(lines).toContain("A re-run is outside the approved O10 spend");
    // GO can no longer be reached, so phase C is not sent.
    expect(requests.filter((request) => request.phase === "C")).toHaveLength(0);
  });

  it("charges phase B at the worst input ratio phases before it reported, so it cannot overrun (NB4)", async () => {
    // Every request reports twice its prompt's characters, about six times the
    // host estimate. Phase B's first request is the one an estimate-only guard
    // would under-charge.
    const small: AnswerRecordCorpus = {
      ...CORPUS,
      padding: { ...CORPUS.padding, targetTokens: 2000 },
    };
    const heavy = (request: RecordRequest) =>
      callsReply(request.calls, "tool_calls", {
        prompt_tokens: 2 * String(request.body.messages[1].content).length,
        completion_tokens: 5,
      });
    const generous = { ...limit("endpointProbe.answerRecordInputTokenBudget"), value: 10_000_000 };
    const dry = await probe(heavy, { corpus: small, inputTokenBudget: generous });
    const samples = dry.verdict.observation.samples;
    const charge = (sample: (typeof samples)[number]) =>
      Math.max(sample.promptTokens ?? 0, sample.estimatedInputTokens);
    const spentA = samples
      .filter((sample) => sample.phase === "A")
      .reduce((sum, sample) => sum + charge(sample), 0);
    const firstB = samples.find((sample) => sample.phase === "B")!;
    // A budget that fits phase A plus phase B's first estimate, but not its real input.
    const value =
      spentA +
      firstB.estimatedInputTokens +
      Math.floor((charge(firstB) - firstB.estimatedInputTokens) / 2);
    expect(dry.verdict.observation.plan.plannedInputTokens).toBeLessThanOrEqual(value);
    const budget = { ...generous, value };

    const { verdict, requests } = await probe(heavy, { corpus: small, inputTokenBudget: budget });

    const spent = verdict.observation.samples.reduce((sum, sample) => sum + charge(sample), 0);
    expect(spent).toBeLessThanOrEqual(value);
    expect(requests.filter((request) => request.phase === "B")).toHaveLength(0);
    expect(expectDecision(verdict, "inconclusive").observation.withheldForInputBudget).toBe(1);
  });

  it("skips phases B and C when phase A ends unmeasured below the GO bound (NB3)", async () => {
    const { verdict, requests } = await probe((request) =>
      request.phase === "A" && bytes(request.calls[0]!) === 512
        ? connectionReset()
        : faithful(request),
    );
    const result = expectDecision(verdict, "inconclusive");
    // The first 512-byte seed resets twice and the second seed's re-send resets too;
    // nothing past phase A is sent.
    expect(phases(requests).every((phase) => phase === "A")).toBe(true);
    expect(result.observation.skippedPhases).toEqual(["B", "C"]);
    expect(result.notes.join(" ")).toContain("Phase B and C not sent");
  });

  it("refuses before any request when the plan exceeds the approved input tokens", async () => {
    const heavy: AnswerRecordCorpus = {
      ...CORPUS,
      padding: { ...CORPUS.padding, targetTokens: 70_000 },
    };
    const replay = route(faithful);
    await expect(probeAnswerRecords(target(replay.fetch, { corpus: heavy }))).rejects.toMatchObject(
      {
        code: "endpoint-probe-answer-record-input-token-budget",
      },
    );
    expect(replay.requests).toHaveLength(0);
  });

  it("refuses before any request when the plan exceeds the approved request count", async () => {
    const replay = route(faithful);
    await expect(
      probeAnswerRecords(target(replay.fetch, { samplesPerRung: 4 })),
    ).rejects.toMatchObject({ code: "endpoint-probe-answer-record-request-budget" });
    expect(replay.requests).toHaveLength(0);
  });

  it("withholds requests once the provider's reported input would cross the budget", async () => {
    const { verdict, requests } = await probe((request) =>
      callsReply(request.calls, "tool_calls", {
        prompt_tokens: request.phase === "B" ? 75_000 : 10,
        completion_tokens: 5,
      }),
    );
    // Phase B's 6 KiB and 10 KiB rungs fit; the top rung's second seed would cross
    // 600,000, so it is withheld and the ladder sends no third.
    const result = expectDecision(verdict, "go");
    expect(result.observation.withheldForInputBudget).toBe(1);
    expect(result.notes.join(" ")).toContain("withheld to stay within the input-token budget");
    expect(requests.filter((request) => request.phase === "B")).toHaveLength(7);
    const spent = result.observation.samples.reduce(
      (sum, sample) => sum + Math.max(sample.promptTokens ?? 0, sample.estimatedInputTokens),
      0,
    );
    expect(spent).toBeLessThanOrEqual(600_000);
    const tenKiB = result.observation.samples.filter(
      (sample) => sample.phase === "B" && sample.rungBytes === 10_240,
    );
    expect(result.measurement.maxMessageBytes).toBe(
      Math.min(...tenKiB.map((sample) => sample.plannedBytes)),
    );
  });
});

describeCorpus(corpusFile.title("a proxy refusal"), () => {
  it("stops the probe with the proxy's own code after the first request", async () => {
    let sent = 0;
    const capture = captureProxyRefusal(async () => {
      sent += 1;
      throw new OutboundProxyRefusal("unreachable", "The proxy refused the connection.");
    });
    await expect(
      probeAnswerRecords(target(capture.fetch, { throwIfRefused: () => capture.throwIfRefused() })),
    ).rejects.toMatchObject({ code: "outbound-proxy-unreachable" });
    expect(sent).toBe(1);
  });
});

/** A test clock the scripted streams advance as they are read. */
function testClock() {
  let now = 0;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

interface StreamStep {
  /** Milliseconds the clock moves before this read returns. */
  readonly after: number;
  /** SSE events delivered together in this read. */
  readonly events: readonly unknown[];
}

/** An SSE response whose reads move the test clock: the shape of a provider's stream over time. */
function scriptedReply(clock: ReturnType<typeof testClock>, steps: readonly StreamStep[]) {
  const encoder = new TextEncoder();
  const reads = [
    ...steps.map((step) => ({
      after: step.after,
      text: step.events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    })),
    { after: 0, text: "data: [DONE]\n\n" },
  ];
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= reads.length) {
          controller.close();
          return;
        }
        const read = reads[index++]!;
        clock.advance(read.after);
        controller.enqueue(encoder.encode(read.text));
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

/** One tool-call argument delta: `text` appended to call `index`'s arguments. */
function argumentDelta(index: number, text: string, first: boolean) {
  return chunk({
    tool_calls: [
      {
        index,
        ...(first
          ? {
              id: `call-${String(index)}`,
              type: "function",
              function: { name: ANSWER_RECORD_TOOL_NAME, arguments: text },
            }
          : { function: { arguments: text } }),
      },
    ],
  });
}

const finish = (usage: Record<string, unknown>) => ({
  ...chunk({}, "tool_calls"),
  usage: { total_tokens: 1, ...usage },
});

describeCorpus(corpusFile.title("timing on every sample"), () => {
  it("measures TTFT at the first tool-call delta, not the role chunk", async () => {
    const clock = testClock();
    const reply = (request: RecordRequest) =>
      scriptedReply(clock, [
        { after: 100, events: [chunk({ role: "assistant" })] },
        {
          after: 100,
          events: request.calls.map((raw, index) => argumentDelta(index, raw, true)),
        },
        {
          after: 100,
          events: [finish({ prompt_tokens: 10, completion_tokens: 40 })],
        },
      ]);
    const { verdict } = await probe(reply, { now: clock.now });
    const result = expectDecision(verdict, "go");
    const sample = result.observation.samples[0]!;
    expect(sample).toMatchObject({
      ttftMs: 200,
      firstArgumentDeltaMs: 200,
      lastArgumentDeltaMs: 200,
      argumentBytesAfterFirstDelta: 0,
      outputTokens: 40,
      finishReason: "tool_calls",
    });
    expect(sample.elapsedMs).toBe(300);
    expect(sample.argumentBytes).toBe(sample.calls[0]!.rawBytes);
    // Every call arrived in one read, so there is no decode window: r is end
    // to end, 40 tokens in 300 ms, and says so.
    expect(result.measurement).toMatchObject({
      decodeTokensPerSecond: 133.3,
      decodeRateSource: "end-to-end",
      endToEndTokensPerSecond: 133.3,
    });
  });

  it("reports an end-to-end r, labelled, when the arguments arrive in one read at the end", async () => {
    // Nothing for 20 s, then the whole call in one read, so TTFT is within
    // milliseconds of elapsed and output over (elapsed − TTFT) would read
    // tens of thousands of tokens/s.
    const clock = testClock();
    const reply = (request: RecordRequest) =>
      scriptedReply(clock, [
        {
          after: 20_000,
          events: [
            chunk({ role: "assistant" }),
            ...request.calls.map((raw, index) => argumentDelta(index, raw, true)),
          ],
        },
        {
          after: 0,
          events: [finish({ prompt_tokens: 10, completion_tokens: 2000 })],
        },
        { after: 5, events: [] },
      ]);
    const { verdict } = await probe(reply, { now: clock.now });
    const result = expectDecision(verdict, "go");
    for (const sample of result.observation.samples) {
      expect(sample.elapsedMs).toBe(20_005);
      expect(sample.elapsedMs! - sample.ttftMs!).toBeGreaterThan(0);
      expect(sample.elapsedMs! - sample.ttftMs!).toBeLessThanOrEqual(5);
    }
    // 2,000 tokens over 20.005 s, never 2,000 over 5 ms (400,000 tokens/s).
    expect(result.measurement.decodeTokensPerSecond).toBe(100);
    expect(result.measurement.decodeRateSource).toBe("end-to-end");
    expect(result.measurement.decodeRateSamples).toEqual({
      streamWindow: 0,
      endToEnd: 24,
    });
    expect(result.notes.join(" ")).toContain("r is the end-to-end rate");
    const lines = formatAnswerRecordProbe(result).join("\n");
    expect(lines).toContain(
      "r 100 tokens/s (end to end with prefill, a lower bound; no argument window in 24 samples)",
    );
  });

  it("takes r from the argument window when the route streams arguments as it decodes", async () => {
    const clock = testClock();
    const reply = (request: RecordRequest) => {
      const raw = request.calls.join("");
      const quarter = Math.ceil(raw.length / 4);
      const pieces = [0, 1, 2, 3].map((part) => raw.slice(part * quarter, (part + 1) * quarter));
      return scriptedReply(clock, [
        { after: 500, events: [chunk({ role: "assistant" })] },
        ...pieces.map((piece, part) => ({
          after: 1000,
          events: [argumentDelta(0, piece, part === 0)],
        })),
        {
          after: 0,
          events: [finish({ prompt_tokens: 10, completion_tokens: 400 })],
        },
      ]);
    };
    // Phase A only: a one-call route; phase B fails its call count and ends the run.
    const { verdict } = await probe(reply, { now: clock.now });
    const sample = verdict.observation.samples[0]!;
    expect(sample).toMatchObject({
      ttftMs: 1500,
      firstArgumentDeltaMs: 1500,
      lastArgumentDeltaMs: 4500,
      elapsedMs: 4500,
    });
    // Three of four pieces arrived after the first: 300 of 400 tokens in 3 s.
    const share = sample.argumentBytesAfterFirstDelta / sample.argumentBytes;
    expect(share).toBeGreaterThan(0.7);
    expect(
      sampleDecodeRate(sample, limit("endpointProbe.answerRecordDecodeWindowMinBasisPoints").value),
    ).toEqual({
      tokensPerSecond: (400 * share * 1000) / 3000,
      source: "stream-window",
    });
    const rates = verdict.observation.samples
      .map(
        (item) =>
          sampleDecodeRate(
            item,
            limit("endpointProbe.answerRecordDecodeWindowMinBasisPoints").value,
          )!.tokensPerSecond,
      )
      .sort((left, right) => left - right);
    expect(verdict.measurement.decodeRateSource).toBe("stream-window");
    expect(verdict.measurement.decodeTokensPerSecond).toBe(
      Math.round(rates[Math.ceil(rates.length / 2) - 1]! * 10) / 10,
    );
    expect(verdict.measurement.endToEndTokensPerSecond).toBeCloseTo(88.9, 1);
  });
});

describe("the decode rate of one sample", () => {
  const minimum = limit("endpointProbe.answerRecordDecodeWindowMinBasisPoints").value;
  const sample = {
    httpStatus: 200,
    outputTokens: 2288,
    elapsedMs: 22_238,
    firstArgumentDeltaMs: 21_995,
    lastArgumentDeltaMs: 22_230,
    argumentBytes: 8748,
    argumentBytesAfterFirstDelta: 6000,
  };

  it("falls back to end to end for an 8 KiB call whose window was the last quarter second", () => {
    expect(minimum).toBe(2500);
    const rate = sampleDecodeRate(sample, minimum)!;
    expect(rate.source).toBe("end-to-end");
    expect(rate.tokensPerSecond).toBeCloseTo(102.9, 1);
  });

  it("uses the window when it covers enough of the elapsed time", () => {
    const rate = sampleDecodeRate({ ...sample, firstArgumentDeltaMs: 11_000 }, minimum)!;
    expect(rate.source).toBe("stream-window");
    expect(rate.tokensPerSecond).toBeCloseTo((2288 * (6000 / 8748) * 1000) / 11_230, 6);
    // Just under the share: end to end.
    const narrow = (22_238 * minimum) / 10_000;
    expect(
      sampleDecodeRate(
        { ...sample, firstArgumentDeltaMs: 22_230 - Math.floor(narrow) + 1 },
        minimum,
      )!.source,
    ).toBe("end-to-end");
  });

  it("never rates a window with no argument text after its first delta, or a refused request", () => {
    expect(
      sampleDecodeRate(
        {
          ...sample,
          firstArgumentDeltaMs: 1000,
          argumentBytesAfterFirstDelta: 0,
        },
        minimum,
      )!.source,
    ).toBe("end-to-end");
    expect(sampleDecodeRate({ ...sample, httpStatus: 429 }, minimum)).toBeNull();
    expect(sampleDecodeRate({ ...sample, outputTokens: 0 }, minimum)).toBeNull();
  });
});

/** Two-call messages whose calls each arrive whole when they complete, `gap` ms apart. */
function perCallBurst(
  clock: ReturnType<typeof testClock>,
  usage: Record<string, unknown>,
  gap = 4000,
) {
  return (request: RecordRequest) =>
    scriptedReply(clock, [
      { after: 2000, events: [chunk({ role: "assistant" })] },
      ...request.calls.map((raw, index) => ({
        after: gap,
        events: [argumentDelta(index, raw, true)],
      })),
      { after: 0, events: [finish(usage)] },
    ]);
}

describeCorpus(corpusFile.title("the small-group run (phase K)"), () => {
  it("sends 2- and 3-record messages padded to P and is MEASURED on a faithful route", async () => {
    let plan: AnswerRecordProbePlan | undefined;
    const { verdict, requests } = await probe(faithful, {
      ...SMALL_GROUPS,
      onPlan: (shown) => {
        plan = shown;
      },
    });
    const result = expectDecision(verdict, "measured");
    expect(phases(requests)).toEqual(Array(6).fill("K"));
    expect(requests.map((request) => request.calls.length)).toEqual([2, 2, 2, 3, 3, 3]);
    expect(plan).toMatchObject({
      selection: "small-groups",
      requests: 6,
      requestBudget: 11,
      inputTokenBudget: 521_807,
      paddedRequests: 6,
      otherInputTokens: 0,
      // The transport retries the premise runs share are not the small-group run's to spend.
      transportRetries: 0,
      paddedRetriesThatFit: 2,
    });
    expect(plan!.plannedInputTokens).toBeLessThanOrEqual(6 * 60_588);
    expect(formatAnswerRecordProbePlan(plan!)).toBe(
      `Answer record small-group plan: 6 requests (k = 2 and 3 records per message, each prompt padded to P=60588), plus at most 2 transport re-sends that fit, paid from that remainder and never from the shared transport retries; input ${String(plan!.plannedInputTokens)} tokens planned, within what the approval has left after 1 recorded run(s) spent 13 requests and 78193 input tokens: 11 requests and 521807 input tokens.`,
    );
    // Each message is the first k real records of one production group.
    const entryOf = new Map(
      CORPUS.records.map((entry) => [
        JSON.stringify({
          type: entry.type,
          ...(entry.key === undefined ? {} : { key: entry.key }),
          record: entry.record,
        }),
        entry,
      ]),
    );
    for (const request of requests) {
      const entries = request.calls.map((call) => entryOf.get(call)!);
      const { fixture, group } = entries[0]!;
      expect(entries).toEqual(
        CORPUS.records
          .filter((entry) => entry.fixture === fixture && entry.group === group)
          .slice(0, request.calls.length),
      );
    }
    for (const sample of result.observation.samples) {
      expect(sample.phase).toBe("K");
      expect(sample.estimatedInputTokens).toBeLessThanOrEqual(60_588);
      expect(sample.estimatedInputTokens).toBeGreaterThan(60_000);
      expect(sample.calls.every((call) => call.deepEqual)).toBe(true);
    }
    expect(result.observation).toMatchObject({
      selection: "small-groups",
      schemaVersion: 2,
    });
    expect(result.measurement.groups).toEqual([
      expect.objectContaining({
        recordsPerMessage: 2,
        sent: 3,
        admittedSeeds: 3,
        admitted: true,
        state: "admitted",
        impliedMessages: 22,
        impliedMessagesByFixture: { a: 22, b: 22 },
      }),
      expect.objectContaining({
        recordsPerMessage: 3,
        admittedSeeds: 3,
        admitted: true,
        impliedMessages: 16,
        impliedMessagesByFixture: { a: 16, b: 16 },
      }),
    ]);
    expect(answerRecordProbeExitCode(result)).toBe(0);
    const lines = formatAnswerRecordProbe(result, "/state/probe.json").join("\n");
    expect(lines).toContain("Answer record small-group probe: MEASURED (6 requests");
    expect(lines).toContain("Group k=2: admitted 3/3; implied M 22 (fixture a 22, fixture b 22)");
    expect(lines).toContain("Group k=3: admitted 3/3; implied M 16 (fixture a 16, fixture b 16)");
    expect(lines).not.toContain("maxRecordBytes");
    expect(result.nextAction).toContain("amend the design record (r4)");
  });

  it("projects the step 8 records phase for k = 1, 2 and 3 from the measured r, Lturn and prompt", async () => {
    const clock = testClock();
    // Every call whole in one read: TTFT 2 s, elapsed 3 s, 600 output tokens,
    // so r is end to end, 200 tokens/s; prompts report 50,000 tokens, 20,000 cached.
    const reply = (request: RecordRequest) =>
      scriptedReply(clock, [
        { after: 1000, events: [chunk({ role: "assistant" })] },
        {
          after: 1000,
          events: request.calls.map((raw, index) => argumentDelta(index, raw, true)),
        },
        {
          after: 1000,
          events: [
            finish({
              prompt_tokens: 50_000,
              completion_tokens: 600,
              prompt_tokens_details: { cached_tokens: 20_000 },
            }),
          ],
        },
      ]);
    const { verdict } = await probe(reply, { ...SMALL_GROUPS, now: clock.now });
    const result = expectDecision(verdict, "measured");
    expect(result.measurement).toMatchObject({
      ttftP90Ms: 2000,
      decodeTokensPerSecond: 200,
      decodeRateSource: "end-to-end",
      paddedPromptTokens: 50_000,
      paddedCachedPromptTokens: 20_000,
    });
    // D_full = (⌈34,074 B / 2.86⌉ fixture b's records + 2,700 report + ⌈2,723 B / 2.86⌉
    // one resent largest record) / 200 = 15,567 / 200 = 77.835 s.
    // A = D_full + (M + 2) × 2 s; T* = A / 0.6; turns left = 128 − (2M + 1).
    expect(result.measurement.projections).toEqual([
      {
        recordsPerMessage: 1,
        messages: 43,
        recordTurnInputTokens: 2_150_000,
        cachedInputTokens: 860_000,
        answerSeconds: 168,
        timerSeconds: 280,
        maxProviderTurns: 128,
        readingTurnsLeft: 41,
      },
      {
        recordsPerMessage: 2,
        messages: 22,
        recordTurnInputTokens: 1_100_000,
        cachedInputTokens: 440_000,
        answerSeconds: 126,
        timerSeconds: 210,
        maxProviderTurns: 128,
        readingTurnsLeft: 83,
      },
      {
        recordsPerMessage: 3,
        messages: 16,
        recordTurnInputTokens: 800_000,
        cachedInputTokens: 320_000,
        answerSeconds: 114,
        timerSeconds: 190,
        maxProviderTurns: 128,
        readingTurnsLeft: 95,
      },
    ]);
    const lines = formatAnswerRecordProbe(result).join("\n");
    expect(lines).toContain(
      "Projection (not measured), k=2: M 22; step 8 record-turn input 1100000 tokens (cached 440000); A 126 s; T* 210 s; turn fit 128 − (2M + 1) = 83 reading turns",
    );
    expect(lines).toContain(
      "seed 0: admitted; TTFT 2000 ms, elapsed 3000 ms, arguments 2000 ms to 2000 ms, output 600 tokens, prompt 50000 (cached 20000) tokens",
    );
    expect(result.notes.join(" ")).toContain("not measurements");
    expect(result.notes.join(" ")).toContain("Lturn includes decode");
  });

  it("rates a message whose calls arrive whole, one after another, over the window between them", async () => {
    const clock = testClock();
    const { verdict } = await probe(
      perCallBurst(clock, { prompt_tokens: 60_000, completion_tokens: 900 }),
      {
        ...SMALL_GROUPS,
        now: clock.now,
      },
    );
    const result = expectDecision(verdict, "measured");
    const pair = result.observation.samples.find((sample) => sample.expectedCalls === 2)!;
    expect(pair).toMatchObject({
      ttftMs: 6000,
      firstArgumentDeltaMs: 6000,
      lastArgumentDeltaMs: 10_000,
      elapsedMs: 10_000,
    });
    expect(result.measurement.decodeRateSource).toBe("stream-window");
    expect(result.measurement.decodeRateSamples.streamWindow).toBe(6);
  });

  it("never admits a k-group that ends in a stub whose record is not JSON", async () => {
    const stub = JSON.stringify({ type: "finding", record: '{"id":' });
    const { verdict, requests } = await probe(
      (request) => callsReply([...request.calls.slice(0, -1), stub]),
      SMALL_GROUPS,
    );
    const result = expectDecision(verdict, "measured");
    expect(result.measurement.groups[0]).toMatchObject({
      recordsPerMessage: 2,
      admitted: false,
      admittedSeeds: 0,
      state: "failed",
      failures: ["decode"],
    });
    expect(result.observation.samples[0]!.calls[1]).toMatchObject({
      decode: "answer-record-json",
      decodeLocation: "$.record",
    });
    // A larger group is not sent once a smaller one failed.
    expect(requests).toHaveLength(1);
    expect(result.measurement.groups[1]).toMatchObject({
      recordsPerMessage: 3,
      state: "unsent",
      sent: 0,
    });
    expect(result.notes.join(" ")).toContain("k = 3 not sent");
    expect(formatAnswerRecordProbe(result).join("\n")).toContain(
      "Group k=2: not admitted (0 of 3 seeds admitted; decode)",
    );
  });

  it("never admits a k-group whose last record is an admissible stub: a short copy", async () => {
    const stub = JSON.stringify({ type: "finding", record: {} });
    const { verdict } = await probe(
      (request) => callsReply([...request.calls.slice(0, -1), stub]),
      SMALL_GROUPS,
    );
    const result = expectDecision(verdict, "measured");
    const first = result.observation.samples[0]!;
    expect(first.calls.every((call) => call.decode === "admitted")).toBe(true);
    expect(first.failure).toBe("short-copy");
    expect(result.measurement.groups[0]).toMatchObject({
      admitted: false,
      failures: ["short-copy"],
    });
  });

  it("counts a group size as admitted only at 3 of 3 seeds, never 2 of 3", async () => {
    const { verdict, requests } = await probe(
      (request, nth) => (nth === 2 ? callsReply(request.calls.slice(0, 1)) : faithful(request)),
      SMALL_GROUPS,
    );
    const result = expectDecision(verdict, "measured");
    expect(result.measurement.groups[0]).toMatchObject({
      recordsPerMessage: 2,
      sent: 3,
      admittedSeeds: 2,
      admitted: false,
      state: "failed",
      failures: ["call-count"],
    });
    expect(requests).toHaveLength(3);
    expect(formatAnswerRecordProbe(result).join("\n")).toContain(
      "Group k=2: not admitted (2 of 3 seeds admitted; call-count)",
    );
  });

  it("is MEASURED when k = 2 is admitted and k = 3 is not", async () => {
    const { verdict } = await probe(
      (request) =>
        request.calls.length === 3 ? callsReply(request.calls.slice(0, 2)) : faithful(request),
      SMALL_GROUPS,
    );
    const result = expectDecision(verdict, "measured");
    expect(result.measurement.groups.map((group) => [group.admitted, group.state])).toEqual([
      [true, "admitted"],
      [false, "failed"],
    ]);
  });

  it("never admits a k-group that repeats its larger record, even though nothing is short", async () => {
    // A repeated call is admissible on its own and at least as long as the call
    // it displaced, so only matching every planned call exactly once catches it.
    const largerTwice = (calls: readonly string[]) => {
      const larger = [...calls].sort((left, right) => bytes(right) - bytes(left))[0]!;
      return calls.map(() => larger);
    };
    const { verdict, requests } = await probe(
      (request) => callsReply(largerTwice(request.calls)),
      SMALL_GROUPS,
    );
    const result = expectDecision(verdict, "measured");
    const first = result.observation.samples[0]!;
    expect(first.calls.every((call) => call.decode === "admitted")).toBe(true);
    expect(first.calls.map((call) => call.deepEqual)).toEqual([true, false]);
    expect(first.calls[1]!.plannedIndex).toBeNull();
    expect(first).toMatchObject({ admitted: false, failure: "copy", inPlannedOrder: null });
    expect(result.measurement.groups[0]).toMatchObject({
      recordsPerMessage: 2,
      admitted: false,
      failures: ["copy"],
    });
    expect(requests).toHaveLength(1);
  });

  it("fails k = 3 when its smallest record is replaced by a repeat of its largest", async () => {
    const { verdict } = await probe((request) => {
      if (request.calls.length !== 3) return faithful(request);
      const bySize = [...request.calls].sort((left, right) => bytes(left) - bytes(right));
      return callsReply(request.calls.map((call) => (call === bySize[0] ? bySize[2]! : call)));
    }, SMALL_GROUPS);
    const result = expectDecision(verdict, "measured");
    expect(result.measurement.groups.map((group) => [group.admitted, group.failures])).toEqual([
      [true, []],
      [false, ["copy"]],
    ]);
  });

  it("admits records in any order, keyed as production keys them, and records the order", async () => {
    const { verdict } = await probe(
      (request) => callsReply([...request.calls].reverse()),
      SMALL_GROUPS,
    );
    const result = expectDecision(verdict, "measured");
    expect(result.measurement.groups.every((group) => group.admitted)).toBe(true);
    const pair = result.observation.samples[0]!;
    expect(pair).toMatchObject({ admitted: true, inPlannedOrder: false });
    expect(pair.calls.map((call) => call.plannedIndex)).toEqual([1, 0]);
    const { verdict: inOrder } = await probe(faithful, SMALL_GROUPS);
    expect(inOrder.observation.samples.every((sample) => sample.inPlannedOrder === true)).toBe(
      true,
    );
  });

  it("is NO-GO provider-request-refused, exit 1, on an HTTP 4xx or 5xx in phase K", async () => {
    for (const [status, at, sent] of [
      [429, 0, 1],
      [503, 1, 2],
    ] as const) {
      const { verdict, requests } = await probe(
        (request, nth) =>
          nth === at ? new Response('{"error":"refused"}', { status }) : faithful(request),
        SMALL_GROUPS,
      );
      const result = expectDecision(verdict, "no-go");
      expect(result).toMatchObject({
        cause: "provider-request-refused",
        stopClass: "provider-compatibility",
      });
      expect(result.reason).toContain(`HTTP ${String(status)}`);
      expect(requests).toHaveLength(sent);
      expect(answerRecordProbeExitCode(result)).toBe(1);
    }
  });

  it("falls back to end to end when the end burst spreads over several reads", async () => {
    // The arguments arrive in reads 50 ms apart at the end of 20 s, so the
    // window is real (last > first, bytes after the first delta) but under the
    // threshold share of the elapsed time.
    const clock = testClock();
    const reply = (request: RecordRequest) =>
      scriptedReply(clock, [
        { after: 19_800, events: [chunk({ role: "assistant" })] },
        ...request.calls.flatMap((raw, index) => {
          const half = Math.ceil(raw.length / 2);
          return [
            { after: 50, events: [argumentDelta(index, raw.slice(0, half), true)] },
            { after: 50, events: [argumentDelta(index, raw.slice(half), false)] },
          ];
        }),
        { after: 0, events: [finish({ prompt_tokens: 10, completion_tokens: 2000 })] },
      ]);
    const { verdict } = await probe(reply, { ...SMALL_GROUPS, now: clock.now });
    const result = expectDecision(verdict, "measured");
    for (const sample of result.observation.samples) {
      expect(sample.lastArgumentDeltaMs!).toBeGreaterThan(sample.firstArgumentDeltaMs!);
      expect(sample.argumentBytesAfterFirstDelta).toBeGreaterThan(0);
      expect(sample.elapsedMs! - sample.firstArgumentDeltaMs!).toBeLessThanOrEqual(300);
    }
    expect(result.measurement).toMatchObject({
      decodeRateSource: "end-to-end",
      decodeRateSamples: { streamWindow: 0, endToEnd: 6 },
    });
    const endToEnd = result.observation.samples
      .map((sample) => (2000 * 1000) / sample.elapsedMs!)
      .sort((left, right) => left - right);
    expect(result.measurement.decodeTokensPerSecond).toBe(
      Math.round(endToEnd[Math.ceil(endToEnd.length / 2) - 1]! * 10) / 10,
    );
    expect(result.measurement.decodeTokensPerSecond!).toBeLessThan(101);
  });

  it("charges each request the larger of reported and estimated input, so a re-send is withheld", async () => {
    // The route reports fewer input tokens than estimated, as Super did on a
    // padded prompt. Charged by the reported count alone, the third re-send
    // would fit; charged by the larger, it crosses the input tokens left.
    const { verdict, requests } = await probe(
      (request, nth) =>
        nth === 0 || nth === 2 || nth === 4
          ? connectionReset()
          : callsReply(request.calls, "tool_calls", {
              prompt_tokens: 30_000,
              completion_tokens: 5,
            }),
      SMALL_GROUPS,
    );
    const result = expectDecision(verdict, "inconclusive");
    const samples = result.observation.samples;
    expect(requests).toHaveLength(5);
    expect(samples.map((sample) => sample.retried)).toEqual([true, false, true, false, false]);
    expect(samples[4]).toMatchObject({ retryWithheld: "input-budget", transportError: "reset" });
    expect(samples.filter((sample) => sample.promptTokens === 30_000)).toHaveLength(2);
    const charged = samples.reduce(
      (sum, sample) => sum + Math.max(sample.promptTokens ?? 0, sample.estimatedInputTokens),
      0,
    );
    expect(charged).toBe(samples.reduce((sum, sample) => sum + sample.estimatedInputTokens, 0));
    expect(charged).toBeLessThanOrEqual(521_807);
    // One more padded prompt beside the three k = 3 prompts still planned does not fit.
    expect(charged + 4 * samples[4]!.estimatedInputTokens).toBeGreaterThan(521_807);
  });

  it("sends nothing in phase K without a reservation in the ledger", async () => {
    const replay = route(faithful, "K");
    const { onReserve: _unused, ...unreserved } = SMALL_GROUPS;
    await expect(probeAnswerRecords(target(replay.fetch, unreserved))).rejects.toMatchObject({
      code: "answer-record-ledger-invalid",
    });
    expect(replay.requests).toHaveLength(0);
    // The premise-only entry cannot select phase K at all.
    const premise = route(faithful);
    vi.stubGlobal("fetch", premise.fetch);
    const verdict = await probeConfiguredAnswerRecords(SUPER, {
      corpusPath: CORPUS_PATH,
      selection: "small-groups",
    } as Parameters<typeof probeConfiguredAnswerRecords>[1]);
    expect(verdict.decision).toBe("go");
    expect(premise.requests.some((request) => request.phase === "K")).toBe(false);
  });

  it("refuses before any request when the plan exceeds the input tokens left", async () => {
    // 6 × 90,000 = 540,000 > 521,807.
    const heavy: AnswerRecordCorpus = {
      ...CORPUS,
      padding: { ...CORPUS.padding, targetTokens: 90_000 },
    };
    const replay = route(faithful, "K");
    await expect(
      probeAnswerRecords(target(replay.fetch, { ...SMALL_GROUPS, corpus: heavy })),
    ).rejects.toMatchObject({
      code: "endpoint-probe-answer-record-group-input-token-budget",
    });
    expect(replay.requests).toHaveLength(0);
  });

  it("refuses before any request when the plan exceeds the requests left", async () => {
    const replay = route(faithful, "K");
    const five = {
      ...limit("endpointProbe.answerRecordGroupRequestBudget"),
      value: 5,
    };
    await expect(
      probeAnswerRecords(target(replay.fetch, { ...SMALL_GROUPS, requestBudget: five })),
    ).rejects.toMatchObject({
      code: "endpoint-probe-answer-record-group-request-budget",
    });
    expect(replay.requests).toHaveLength(0);
  });

  it("re-sends a reset within the remainder and is MEASURED", async () => {
    const { verdict, requests } = await probe(
      (request, nth) => (nth === 0 ? connectionReset() : faithful(request)),
      SMALL_GROUPS,
    );
    const result = expectDecision(verdict, "measured");
    expect(requests).toHaveLength(7);
    expect(result.measurement).toMatchObject({ transportRetriesUsed: 0, remainderResends: 1 });
    expect(result.observation.samples[1]).toMatchObject({
      retryOf: 0,
      admitted: true,
    });
  });

  it("pays re-sends from the remainder only, never from the retries the premise runs share", async () => {
    // Two seeds reset. The shared pool is empty, as if another run needed every retry,
    // and both re-sends still go out, paid from the 11-request remainder.
    const { verdict, requests } = await probe(
      (request, nth) => (nth === 0 || nth === 2 ? connectionReset() : faithful(request)),
      { ...SMALL_GROUPS, transportRetries: 0 },
    );
    const result = expectDecision(verdict, "measured");
    expect(result.observation.plan).toMatchObject({ transportRetries: 0, paddedRetriesThatFit: 2 });
    expect(result.measurement).toMatchObject({ transportRetriesUsed: 0, remainderResends: 2 });
    expect(requests).toHaveLength(8);
    expect(result.observation.samples.filter((sample) => sample.retried)).toHaveLength(2);
    expect(result.observation.samples.every((sample) => sample.retryWithheld === null)).toBe(true);
  });

  it("never re-sends past the requests left, and is inconclusive", async () => {
    const six = {
      ...limit("endpointProbe.answerRecordGroupRequestBudget"),
      value: 6,
    };
    const { verdict, requests } = await probe(
      (request, nth) => (nth === 0 ? connectionReset() : faithful(request)),
      { ...SMALL_GROUPS, requestBudget: six },
    );
    const result = expectDecision(verdict, "inconclusive");
    expect(result.observation.samples[0]).toMatchObject({
      retried: false,
      retryWithheld: "request-budget",
    });
    // The ladder stops at the unmeasured seed: nothing else is sent.
    expect(requests).toHaveLength(1);
    expect(result.reason).toContain("k = 2 was not decided");
    expect(result.nextAction).toContain("settle R9 on one record per message");
    expect(formatAnswerRecordProbe(result).join("\n")).toContain(
      "not re-sent: the re-send does not fit the request budget",
    );
    expect(answerRecordProbeExitCode(result)).toBe(1);
  });

  it("withholds a re-send that would cross the input tokens left", async () => {
    const { verdict: dry } = await probe(faithful, SMALL_GROUPS);
    const tight = {
      ...limit("endpointProbe.answerRecordGroupInputTokenBudget"),
      value: dry.observation.plan.plannedInputTokens,
    };
    const { verdict } = await probe(
      (request, nth) => (nth === 0 ? connectionReset() : faithful(request)),
      { ...SMALL_GROUPS, inputTokenBudget: tight },
    );
    const result = expectDecision(verdict, "inconclusive");
    expect(result.observation.plan.paddedRetriesThatFit).toBe(0);
    expect(result.observation.samples[0]).toMatchObject({
      retryWithheld: "input-budget",
    });
  });
});

const SUPER = {
  ...validModelConfig,
  providerId: "nvidia-api-catalog",
  baseUrl: "https://integrate.api.nvidia.com/v1",
  modelId: "nvidia/nemotron-3-super-120b-a12b",
  credentialEnv: "DOCSFAB_NVIDIA_API_KEY",
  // The preset's own sealed output: an attested operator value above it would win.
  profile: {
    ...validModelConfig.profile,
    configuredLimits: {
      ...validModelConfig.profile.configuredLimits,
      maxOutputTokens: 8_192,
    },
    maxOutputTokens: 8_192,
  },
};

describeCorpus(corpusFile.title("docsfab doctor --live --answer-records"), () => {
  it("charges typed observations and interrupted typed reservations against combined authority", () => {
    const premiseText = readFileSync(join(OBSERVATIONS_PATH, PREMISE_FILE), "utf8");
    const keep = (value: unknown) => {
      const text = canonicalJson(value as never);
      return { name: `${createHash("sha256").update(text).digest("hex")}.json`, text };
    };
    const typedObservation = keep({
      schemaVersion: 2,
      kind: "docsfab-answer-record-probe",
      selection: "typed",
      shell: "typed",
      samples: [
        { estimatedInputTokens: 110, promptTokens: 120 },
        { estimatedInputTokens: 220, promptTokens: null },
      ],
      measurement: { transportRetriesUsed: 1 },
    });
    const ledger = answerRecordTypedLedger([
      { name: PREMISE_FILE, text: premiseText },
      typedObservation,
    ]);
    expect(ledger).toMatchObject({
      requests: 15,
      typedRequests: 2,
      inputTokens: 78_193 + 120 + 220,
      transportRetriesUsed: 1,
    });
    const reservation = keep({
      schemaVersion: 1,
      kind: ANSWER_RECORD_RESERVATION_KIND,
      selection: "typed",
      requests: 17,
      inputTokens: 500_000,
      transportRetries: 1,
      plan: { transportRetries: 1 },
    });
    expect(
      answerRecordTypedLedger([{ name: PREMISE_FILE, text: premiseText }, reservation]),
    ).toMatchObject({
      requests: 30,
      typedRequests: 17,
      inputTokens: 578_193,
      transportRetriesUsed: 1,
    });
    const unknownSelection = keep({
      schemaVersion: 1,
      kind: ANSWER_RECORD_RESERVATION_KIND,
      selection: "future-mode",
      requests: 17,
      inputTokens: 500_000,
      transportRetries: 1,
      plan: { transportRetries: 1 },
    });
    expect(() =>
      answerRecordTypedLedger([{ name: PREMISE_FILE, text: premiseText }, unknownSelection]),
    ).toThrow("has an unknown selection");
    const legacyReservation = keep({
      schemaVersion: 1,
      kind: ANSWER_RECORD_RESERVATION_KIND,
      requests: 3,
      inputTokens: 100,
      transportRetries: 2,
      plan: { transportRetries: 2 },
    });
    expect(
      answerRecordTypedLedger([{ name: PREMISE_FILE, text: premiseText }, legacyReservation]),
    ).toMatchObject({ typedRequests: 0, inputTokens: 78_293, transportRetriesUsed: 0 });
    expect(() =>
      answerRecordTypedLedger([
        { name: PREMISE_FILE, text: premiseText },
        keep({ kind: "unknown-record-probe", samples: [] }),
      ]),
    ).toThrow("not a record-probe observation");
    expect(() =>
      answerRecordTypedLedger([
        { name: PREMISE_FILE, text: premiseText },
        { name: "edited.json", text: typedObservation.text },
      ]),
    ).toThrow("does not match its SHA-256");
  });

  it("charges the retained K result in the typed ledger without sharing its retry pool", () => {
    const premiseText = readFileSync(join(OBSERVATIONS_PATH, PREMISE_FILE), "utf8");
    const kName = "6f1add22933da65d6eaa88a726dbfa983d8fbd27b28b93eb2e33c61e06e02077.json";
    const kText = readFileSync(join(OBSERVATIONS_PATH, kName), "utf8");

    expect(createHash("sha256").update(premiseText).digest("hex")).toBe(PREMISE_FILE.slice(0, -5));
    const legacyPremise = JSON.parse(premiseText) as Record<string, any>;
    expect(legacyPremise.schemaVersion).toBe(1);
    expect(legacyPremise.samples[0]).not.toHaveProperty("transportObservation");

    expect(() =>
      answerRecordTypedLedger([
        { name: PREMISE_FILE, text: premiseText },
        { name: kName, text: kText },
      ]),
    ).not.toThrow();
    expect(
      answerRecordTypedLedger([
        { name: PREMISE_FILE, text: premiseText },
        { name: kName, text: kText },
      ]),
    ).toMatchObject({
      observations: 2,
      requests: 14,
      typedRequests: 0,
      inputTokens: 138_781,
      transportRetriesUsed: 0,
    });
    expect(() =>
      answerRecordTypedLedger([
        { name: PREMISE_FILE, text: premiseText },
        { name: kName, text: `${kText}\n` },
      ]),
    ).toThrow("does not match its SHA-256");
  });

  it("keeps K resends in its request tranche without consuming shared typed retries", () => {
    const premiseText = readFileSync(join(OBSERVATIONS_PATH, PREMISE_FILE), "utf8");
    const keep = (value: unknown) => {
      const text = canonicalJson(value as never);
      return { name: `${createHash("sha256").update(text).digest("hex")}.json`, text };
    };
    const settledGroup = keep({
      schemaVersion: 2,
      kind: "docsfab-answer-record-probe",
      selection: "small-groups",
      shell: "untyped",
      samples: [
        { estimatedInputTokens: 100, promptTokens: 100, retried: true, retryOf: null },
        { estimatedInputTokens: 100, promptTokens: 100, retried: false, retryOf: 0 },
      ],
      measurement: { transportRetriesUsed: 0, remainderResends: 1 },
    });
    const settledLedger = answerRecordTypedLedger([
      { name: PREMISE_FILE, text: premiseText },
      settledGroup,
    ]);
    expect(settledLedger).toMatchObject({
      requests: 15,
      typedRequests: 0,
      inputTokens: 78_393,
      transportRetriesUsed: 0,
    });
    const missingGroupAggregate = keep({
      schemaVersion: 2,
      kind: "docsfab-answer-record-probe",
      selection: "small-groups",
      shell: "untyped",
      samples: [
        { estimatedInputTokens: 100, promptTokens: 100, retried: true, retryOf: null },
        { estimatedInputTokens: 100, promptTokens: 100, retried: false, retryOf: 0 },
      ],
      measurement: { remainderResends: 1 },
    });
    expect(
      answerRecordTypedLedger([{ name: PREMISE_FILE, text: premiseText }, missingGroupAggregate]),
    ).toMatchObject({
      requests: 15,
      typedRequests: 0,
      inputTokens: 78_393,
      transportRetriesUsed: 0,
    });

    const malformedRetryMarkers = keep({
      schemaVersion: 2,
      kind: "docsfab-answer-record-probe",
      selection: "small-groups",
      shell: "untyped",
      samples: [{ estimatedInputTokens: 100, promptTokens: 100, retried: false, retryOf: "0" }],
      measurement: { remainderResends: 0 },
    });
    expect(() =>
      answerRecordTypedLedger([{ name: PREMISE_FILE, text: premiseText }, malformedRetryMarkers]),
    ).toThrow("has invalid retry provenance");

    const inconsistentRetryMarkers = keep({
      schemaVersion: 2,
      kind: "docsfab-answer-record-probe",
      selection: "small-groups",
      shell: "untyped",
      samples: [
        { estimatedInputTokens: 100, promptTokens: 100, retried: false, retryOf: null },
        { estimatedInputTokens: 100, promptTokens: 100, retried: false, retryOf: 0 },
      ],
      measurement: { remainderResends: 1 },
    });
    expect(() =>
      answerRecordTypedLedger([
        { name: PREMISE_FILE, text: premiseText },
        inconsistentRetryMarkers,
      ]),
    ).toThrow("has inconsistent retry provenance");

    const inconsistentRetryTotal = keep({
      schemaVersion: 2,
      kind: "docsfab-answer-record-probe",
      selection: "small-groups",
      shell: "untyped",
      samples: [
        { estimatedInputTokens: 100, promptTokens: 100, retried: true, retryOf: null },
        { estimatedInputTokens: 100, promptTokens: 100, retried: false, retryOf: 0 },
      ],
      measurement: { remainderResends: 0 },
    });
    expect(() =>
      answerRecordTypedLedger([{ name: PREMISE_FILE, text: premiseText }, inconsistentRetryTotal]),
    ).toThrow("does not match its retry markers");

    const interruptedGroup = keep({
      schemaVersion: 1,
      kind: ANSWER_RECORD_RESERVATION_KIND,
      selection: "small-groups",
      requests: 11,
      inputTokens: 500_000,
      transportRetries: 2,
      plan: { transportRetries: 2 },
    });
    const reservedLedger = answerRecordTypedLedger([
      { name: PREMISE_FILE, text: premiseText },
      interruptedGroup,
    ]);
    expect(reservedLedger).toMatchObject({
      requests: 24,
      typedRequests: 0,
      inputTokens: 578_193,
      transportRetriesUsed: 0,
      reservations: 1,
    });
  });

  it("charges A-t tokens before a later K plan without consuming K requests", async () => {
    const directory = ledgerDirectory();
    try {
      writeLedgerJson(directory, {
        schemaVersion: 2,
        kind: "docsfab-answer-record-probe",
        selection: "typed",
        shell: "typed",
        samples: [
          { estimatedInputTokens: 110, promptTokens: 120 },
          { estimatedInputTokens: 220, promptTokens: null },
        ],
        measurement: { transportRetriesUsed: 1 },
      });
      const plan = await planOf(directory);
      if ("decision" in plan) throw new Error(plan.reason);
      expect(plan).toMatchObject({
        selection: "small-groups",
        requestBudget: 11,
        inputTokenBudget: 600_000 - 78_193 - 340,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("charges an unfinished typed reservation to K tokens but not K requests", async () => {
    const directory = ledgerDirectory();
    try {
      writeLedgerJson(directory, {
        schemaVersion: 1,
        kind: ANSWER_RECORD_RESERVATION_KIND,
        selection: "typed",
        requests: 17,
        inputTokens: 500_000,
        transportRetries: 1,
        plan: { transportRetries: 1 },
      });
      const plan = await planOf(directory);
      if ("decision" in plan) throw new Error(plan.reason);
      expect(plan).toMatchObject({
        selection: "small-groups",
        requestBudget: 11,
        inputTokenBudget: 600_000 - 78_193 - 500_000,
      });
      expect(plan.plannedInputTokens).toBeGreaterThan(plan.inputTokenBudget);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("charges a prior K observation before A-t and preserves typed/shared remainders", async () => {
    const directory = ledgerDirectory();
    try {
      writeLedgerJson(directory, {
        schemaVersion: 2,
        kind: "docsfab-answer-record-probe",
        selection: "small-groups",
        shell: "untyped",
        samples: [
          { estimatedInputTokens: 1_000, promptTokens: 1_500, retried: true, retryOf: null },
          { estimatedInputTokens: 1_000, promptTokens: 1_500, retried: false, retryOf: 0 },
        ],
        measurement: { transportRetriesUsed: 0, remainderResends: 1 },
      });
      let plan: AnswerRecordProbePlan | undefined;
      await expect(
        recordAnswerRecordProbe(SUPER, {
          corpusPath: CORPUS_PATH,
          selection: "typed",
          observationDirectory: directory,
          onPlan: (shown) => {
            plan = shown;
            throw STOP_AT_PLAN;
          },
        }),
      ).rejects.toBe(STOP_AT_PLAN);
      expect(plan).toMatchObject({
        selection: "typed",
        requests: 9,
        requestBudget: 17,
        inputTokenBudget: 600_000 - 78_193 - 3_000,
        transportRetries: 2,
        ledger: { typedRequests: 0, inputTokens: 78_193 + 3_000, transportRetriesUsed: 0 },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses A-t before a provider request when historical spend cannot be proven", async () => {
    const directory = mkdtempSync(join(tmpdir(), "docsfab-answer-record-empty-ledger-"));
    try {
      const replay = route(faithful);
      vi.stubGlobal("fetch", replay.fetch);
      const { verdict } = await recordAnswerRecordProbe(SUPER, {
        corpusPath: CORPUS_PATH,
        selection: "typed",
        observationDirectory: directory,
      });
      expect(verdict).toMatchObject({
        decision: "not-checked",
        code: "answer-record-ledger-invalid",
      });
      expect(verdict.decision === "not-checked" && verdict.reason).toContain("pinned 1a premise");
      expect(replay.requests).toHaveLength(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("permits the one-group continuation only with all four pinned predecessor observations", async () => {
    const names = [
      PREMISE_FILE,
      RETAINED_K_FILE,
      RETAINED_A_T_FILE,
      `${ANSWER_RECORD_TYPED_CONTEXT_PARTIAL_EVIDENCE_SHA256}.json`,
    ];
    const directory = mkdtempSync(join(tmpdir(), "docsfab-answer-record-context-continuation-"));
    try {
      for (const name of names) {
        writeFileSync(join(directory, name), readFileSync(join(OBSERVATIONS_PATH, name), "utf8"));
      }
      let shown: AnswerRecordProbePlan | undefined;
      await expect(
        recordAnswerRecordProbe(SUPER, {
          corpusPath: CORPUS_PATH,
          selection: "typed",
          typedContextMix: true,
          typedContextGroupOnly: true,
          observationDirectory: directory,
          onPlan: (plan) => {
            shown = plan;
            throw STOP_AT_PLAN;
          },
        }),
      ).rejects.toBe(STOP_AT_PLAN);
      expect(shown).toMatchObject({
        selection: "typed",
        typedContextMix: true,
        typedContextGroupOnly: true,
        requests: 1,
        requestBudget: 2,
        plannedInputTokens: 60_588,
        inputTokenBudget: 81_236,
        paddedRetriesThatFit: 0,
        ledger: {
          observations: 4,
          reservations: 0,
          requests: 29,
          typedRequests: 15,
          inputTokens: 518_764,
          transportRetriesUsed: 0,
        },
      });
      expect(readdirSync(directory).sort()).toEqual(names.slice().sort());
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }

    for (const missing of names.slice(0, 3)) {
      const incomplete = mkdtempSync(join(tmpdir(), "docsfab-answer-record-context-incomplete-"));
      try {
        for (const name of names.filter((candidate) => candidate !== missing)) {
          writeFileSync(
            join(incomplete, name),
            readFileSync(join(OBSERVATIONS_PATH, name), "utf8"),
          );
        }
        const replay = route(faithful, "A-t-context");
        vi.stubGlobal("fetch", replay.fetch);
        const { verdict } = await recordAnswerRecordProbe(SUPER, {
          corpusPath: CORPUS_PATH,
          selection: "typed",
          typedContextMix: true,
          typedContextGroupOnly: true,
          observationDirectory: incomplete,
        });
        expect(verdict).toMatchObject({
          decision: "not-checked",
          code: "answer-record-ledger-invalid",
        });
        expect(replay.requests).toHaveLength(0);
      } finally {
        rmSync(incomplete, { recursive: true, force: true });
      }
    }

    const attempted = mkdtempSync(join(tmpdir(), "docsfab-answer-record-context-replayed-group-"));
    try {
      for (const name of names) {
        writeFileSync(join(attempted, name), readFileSync(join(OBSERVATIONS_PATH, name), "utf8"));
      }
      writeLedgerJson(attempted, {
        schemaVersion: 2,
        kind: "docsfab-answer-record-probe",
        selection: "typed",
        shell: "typed",
        typedContextMix: true,
        typedContextGroupOnly: true,
        samples: [
          {
            phase: "A-t-context",
            expectedCalls: 2,
            estimatedInputTokens: 60_588,
            promptTokens: 60_588,
          },
        ],
        measurement: { transportRetriesUsed: 0 },
      });
      const replay = route(faithful, "A-t-context");
      vi.stubGlobal("fetch", replay.fetch);
      const { verdict } = await recordAnswerRecordProbe(SUPER, {
        corpusPath: CORPUS_PATH,
        selection: "typed",
        typedContextMix: true,
        typedContextGroupOnly: true,
        observationDirectory: attempted,
      });
      expect(verdict).toMatchObject({
        decision: "not-checked",
        code: "answer-record-ledger-invalid",
      });
      expect(replay.requests).toHaveLength(0);
    } finally {
      rmSync(attempted, { recursive: true, force: true });
    }
  });

  it("measures the typed A-t shell with production Pi validation and leaves phase G unexecuted", async () => {
    const replay = route(faithful);
    const verdict = await probeAnswerRecords(
      target(replay.fetch, {
        selection: "typed",
        requestBudget: limit("endpointProbe.answerRecordTypedRequestBudget"),
        inputTokenBudget: limit("endpointProbe.answerRecordInputTokenBudget"),
        onReserve: async () => {},
      }),
    );
    expect(verdict.decision).toBe("measured");
    expect(replay.requests).toHaveLength(9);
    expect(replay.requests.map((request) => request.phase)).toEqual(Array(9).fill("A-t"));
    expect(
      replay.requests.every(
        (request) => request.body.tools[0].function.parameters.properties.type.enum,
      ),
    ).toBe(true);
    expect(
      replay.requests.every(
        (request) => request.body.response_format === undefined && request.body.nvext === undefined,
      ),
    ).toBe(true);
    expect(verdict.observation).toMatchObject({
      selection: "typed",
      shell: "typed",
      phaseG: {
        status: "not-executed",
        reason: "request-policy-blocked",
        requests: 0,
        schemas: ["dimension", "finding"],
      },
    });
    expect(verdict.nextAction).toContain("Phase G remains open");
  });

  it("reports typed byte admission separately from same-size planned-envelope matches", async () => {
    const mutateRecord = (value: unknown): { value: unknown; changed: boolean } => {
      if (typeof value === "string") {
        const changed = value.replace(/[A-Za-z]/u, (letter) => (letter === "x" ? "y" : "x"));
        return { value: changed, changed: changed !== value };
      }
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
          const result = mutateRecord(value[index]);
          if (result.changed) {
            value[index] = result.value;
            return { value, changed: true };
          }
        }
      } else if (typeof value === "object" && value !== null) {
        for (const [key, field] of Object.entries(value)) {
          const result = mutateRecord(field);
          if (result.changed) {
            (value as Record<string, unknown>)[key] = result.value;
            return { value, changed: true };
          }
        }
      }
      return { value, changed: false };
    };
    const replay = route((request) =>
      callsReply(
        request.calls.map((raw) => {
          const envelope = JSON.parse(raw) as { record: unknown };
          const mutated = mutateRecord(envelope.record);
          expect(mutated.changed).toBe(true);
          envelope.record = mutated.value;
          const changed = JSON.stringify(envelope);
          expect(Buffer.byteLength(changed, "utf8")).toBe(Buffer.byteLength(raw, "utf8"));
          return changed;
        }),
      ),
    );
    const verdict = await probeAnswerRecords(
      target(replay.fetch, {
        selection: "typed",
        requestBudget: limit("endpointProbe.answerRecordTypedRequestBudget"),
        inputTokenBudget: limit("endpointProbe.answerRecordInputTokenBudget"),
        onReserve: async () => {},
      }),
    );

    expect(verdict.decision).toBe("measured");
    if (verdict.decision !== "measured") throw new Error("expected typed measurement");
    const calls = verdict.observation.samples.flatMap((sample) => sample.calls);
    expect(calls).toHaveLength(9);
    expect(calls.every((call) => call.decode === "admitted" && !call.deepEqual)).toBe(true);
    expect(verdict.notes.join(" ")).toContain("MEASURED is not an exact-copy qualification");
    expect(formatAnswerRecordProbe(verdict).join("\n")).toContain(
      "Planned-envelope matches: 0/9; size/schema admission is separate",
    );
  });

  it("matches typed schema failures through the production Pi validator", () => {
    const tool = answerRecordTool("typed").function;
    expect(() =>
      PI.validateToolArguments(tool, {
        type: "toolCall",
        id: "typed-valid",
        name: ANSWER_RECORD_TOOL_NAME,
        arguments: { type: "dimension", key: "d1", record: { rationale: 'escaped \\"quote\\"' } },
      }),
    ).not.toThrow();
    expect(() =>
      PI.validateToolArguments(tool, {
        type: "toolCall",
        id: "typed-invalid",
        name: ANSWER_RECORD_TOOL_NAME,
        arguments: { type: 17, key: "d1", record: { rationale: "x" } },
      }),
    ).toThrow();
    expect(tool.parameters.properties).toMatchObject({
      type: {
        type: "string",
        enum: [
          "target-judgment",
          "dimension",
          "finding",
          "layer-note",
          "evaluation-note",
          "quality-score",
        ],
      },
      key: { type: "string" },
      record: { type: ["object", "string"] },
    });
  });

  it("screens six typed maxima and one typed pair at P without changing the existing tranche", async () => {
    const replay = route((request) => {
      const expected = JSON.parse(request.calls[0]!) as { type: string };
      return request.calls.length === 1 && expected.type === "quality-score"
        ? callsReply(['{"type":"quality-score","record":null}'])
        : faithful(request);
    }, "A-t-context");
    const priorLedger = {
      observations: 3,
      reservations: 0,
      requests: 23,
      typedRequests: 9,
      transportRetriesUsed: 0,
      inputTokens: 155_236,
    };
    let reservation:
      | { requests: number; inputTokens: number; plan: AnswerRecordProbePlan }
      | undefined;
    const p = CORPUS.padding.targetTokens;
    const verdict = await probeAnswerRecords(
      target(replay.fetch, {
        selection: "typed",
        typedContextMix: true,
        requestBudget: { ...limit("endpointProbe.answerRecordTypedRequestBudget"), value: 8 },
        inputTokenBudget: {
          ...limit("endpointProbe.answerRecordInputTokenBudget"),
          value: 444_764,
        },
        ledger: priorLedger,
        onReserve: async (value) => {
          reservation = value;
        },
      }),
    );

    expect(verdict.decision).toBe("measured");
    expect(replay.requests).toHaveLength(7);
    expect(replay.requests.every((request) => request.phase === "A-t-context")).toBe(true);
    expect(
      replay.requests.every(
        (request) =>
          request.body.messages[0].role === "system" &&
          request.body.messages[0].content === DOCSFAB_SYSTEM_PROMPT &&
          request.body.messages[1].content.includes("Reading context") &&
          request.body.tools[0].function.parameters.properties.type.enum.length === 6 &&
          request.body.tool_choice === "required",
      ),
    ).toBe(true);
    expect(verdict.observation.typedContextMix).toBe(true);
    expect(verdict.observation.plan).toMatchObject({
      selection: "typed",
      typedContextMix: true,
      requests: 7,
      requestBudget: 8,
      inputTokenBudget: 444_764,
      paddedRequests: 7,
      plannedInputTokens: 424_116,
      paddedRetriesThatFit: 0,
      ledger: priorLedger,
    });
    expect(reservation).toMatchObject({
      requests: 8,
      inputTokens: 444_764,
      plan: { requests: 7, plannedInputTokens: 424_116 },
    });
    expect(verdict.observation.samples).toHaveLength(7);
    expect(verdict.observation.samples.every((sample) => sample.estimatedInputTokens === p)).toBe(
      true,
    );
    const singletonSamples = verdict.observation.samples.filter(
      (sample) => sample.expectedCalls === 1,
    );
    const singletonTypes = singletonSamples.map((sample) => sample.contextTypes?.[0]);
    expect(new Set(singletonTypes)).toEqual(new Set(ANSWER_RECORD_TYPES));
    expect(singletonSamples.every((sample) => sample.paddingChars > 0 && sample.admitted)).toBe(
      true,
    );
    const group = verdict.observation.samples.find((sample) => sample.expectedCalls === 2)!;
    expect(group.contextTypes).toEqual(["dimension", "finding"]);
    expect(group.admitted).toBe(true);
    expect(group.calls).toHaveLength(2);
    expect(
      group.calls.every(
        (call) => call.piValidation === "ok" && call.decode === "admitted" && call.deepEqual,
      ),
    ).toBe(true);
    const nullScore = singletonSamples.find(
      (sample) => sample.contextTypes?.[0] === "quality-score",
    )!;
    expect(nullScore.calls[0]).toMatchObject({
      piValidation: "ok",
      decode: "admitted",
      recordEncoding: "null",
      deepEqual: true,
      rawBytes: 38,
    });
    expect(nullScore.plannedBytes).toBe(40);
    expect(nullScore.failure).toBeNull();
    expect(verdict.measurement.typedContextSingletonTtftP90Ms).toBe(verdict.measurement.ttftP90Ms);
    expect(verdict.measurement.typedContextGroupTtftMs).toBe(group.ttftMs);
    expect(verdict.measurement.projections).toEqual([]);
    expect(verdict.notes.join(" ")).toContain(
      "does not satisfy the #1967 live-probe GO prerequisite",
    );
    const observationText = canonicalJson(verdict.observation as never);
    const contextObservation = {
      name: `${createHash("sha256").update(observationText).digest("hex")}.json`,
      text: observationText,
    };
    const legacyTypedText = readFileSync(join(OBSERVATIONS_PATH, RETAINED_A_T_FILE), "utf8");
    const legacyTyped = JSON.parse(legacyTypedText) as Record<string, any>;
    expect(legacyTyped.schemaVersion).toBe(2);
    expect(legacyTyped.samples[0]).not.toHaveProperty("transportObservation");
    const persistedLedger = answerRecordTypedLedger([
      { name: PREMISE_FILE, text: readFileSync(join(OBSERVATIONS_PATH, PREMISE_FILE), "utf8") },
      {
        name: RETAINED_K_FILE,
        text: readFileSync(join(OBSERVATIONS_PATH, RETAINED_K_FILE), "utf8"),
      },
      {
        name: RETAINED_A_T_FILE,
        text: legacyTypedText,
      },
      contextObservation,
    ]);
    expect(persistedLedger).toMatchObject({
      observations: 4,
      reservations: 0,
      requests: 30,
      typedRequests: 16,
      inputTokens: 579_352,
      transportRetriesUsed: 0,
    });

    const refusedReplay = route(faithful, "A-t-context");
    let reservedOnRefusal = false;
    await expect(
      probeAnswerRecords(
        target(refusedReplay.fetch, {
          selection: "typed",
          typedContextMix: true,
          requestBudget: { ...limit("endpointProbe.answerRecordTypedRequestBudget"), value: 8 },
          inputTokenBudget: {
            ...limit("endpointProbe.answerRecordInputTokenBudget"),
            value: 424_115,
          },
          ledger: priorLedger,
          onReserve: async () => {
            reservedOnRefusal = true;
          },
        }),
      ),
    ).rejects.toMatchObject({ observed: 424_116 });
    expect(refusedReplay.requests).toHaveLength(0);
    expect(reservedOnRefusal).toBe(false);
  });

  it("sends only the previously unsent typed context pair and reserves the full remaining tranche", async () => {
    const replay = route(faithful, "A-t-context");
    let reservation:
      | { requests: number; inputTokens: number; plan: AnswerRecordProbePlan }
      | undefined;
    const verdict = await probeAnswerRecords(
      target(replay.fetch, {
        selection: "typed",
        typedContextMix: true,
        typedContextGroupOnly: true,
        requestBudget: { ...limit("endpointProbe.answerRecordTypedRequestBudget"), value: 2 },
        inputTokenBudget: {
          ...limit("endpointProbe.answerRecordInputTokenBudget"),
          value: 81_236,
        },
        ledger: {
          observations: 4,
          reservations: 0,
          requests: 29,
          typedRequests: 15,
          transportRetriesUsed: 0,
          inputTokens: 518_764,
        },
        onReserve: async (value) => {
          reservation = value;
        },
      }),
    );

    expect(verdict.decision).toBe("measured");
    expect(replay.requests).toHaveLength(1);
    const [request] = replay.requests;
    expect(request?.phase).toBe("A-t-context");
    expect(request?.calls).toHaveLength(2);
    expect(request?.calls.map((raw) => (JSON.parse(raw) as { type: string }).type)).toEqual([
      "dimension",
      "finding",
    ]);
    expect(verdict.observation).toMatchObject({
      typedContextMix: true,
      typedContextGroupOnly: true,
      plan: {
        requests: 1,
        requestBudget: 2,
        plannedInputTokens: 60_588,
        inputTokenBudget: 81_236,
        paddedRetriesThatFit: 0,
      },
      samples: [
        {
          phase: "A-t-context",
          expectedCalls: 2,
          contextTypes: ["dimension", "finding"],
          admitted: true,
        },
      ],
    });
    expect(
      verdict.observation.samples[0]?.calls.every(
        (call) => call.decode === "admitted" && call.piValidation === "ok" && call.deepEqual,
      ),
    ).toBe(true);
    expect(reservation).toMatchObject({
      requests: 2,
      inputTokens: 81_236,
      plan: { requests: 1, plannedInputTokens: 60_588 },
    });
    expect(verdict.notes.join(" ")).toContain("one exploratory");
    expect(verdict.notes.join(" ")).toContain("does not");
  });

  it("stops the typed context screen on a same-size substituted singleton", async () => {
    const replay = route((request) => {
      const envelope = JSON.parse(request.calls[0]!) as { record: unknown };
      const mutation = replaceFirstString(envelope.record);
      expect(mutation.changed).toBe(true);
      envelope.record = mutation.value;
      const substituted = JSON.stringify(envelope);
      expect(Buffer.byteLength(substituted, "utf8")).toBe(
        Buffer.byteLength(request.calls[0]!, "utf8"),
      );
      return callsReply([substituted]);
    }, "A-t-context");
    const verdict = await probeAnswerRecords(
      target(replay.fetch, {
        selection: "typed",
        typedContextMix: true,
        requestBudget: limit("endpointProbe.answerRecordTypedRequestBudget"),
        inputTokenBudget: limit("endpointProbe.answerRecordInputTokenBudget"),
        onReserve: async () => {},
      }),
    );

    expect(verdict).toMatchObject({ decision: "no-go", cause: "typed-shell-not-admitted" });
    expect(replay.requests).toHaveLength(1);
    expect(verdict.observation.samples[0]).toMatchObject({
      phase: "A-t-context",
      admitted: false,
      failure: "copy",
      calls: [{ piValidation: "ok", decode: "admitted", deepEqual: false }],
    });
  });

  it("stops the typed context screen when its dimension+finding group repeats one maximum", async () => {
    const replay = route(
      (request) =>
        request.calls.length === 2
          ? callsReply([request.calls[1]!, request.calls[1]!])
          : faithful(request),
      "A-t-context",
    );
    const verdict = await probeAnswerRecords(
      target(replay.fetch, {
        selection: "typed",
        typedContextMix: true,
        requestBudget: limit("endpointProbe.answerRecordTypedRequestBudget"),
        inputTokenBudget: limit("endpointProbe.answerRecordInputTokenBudget"),
        onReserve: async () => {},
      }),
    );

    expect(verdict).toMatchObject({ decision: "no-go", cause: "typed-shell-not-admitted" });
    expect(replay.requests).toHaveLength(7);
    expect(verdict.observation.samples.at(-1)).toMatchObject({
      phase: "A-t-context",
      contextTypes: ["dimension", "finding"],
      expectedCalls: 2,
      admitted: false,
      failure: "copy",
      calls: [
        { piValidation: "ok", decode: "admitted", deepEqual: true },
        { piValidation: "ok", decode: "admitted", deepEqual: false },
      ],
    });
  });

  it("distinguishes a typed-shell response rejection from the policy-blocked phase G", async () => {
    const replay = route((request) => {
      const malformed = { ...JSON.parse(request.calls[0]!), type: "unknown-record-kind" };
      return callsReply([JSON.stringify(malformed)]);
    });
    const verdict = await probeAnswerRecords(
      target(replay.fetch, {
        selection: "typed",
        requestBudget: limit("endpointProbe.answerRecordTypedRequestBudget"),
        inputTokenBudget: limit("endpointProbe.answerRecordInputTokenBudget"),
        onReserve: async () => {},
      }),
    );
    expect(verdict).toMatchObject({ decision: "no-go", cause: "typed-shell-not-admitted" });
    expect(verdict.observation.samples).toHaveLength(1);
    expect(
      verdict.observation.samples.every((sample) => sample.calls[0]?.piValidation === "refused"),
    ).toBe(true);
    expect(verdict.observation.phaseG).toMatchObject({ status: "not-executed", requests: 0 });
    expect(replay.requests.every((request) => request.phase === "A-t")).toBe(true);
  });

  it("parses --answer-records only with --live, its corpus, and never with --answer-submission", () => {
    const corpus = ["--answer-record-corpus", "/corpus/corpus.json"];
    expect(parseDoctorArguments(["--live", "--answer-records", ...corpus])).toMatchObject({
      live: true,
      answerRecords: true,
      answerRecordCorpus: "/corpus/corpus.json",
    });
    expect(parseDoctorArguments(["--live"])).not.toHaveProperty("answerRecords");
    expect(() => parseDoctorArguments(["--answer-records", ...corpus])).toThrow("requires --live");
    expect(() =>
      parseDoctorArguments(["--live", "--answer-records", "--answer-submission", ...corpus]),
    ).toThrow("cannot combine");
    expect(() => parseDoctorArguments(["--live", "--answer-records"])).toThrow(
      "given together or not at all",
    );
    expect(() => parseDoctorArguments(["--live", ...corpus])).toThrow(
      "given together or not at all",
    );
    expect(
      parseDoctorArguments([
        "--live",
        "--answer-records",
        ...corpus,
        "--answer-record-small-groups",
      ]),
    ).toMatchObject({ answerRecords: true, answerRecordSmallGroups: true });
    expect(parseDoctorArguments(["--live", "--answer-records", ...corpus])).not.toHaveProperty(
      "answerRecordSmallGroups",
    );
    expect(() => parseDoctorArguments(["--live", "--answer-record-small-groups"])).toThrow(
      "requires --live --answer-records",
    );
    expect(
      parseDoctorArguments(["--live", "--answer-records", ...corpus, "--answer-record-typed"]),
    ).toMatchObject({ answerRecords: true, answerRecordTyped: true });
    expect(() => parseDoctorArguments(["--live", ...corpus, "--answer-record-typed"])).toThrow(
      "requires --live --answer-records",
    );
    expect(() =>
      parseDoctorArguments([
        "--live",
        "--answer-records",
        ...corpus,
        "--answer-record-typed-context",
      ]),
    ).toThrow("requires --live --answer-records --answer-record-typed");
    expect(
      parseDoctorArguments([
        "--live",
        "--answer-records",
        ...corpus,
        "--answer-record-typed",
        "--answer-record-typed-context",
      ]),
    ).toMatchObject({
      answerRecords: true,
      answerRecordTyped: true,
      answerRecordTypedContext: true,
    });
    expect(() =>
      parseDoctorArguments([
        "--live",
        "--answer-records",
        ...corpus,
        "--answer-record-typed",
        "--answer-record-small-groups",
      ]),
    ).toThrow("different probe plans");
  });

  it("plans the exact typed verifier minimum without sending and binds it to the producer target", () => {
    const plan = buildAnswerRecordQualificationPlan(
      target(globalThis.fetch, {
        selection: "typed",
        compositionBinding: {
          compositionId: "probe-composition",
          compositionSha256: "b".repeat(64),
          requestPolicySha256: "c".repeat(64),
        },
      }),
    );
    expect(plan).toMatchObject({
      shell: "typed",
      modelId: "probe-model",
      routeId: "probe-route",
      deploymentIdentitySha256: "a".repeat(64),
      compositionId: "probe-composition",
      compositionSha256: "b".repeat(64),
      requestPolicySha256: "c".repeat(64),
      systemPromptSha256: createHash("sha256").update(DOCSFAB_SYSTEM_PROMPT).digest("hex"),
      corpusSha256: ANSWER_RECORD_CORPUS_SHA256,
      paddingTargetTokens: CORPUS.padding.targetTokens,
      requests: 12,
      paddedRequests: 3,
      plannedInputTokens: 194034,
      transportRetries: 0,
    });
    expect(plan.cells.filter((cell) => cell.phase === "A-t").map((cell) => cell.rungBytes)).toEqual(
      [2048, 2048, 2048, 4096, 4096, 4096],
    );
    expect(plan.cells.filter((cell) => cell.phase === "B")).toHaveLength(3);
    expect(
      plan.cells
        .filter((cell) => cell.phase === "B")
        .every(
          (cell) =>
            cell.plannedBytes === 6144 && cell.estimatedInputTokens === CORPUS.padding.targetTokens,
        ),
    ).toBe(true);
    expect(plan.cells.filter((cell) => cell.phase === "C")).toHaveLength(3);
    expect(
      plan.cells
        .flatMap((cell) => cell.calls)
        .filter((call) => call.type === "quality-score" && !call.stringifiedNull),
    ).toHaveLength(0);
  });

  it("keeps raw prompt and installed canonical policy digests distinct for the selected profile without fetching", async () => {
    const binding = await resolveOperatorExecutionBinding({ model: SUPER });
    const policy = binding.bound?.composition.requestPolicy;
    expect(policy).toBeDefined();
    const plan = await planAnswerRecordQualification(SUPER, {
      corpusPath: CORPUS_PATH,
      selection: "typed",
      observationDirectory: OBSERVATIONS_PATH,
    });
    expect("decision" in plan).toBe(false);
    if ("decision" in plan) throw new Error(plan.reason);
    expect(plan.systemPromptSha256).toBe(
      createHash("sha256").update(DOCSFAB_SYSTEM_PROMPT, "utf8").digest("hex"),
    );
    expect(plan.installedSystemInstructionCanonicalDigest).toBe(
      canonicalDigest(DOCSFAB_SYSTEM_PROMPT),
    );
    expect(policy!.installedSystemInstructionSha256).toBe(
      plan.installedSystemInstructionCanonicalDigest,
    );
    expect(plan.systemPromptSha256).not.toBe(plan.installedSystemInstructionCanonicalDigest);
  });

  it("plans the diagnostic from installed identity without reading a provider credential", async () => {
    const credentialless = { ...SUPER };
    Object.defineProperty(credentialless, "apiKey", {
      configurable: true,
      get() {
        throw new Error("diagnostic planning must not resolve or read a provider credential");
      },
    });

    const plan = await planAnswerRecordDiagnostic(credentialless, {
      corpusPath: CORPUS_PATH,
      observationDirectory: OBSERVATIONS_PATH,
    });

    expect("decision" in plan).toBe(false);
    if ("decision" in plan) throw new Error(plan.reason);
    expect(plan.diagnostic.diagnosticFingerprint).toBe(
      "925a327c557fc58cf3e3b6754ff452a79f5a6451b37ec14e9bb53b0463e41fbb",
    );
    expect(JSON.stringify(plan)).not.toContain("apiKey");
  });

  it("refuses to execute a provider-free target before reservation or fetch", async () => {
    const replay = route(faithful);
    const reserve = vi.fn(async () => {});
    await expect(
      probeAnswerRecords(
        target(replay.fetch, {
          provider: undefined,
          diagnosticCell: true,
          onReserve: reserve,
        }),
      ),
    ).rejects.toThrow("requires a credentialed provider binding");
    expect(replay.requests).toHaveLength(0);
    expect(reserve).not.toHaveBeenCalled();
  });

  it("uses that exact matrix in a mocked live probe and reserves it without retries", async () => {
    const replay = route(faithful);
    let reservationRequests = 0;
    let reservation:
      | import("../src/profile/answer-record-probe.js").AnswerRecordReservation
      | undefined;
    const selected = target(replay.fetch, { selection: "typed", qualificationCells: true });
    const pinned = exactQualificationEvidence(selected);
    const verdict = await probeAnswerRecords({
      ...selected,
      selection: "typed",
      qualificationCells: true,
      onReserve: async (reserved) => {
        reservationRequests = reserved.plan.requests;
        reservation = reserved;
      },
    });
    expect(replay.requests).toHaveLength(12);
    expect(reservationRequests).toBe(12);
    expect(verdict.observation.samples).toHaveLength(12);
    expect(verdict.measurement.transportRetriesUsed).toBe(0);
    expect(reservation?.exactQualification).toEqual(pinned);
    expect(verdict.observation.exactQualification).toEqual(pinned);
    expect(isAnswerRecordExactQualificationEvidence(verdict.observation.exactQualification)).toBe(
      true,
    );
    const persistedReservation = canonicalJson(reservation as never);
    const persistedObservation = canonicalJson(verdict.observation as never);
    expect(JSON.parse(persistedReservation).exactQualification).toEqual(pinned);
    expect(JSON.parse(persistedObservation).exactQualification).toEqual(pinned);
    const retainedBase = [
      { name: PREMISE_FILE, text: readFileSync(join(OBSERVATIONS_PATH, PREMISE_FILE), "utf8") },
      {
        name: RETAINED_K_FILE,
        text: readFileSync(join(OBSERVATIONS_PATH, RETAINED_K_FILE), "utf8"),
      },
      {
        name: RETAINED_A_T_FILE,
        text: readFileSync(join(OBSERVATIONS_PATH, RETAINED_A_T_FILE), "utf8"),
      },
    ];
    const baseLedger = answerRecordTypedLedger(retainedBase);
    const reservationDigest = createHash("sha256").update(persistedReservation).digest("hex");
    const reservationLedger = answerRecordTypedLedger([
      ...retainedBase,
      { name: `${reservationDigest}.json`, text: persistedReservation },
    ]);
    expect(reservationLedger.reservations).toBe(1);
    expect(reservationLedger.typedRequests).toBe(baseLedger.typedRequests! + reservation!.requests);
    const observationDigest = createHash("sha256").update(persistedObservation).digest("hex");
    const observationLedger = answerRecordTypedLedger([
      ...retainedBase,
      { name: `${observationDigest}.json`, text: persistedObservation },
    ]);
    expect(observationLedger.reservations).toBe(0);
    expect(observationLedger.typedRequests).toBe(
      baseLedger.typedRequests! + verdict.observation.samples.length,
    );
    const tampered = structuredClone(pinned) as { compositionSha256: string };
    tampered.compositionSha256 = "0".repeat(64);
    expect(isAnswerRecordExactQualificationEvidence(tampered)).toBe(false);
  });

  it("fingerprints the reviewed identity and cells while excluding mutable budget headroom", () => {
    const replay = route(faithful);
    const selected = target(replay.fetch, { selection: "typed", qualificationCells: true });
    const original = buildAnswerRecordQualificationPlan(selected);
    const budgetChanged = buildAnswerRecordQualificationPlan({
      ...selected,
      requestBudget: { ...selected.requestBudget, value: selected.requestBudget.value + 1 },
      inputTokenBudget: {
        ...selected.inputTokenBudget,
        value: selected.inputTokenBudget.value + 10_000,
      },
    });
    const identityChanged = buildAnswerRecordQualificationPlan({
      ...selected,
      deploymentBinding: {
        status: "bound",
        routeId: "probe-route",
        transport: "openai-chat-completions",
        deploymentIdentitySha256: "d".repeat(64),
      },
    });
    expect(original.qualificationFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(budgetChanged.qualificationFingerprint).toBe(original.qualificationFingerprint);
    expect(identityChanged.qualificationFingerprint).not.toBe(original.qualificationFingerprint);
  });

  it("plans one fingerprint-bound B diagnostic cell without fetching or exposing credentials", () => {
    const replay = route(faithful);
    const selected = target(replay.fetch, { selection: "typed" });
    const original = buildAnswerRecordDiagnosticPlan(selected);
    const repeated = buildAnswerRecordDiagnosticPlan(selected);
    const changed = buildAnswerRecordDiagnosticPlan({
      ...selected,
      deploymentBinding: {
        status: "bound",
        routeId: "probe-route",
        transport: "openai-chat-completions",
        deploymentIdentitySha256: "d".repeat(64),
      },
    });
    expect(original).toMatchObject({
      requests: 1,
      plannedInputTokens: CORPUS.padding.targetTokens,
      transportRetries: 0,
      billing: { status: "not-reported", cost: null },
      diagnostic: {
        purpose: "transport-call-assembly-diagnostic-only",
        shell: "typed",
        requestOptions: { toolChoice: "required", parallelToolCalls: "omitted" },
        cell: { phase: "B", rungBytes: 6144, seed: 1, plannedBytes: 6144 },
      },
    });
    expect(original.diagnostic.cell.calls).toHaveLength(9);
    expect(original.diagnostic.diagnosticFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(repeated.diagnostic.diagnosticFingerprint).toBe(
      original.diagnostic.diagnosticFingerprint,
    );
    expect(changed.diagnostic.diagnosticFingerprint).not.toBe(
      original.diagnostic.diagnosticFingerprint,
    );
    expect(JSON.stringify(original)).not.toContain("probe-key");
    expect(replay.requests).toHaveLength(0);
  });

  it("refuses a mismatched diagnostic fingerprint before reservation or provider fetch", async () => {
    const replay = route(faithful);
    const selected = target(replay.fetch, { selection: "typed" });
    let reservations = 0;
    await expect(
      probeAnswerRecords({
        ...selected,
        diagnosticCell: true,
        expectedDiagnosticFingerprint: "e".repeat(64),
        onReserve: async () => {
          reservations += 1;
        },
      }),
    ).rejects.toThrow("identity or selected cell changed");
    expect(reservations).toBe(0);
    expect(replay.requests).toHaveLength(0);
  });

  it("refuses a diagnostic cell that exceeds retained request or input headroom before reserve", async () => {
    const replay = route(faithful);
    const selected = target(replay.fetch, { selection: "typed" });
    const planned = buildAnswerRecordDiagnosticPlan(selected);
    let reservations = 0;
    await expect(
      probeAnswerRecords({
        ...selected,
        diagnosticCell: true,
        expectedDiagnosticFingerprint: planned.diagnostic.diagnosticFingerprint,
        requestBudget: { ...selected.requestBudget, value: 0 },
        onReserve: async () => {
          reservations += 1;
        },
      }),
    ).rejects.toThrow();
    await expect(
      probeAnswerRecords({
        ...selected,
        diagnosticCell: true,
        expectedDiagnosticFingerprint: planned.diagnostic.diagnosticFingerprint,
        inputTokenBudget: { ...selected.inputTokenBudget, value: planned.plannedInputTokens - 1 },
        onReserve: async () => {
          reservations += 1;
        },
      }),
    ).rejects.toThrow();
    expect(reservations).toBe(0);
    expect(replay.requests).toHaveLength(0);
  });

  it("does not retry a failed one-cell diagnostic transport", async () => {
    const replay = route(() => {
      throw new Error("diagnostic transport failure");
    });
    const selected = target(replay.fetch, { selection: "typed" });
    const planned = buildAnswerRecordDiagnosticPlan(selected);
    const verdict = await probeAnswerRecords({
      ...selected,
      diagnosticCell: true,
      expectedDiagnosticFingerprint: planned.diagnostic.diagnosticFingerprint,
      onReserve: async () => undefined,
    });
    expect(verdict.decision).toBe("diagnostic");
    if (verdict.decision !== "diagnostic") throw new Error("Expected diagnostic-only result");
    expect(verdict.outcome).toBe("transport-error");
    expect(replay.requests).toHaveLength(1);
    expect(verdict.measurement.transportRetriesUsed).toBe(0);
    expect(verdict.observation.samples[0]?.expectedCalls).toBe(9);
    expect(verdict.observation.samples[0]?.calls).toHaveLength(0);
  });

  it("executes only the selected diagnostic cell, charges the typed ledger, and cannot qualify", async () => {
    const replay = route(faithful);
    const selected = target(replay.fetch, { selection: "typed" });
    const planned = buildAnswerRecordDiagnosticPlan(selected);
    let reservation:
      | import("../src/profile/answer-record-probe.js").AnswerRecordReservation
      | undefined;
    const verdict = await probeAnswerRecords({
      ...selected,
      diagnosticCell: true,
      expectedDiagnosticFingerprint: planned.diagnostic.diagnosticFingerprint,
      onReserve: async (value) => {
        reservation = value;
      },
    });
    expect(replay.requests).toHaveLength(1);
    expect(replay.requests[0]?.phase).toBe("B");
    expect(replay.requests[0]?.calls).toHaveLength(9);
    expect(replay.requests[0]?.body.tool_choice).toBe("required");
    expect(replay.requests[0]?.body).not.toHaveProperty("parallel_tool_calls");
    expect(verdict.decision).toBe("diagnostic");
    if (verdict.decision !== "diagnostic") throw new Error("Expected diagnostic-only result");
    expect(verdict.observation.samples).toHaveLength(1);
    expect(verdict.observation.samples[0]?.expectedCalls).toBe(9);
    expect(verdict.observation.diagnosticOnly).toEqual(planned.diagnostic);
    expect(verdict.observation.exactQualification).toBeUndefined();
    expect(reservation?.plan.requests).toBe(1);
    expect(reservation?.plan.transportRetries).toBe(0);
    expect(reservation?.diagnosticOnly).toEqual(planned.diagnostic);

    const persistedReservation = canonicalJson(reservation as never);
    const persistedObservation = canonicalJson(verdict.observation as never);
    const retainedBase = [
      { name: PREMISE_FILE, text: readFileSync(join(OBSERVATIONS_PATH, PREMISE_FILE), "utf8") },
    ];
    const baseLedger = answerRecordTypedLedger(retainedBase);
    const reservationDigest = createHash("sha256").update(persistedReservation).digest("hex");
    const reservedLedger = answerRecordTypedLedger([
      ...retainedBase,
      { name: `${reservationDigest}.json`, text: persistedReservation },
    ]);
    expect(reservedLedger.typedRequests).toBe(reservation?.requests);
    const observationDigest = createHash("sha256").update(persistedObservation).digest("hex");
    const settledLedger = answerRecordTypedLedger([
      ...retainedBase,
      { name: `${observationDigest}.json`, text: persistedObservation },
    ]);
    expect(settledLedger.typedRequests).toBe(1);
    expect(settledLedger.inputTokens).toBe(
      baseLedger.inputTokens +
        Math.max(
          verdict.observation.samples[0]!.promptTokens ?? 0,
          verdict.observation.samples[0]!.estimatedInputTokens,
        ),
    );
    expect(JSON.stringify(verdict.observation)).not.toContain("probe-key");
    const tampered = JSON.parse(persistedObservation) as Record<string, any>;
    tampered.diagnosticOnly.diagnosticFingerprint = "0".repeat(64);
    const tamperedText = canonicalJson(tampered as never);
    const tamperedDigest = createHash("sha256").update(tamperedText).digest("hex");
    expect(() =>
      answerRecordTypedLedger([
        ...retainedBase,
        { name: `${tamperedDigest}.json`, text: tamperedText },
      ]),
    ).toThrow("invalid diagnostic-only binding");
  });

  it("refuses unbound or changed exact plans before reservation and provider fetch", async () => {
    let reservations = 0;
    const unboundReplay = route(faithful);
    const unbound = target(unboundReplay.fetch, {
      selection: "typed",
      qualificationCells: true,
      expectedQualificationFingerprint: "e".repeat(64),
      deploymentBinding: { status: "unavailable", reason: "unmatched-byo" },
    });
    expect(() => buildAnswerRecordQualificationPlan(unbound)).toThrow("host-bound route");
    await expect(
      probeAnswerRecords(
        target(unboundReplay.fetch, {
          ...unbound,
          onReserve: async () => {
            reservations += 1;
          },
        }),
      ),
    ).rejects.toThrow("host-bound route");
    expect(unboundReplay.requests).toHaveLength(0);
    expect(reservations).toBe(0);

    for (const missingBinding of [
      {
        deploymentBinding: {
          status: "bound" as const,
          routeId: "nvidia-api-catalog",
          deploymentIdentitySha256: "d".repeat(64),
          transport: "openai-chat-completions" as const,
        },
        compositionBinding: undefined,
      },
      {
        deploymentBinding: {
          status: "bound" as const,
          routeId: "nvidia-api-catalog",
          deploymentIdentitySha256: "d".repeat(64),
          transport: "openai-chat-completions" as const,
        },
        compositionBinding: {
          compositionId: "bound-composition",
          compositionSha256: "f".repeat(64),
        },
      },
      {
        deploymentBinding: {
          status: "bound" as const,
          routeId: "nvidia-api-catalog",
          deploymentIdentitySha256: "missing-deployment-digest",
          transport: "openai-chat-completions" as const,
        },
        compositionBinding: {
          compositionId: "bound-composition",
          compositionSha256: "f".repeat(64),
          requestPolicySha256: "c".repeat(64),
        },
      },
    ]) {
      const missingReplay = route(faithful);
      const incomplete = target(missingReplay.fetch, {
        selection: "typed",
        qualificationCells: true,
        expectedQualificationFingerprint: "e".repeat(64),
        ...missingBinding,
        onReserve: async () => {
          reservations += 1;
        },
      });
      await expect(probeAnswerRecords(incomplete)).rejects.toThrow(
        "requires nonempty model, route, deployment, composition, and request-policy identities",
      );
      expect(missingReplay.requests).toHaveLength(0);
      expect(reservations).toBe(0);
    }

    const reviewedReplay = route(faithful);
    const reviewed = target(reviewedReplay.fetch, {
      selection: "typed",
      qualificationCells: true,
    });
    const reviewedFingerprint =
      buildAnswerRecordQualificationPlan(reviewed).qualificationFingerprint;
    const driftedReplay = route(faithful);
    const drifted = target(driftedReplay.fetch, {
      selection: "typed",
      qualificationCells: true,
      expectedQualificationFingerprint: reviewedFingerprint,
      compositionBinding: {
        compositionId: "drifted-composition",
        compositionSha256: "f".repeat(64),
        requestPolicySha256: "c".repeat(64),
      },
      onReserve: async () => {
        reservations += 1;
      },
    });
    await expect(probeAnswerRecords(drifted)).rejects.toThrow("identity or cell plan changed");
    expect(driftedReplay.requests).toHaveLength(0);
    expect(reservations).toBe(0);
  });

  it("reads and reserves exact qualification against the explicitly selected retained ledger", async () => {
    const directory = mkdtempSync(join(tmpdir(), "docsfab-answer-record-exact-ledger-"));
    try {
      const retainedFiles = readdirSync(OBSERVATIONS_PATH)
        .filter((name) => name.endsWith(".json"))
        .sort();
      for (const name of retainedFiles) {
        writeFileSync(join(directory, name), readFileSync(join(OBSERVATIONS_PATH, name), "utf8"));
      }
      const plan = await planAnswerRecordQualification(SUPER, {
        corpusPath: CORPUS_PATH,
        selection: "typed",
        observationDirectory: directory,
      });
      expect("decision" in plan).toBe(false);
      if ("decision" in plan) throw new Error(plan.reason);
      const replay = route(faithful);
      vi.stubGlobal("fetch", replay.fetch);
      await expect(
        recordAnswerRecordProbe(SUPER, {
          corpusPath: CORPUS_PATH,
          selection: "typed",
          qualificationCells: true,
          expectedQualificationFingerprint: plan.qualificationFingerprint,
          observationDirectory: directory,
        }),
      ).rejects.toMatchObject({
        code: "endpoint-probe-answer-record-typed-request-budget",
        configured: 1,
        observed: 12,
      });
      expect(replay.requests).toHaveLength(0);
      // The same explicit path supplied the one-slot remainder; no lock or
      // reservation escaped to a different state-derived directory.
      expect(readdirSync(directory).sort()).toEqual(retainedFiles);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("matches the frozen phase-C oversize exemption and refuses a length failure at the record bound", async () => {
    const overBound = route((request) =>
      request.phase === "C"
        ? callsReply(
            request.calls.map((call) => call.replaceAll(',"', ', "')),
            "length",
          )
        : faithful(request),
    );
    const accepted = await probeAnswerRecords(
      target(overBound.fetch, {
        selection: "typed",
        qualificationCells: true,
        onReserve: async () => {},
      }),
    );
    expect(overBound.requests.filter((request) => request.phase === "C")).toHaveLength(3);
    expect(accepted.decision).toBe("measured");
    expect(
      accepted.observation.samples
        .filter((sample) => sample.phase === "C")
        .every(
          (sample) =>
            sample.failure === "length" &&
            sample.calls[0]!.rawBytes > accepted.measurement.maxRecordBytes!,
        ),
    ).toBe(true);

    const atBound = route((request) =>
      request.phase === "C" ? callsReply(request.calls, "length") : faithful(request),
    );
    const rejected = await probeAnswerRecords(
      target(atBound.fetch, {
        selection: "typed",
        qualificationCells: true,
        onReserve: async () => {},
      }),
    );
    expect(rejected.decision).toBe("no-go");
    expect(
      rejected.observation.samples
        .filter((sample) => sample.phase === "C")
        .every(
          (sample) =>
            sample.failure === "length" &&
            sample.calls[0]!.rawBytes === rejected.measurement.maxRecordBytes,
        ),
    ).toBe(true);
  });

  it("refuses an admitted equal-size but non-identical phase-C copy in exact qualification", async () => {
    const altered = route((request) => {
      if (request.phase !== "C") return faithful(request);
      const envelope = JSON.parse(request.calls[0]!) as {
        record: Record<string, unknown>;
      };
      const original = JSON.stringify(envelope);
      const replaceFreeText = (value: unknown): boolean => {
        if (Array.isArray(value)) return value.some(replaceFreeText);
        if (!value || typeof value !== "object") return false;
        for (const [key, field] of Object.entries(value)) {
          if ((key === "description" || key === "rationale") && typeof field === "string") {
            (value as Record<string, unknown>)[key] =
              `${field[0] === "x" ? "y" : "x"}${field.slice(1)}`;
            return true;
          }
          if (replaceFreeText(field)) return true;
        }
        return false;
      };
      expect(replaceFreeText(envelope.record)).toBe(true);
      const raw = JSON.stringify(envelope);
      expect(Buffer.byteLength(raw, "utf8")).toBe(Buffer.byteLength(original, "utf8"));
      return callsReply([raw]);
    });
    const verdict = await probeAnswerRecords(
      target(altered.fetch, {
        selection: "typed",
        qualificationCells: true,
        onReserve: async () => {},
      }),
    );
    expect(
      verdict.decision,
      JSON.stringify({
        reason: verdict.reason,
        transportErrors: verdict.transportErrors,
        phaseCSamples: verdict.observation.samples
          .filter((sample) => sample.phase === "C")
          .map((sample) => ({
            admitted: sample.admitted,
            failure: sample.failure,
            transportError: sample.transportError,
            calls: sample.calls.map((call) => ({
              piValidation: call.piValidation,
              decode: call.decode,
              deepEqual: call.deepEqual,
              rawBytes: call.rawBytes,
            })),
          })),
      }),
    ).toBe("no-go");
    expect(
      verdict.observation.samples
        .filter((sample) => sample.phase === "C")
        .every(
          (sample) =>
            sample.admitted &&
            sample.calls.length === sample.expectedCalls &&
            sample.calls.every((call) => call.decode === "admitted" && !call.deepEqual),
        ),
    ).toBe(true);
  });

  it("keeps a no-call phase-C byte-bound transport inconclusive, never an oversize qualification", async () => {
    const byteBound = Object.assign(new Error("bounded response refused"), {
      code: "provider-response-too-large",
    });
    const replay = route((request) => {
      if (request.phase === "C") throw byteBound;
      return faithful(request);
    });
    const verdict = await probeAnswerRecords(
      target(replay.fetch, {
        selection: "typed",
        qualificationCells: true,
        onReserve: async () => {},
      }),
    );
    expect(verdict.decision).toBe("inconclusive");
    expect(
      verdict.observation.samples
        .filter((sample) => sample.phase === "C")
        .every(
          (sample) =>
            sample.failure === "transport" &&
            sample.transportError === "byte-bound" &&
            sample.calls.length === 0 &&
            sample.expectedCalls === 1,
        ),
    ).toBe(true);
  });

  it("exposes plan-only and exact live-cell CLI forms without allowing plan-only live flags", () => {
    const corpus = ["--answer-record-corpus", "/corpus/corpus.json"];
    const fingerprint = "a".repeat(64);
    expect(
      parseDoctorArguments([
        "--answer-record-qualification-plan",
        ...corpus,
        "--answer-record-typed",
      ]),
    ).toMatchObject({
      answerRecordQualificationPlan: true,
      answerRecordTyped: true,
    });
    expect(
      parseDoctorArguments([
        "--live",
        "--answer-records",
        ...corpus,
        "--answer-record-qualification-cells",
        "--answer-record-typed",
        "--answer-record-qualification-fingerprint",
        fingerprint,
      ]),
    ).toMatchObject({
      answerRecordQualificationCells: true,
      answerRecordQualificationFingerprint: fingerprint,
      answerRecordTyped: true,
    });
    expect(
      parseDoctorArguments([
        "--live",
        "--answer-records",
        ...corpus,
        "--answer-record-qualification-cells",
        "--answer-record-typed",
        "--answer-record-qualification-fingerprint",
        fingerprint,
        "--answer-record-observation-dir",
        "/retained/answer-record-ledger",
      ]),
    ).toMatchObject({
      answerRecordObservationDirectory: "/retained/answer-record-ledger",
      answerRecordQualificationCells: true,
    });
    expect(() =>
      parseDoctorArguments([
        "--live",
        "--answer-records",
        ...corpus,
        "--answer-record-qualification-cells",
        "--answer-record-typed",
      ]),
    ).toThrow("requires the fingerprint");
    expect(() =>
      parseDoctorArguments(["--answer-record-qualification-plan", "--live", ...corpus]),
    ).toThrow("provider-free");
    expect(() =>
      parseDoctorArguments(["--answer-record-qualification-plan", "--catalog", ...corpus]),
    ).toThrow("provider-free");
    expect(() =>
      parseDoctorArguments([
        "--live",
        "--answer-records",
        ...corpus,
        "--answer-record-qualification-cells",
      ]),
    ).toThrow("typed selection");
    expect(
      parseDoctorArguments([
        "--answer-record-diagnostic-plan",
        ...corpus,
        "--answer-record-typed",
        "--answer-record-observation-dir",
        "/retained/answer-record-ledger",
      ]),
    ).toMatchObject({
      answerRecordDiagnosticPlan: true,
      answerRecordTyped: true,
      answerRecordObservationDirectory: "/retained/answer-record-ledger",
    });
    expect(
      parseDoctorArguments([
        "--live",
        "--answer-records",
        ...corpus,
        "--answer-record-typed",
        "--answer-record-diagnostic-cell",
        "--answer-record-diagnostic-fingerprint",
        fingerprint,
      ]),
    ).toMatchObject({
      answerRecords: true,
      answerRecordTyped: true,
      answerRecordDiagnosticCell: true,
      answerRecordDiagnosticFingerprint: fingerprint,
    });
    expect(() =>
      parseDoctorArguments([
        "--live",
        "--answer-records",
        ...corpus,
        "--answer-record-typed",
        "--answer-record-diagnostic-cell",
      ]),
    ).toThrow("requires the fingerprint");
    expect(() =>
      parseDoctorArguments([
        "--live",
        "--answer-records",
        ...corpus,
        "--answer-record-typed",
        "--answer-record-diagnostic-cell",
        "--answer-record-diagnostic-fingerprint",
        fingerprint,
        "--answer-record-qualification-cells",
      ]),
    ).toThrow("cannot combine with qualification");
    expect(() =>
      parseDoctorArguments([
        "--answer-record-diagnostic-plan",
        "--live",
        ...corpus,
        "--answer-record-typed",
      ]),
    ).toThrow("provider-free");
    expect(() =>
      parseDoctorArguments([
        "--live",
        "--answer-records",
        ...corpus,
        "--answer-record-typed",
        "--answer-record-diagnostic-cell",
        "--answer-record-diagnostic-fingerprint",
        "bad-fingerprint",
      ]),
    ).toThrow("lowercase 64-character");
    expect(() =>
      parseDoctorArguments([
        "--live",
        "--answer-records",
        ...corpus,
        "--answer-record-observation-dir",
        "/ledger",
      ]),
    ).toThrow("provider-free plan or the exact A/B/C qualification run");
  });

  it("binds the Super composition's timer, output limit and premise budgets", async () => {
    let shown: AnswerRecordProbePlan | undefined;
    const replay = route(faithful);
    vi.stubGlobal("fetch", replay.fetch);
    await expect(
      probeConfiguredAnswerRecords(SUPER, {
        corpusPath: CORPUS_PATH,
        onPlan: (plan) => {
          shown = plan;
          throw STOP_AT_PLAN;
        },
      }),
    ).rejects.toBe(STOP_AT_PLAN);
    expect(replay.requests).toHaveLength(0);
    expect(shown).toMatchObject({
      selection: "premise",
      requestTimeoutMs: 300_000,
      // The bound limits that set each rate's source and every projection's T*.
      decodeWindowMinBasisPoints: 2500,
      answerNowShareBasisPoints: 4000,
      transportRetries: 2,
      requestBudget: 24,
      inputTokenBudget: 600_000,
      ledger: null,
    });
    expect(messageBudgetBytes(8192)).toBe(18_743);
  });

  it("binds the small-group run to what the ledger leaves: 11 requests, 521,807 input tokens", async () => {
    const directory = ledgerDirectory();
    try {
      const plan = await planOf(directory);
      if ("decision" in plan) throw new Error(plan.reason);
      expect(plan).toMatchObject({
        selection: "small-groups",
        requestTimeoutMs: 300_000,
        decodeWindowMinBasisPoints: 2500,
        answerNowShareBasisPoints: 4000,
        transportRetries: 0,
        // The approved totals less the premise run's 13 sends and its charge,
        // each sample at the larger of its reported and estimated input.
        requestBudget: 24 - 13,
        inputTokenBudget: 600_000 - 78_193,
      });
      expect(plan.ledger).toEqual({
        observations: 1,
        reservations: 0,
        requests: 13,
        inputTokens: 78_193,
      });
      // Stopping at the plan reserved nothing and released the lock.
      expect(readdirSync(directory)).toEqual([PREMISE_FILE]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("is not checked, and sends nothing, without a ledger that holds the premise run", async () => {
    const replay = route(faithful, "K");
    vi.stubGlobal("fetch", replay.fetch);
    const directory = mkdtempSync(join(tmpdir(), "docsfab-answer-record-ledger-"));
    try {
      for (const observationDirectory of [directory, join(directory, "absent")]) {
        const { verdict } = await recordAnswerRecordProbe(SUPER, {
          corpusPath: CORPUS_PATH,
          selection: "small-groups",
          observationDirectory,
        });
        expect(verdict).toMatchObject({
          decision: "not-checked",
          code: "answer-record-ledger-invalid",
        });
        expect(verdict.decision === "not-checked" && verdict.reason).toContain(
          ANSWER_RECORD_PREMISE_EVIDENCE_SHA256,
        );
      }
      // An edited observation no longer matches its name and is refused, not counted.
      const premise = readFileSync(join(OBSERVATIONS_PATH, PREMISE_FILE), "utf8");
      writeFileSync(
        join(directory, PREMISE_FILE),
        premise.replace('"elapsedMs":1698', '"elapsedMs":1699'),
      );
      const { verdict: edited } = await recordAnswerRecordProbe(SUPER, {
        corpusPath: CORPUS_PATH,
        selection: "small-groups",
        observationDirectory: directory,
      });
      expect(edited.decision === "not-checked" && edited.reason).toContain(
        "does not match its SHA-256",
      );
      expect(replay.requests).toHaveLength(0);
      // Each refusal released its lock and kept nothing.
      expect(readdirSync(directory).sort()).toEqual(["absent", PREMISE_FILE].sort());
      expect(readdirSync(join(directory, "absent"))).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("gives a second small-group run only what the first left, and refuses with a code when it is too little", async () => {
    const directory = ledgerDirectory();
    try {
      const first = route(faithful, "K");
      vi.stubGlobal("fetch", first.fetch);
      const { verdict, observationPath } = await recordAnswerRecordProbe(SUPER, {
        corpusPath: CORPUS_PATH,
        selection: "small-groups",
        observationDirectory: directory,
      });
      if (verdict.decision === "not-checked") throw new Error(verdict.reason);
      expect(first.requests).toHaveLength(6);
      // A finished run leaves its observation, named by its evidenceSha256, and no reservation.
      expect(observationPath).toBe(join(directory, `${verdict.evidenceSha256}.json`));
      expect(readdirSync(directory).sort()).toEqual(
        [PREMISE_FILE, `${verdict.evidenceSha256}.json`].sort(),
      );
      const second = await planOf(directory);
      if ("decision" in second) throw new Error(second.reason);
      expect(second.ledger).toEqual({
        observations: 2,
        reservations: 0,
        requests: 19,
        inputTokens: 78_193 + chargedBy(verdict.observation.samples),
      });
      expect(second.requestBudget).toBe(5);
      expect(second.inputTokenBudget).toBe(521_807 - chargedBy(verdict.observation.samples));

      const again = route(faithful, "K");
      vi.stubGlobal("fetch", again.fetch);
      await expect(
        recordAnswerRecordProbe(SUPER, {
          corpusPath: CORPUS_PATH,
          selection: "small-groups",
          observationDirectory: directory,
        }),
      ).rejects.toMatchObject({
        code: "endpoint-probe-answer-record-group-request-budget",
        configured: 5,
        observed: 6,
        message: expect.stringContaining("never remove a retained observation"),
      });
      expect(again.requests).toHaveLength(0);
      // A refusal before the first request reserves nothing.
      expect(readdirSync(directory)).toHaveLength(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("counts re-sends as requests: two re-sends leave 21 recorded and 3 to spend", async () => {
    const directory = ledgerDirectory();
    try {
      const first = route(
        (request, nth) => (nth === 0 || nth === 2 ? connectionReset() : faithful(request)),
        "K",
      );
      vi.stubGlobal("fetch", first.fetch);
      const { verdict } = await recordAnswerRecordProbe(SUPER, {
        corpusPath: CORPUS_PATH,
        selection: "small-groups",
        observationDirectory: directory,
      });
      if (verdict.decision === "not-checked") throw new Error(verdict.reason);
      expect(verdict.measurement.remainderResends).toBe(2);
      expect(first.requests).toHaveLength(8);
      const second = await planOf(directory);
      if ("decision" in second) throw new Error(second.reason);
      expect(second.ledger).toMatchObject({ requests: 13 + 8, reservations: 0 });
      expect(second.requestBudget).toBe(3);
      expect(second.inputTokenBudget).toBe(521_807 - chargedBy(verdict.observation.samples));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reserves everything the ledger has left before the first request and keeps it charged when the run is interrupted", async () => {
    const directory = ledgerDirectory();
    try {
      let reservedBeforeFirst: string[] = [];
      let sent = 0;
      vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
        sent += 1;
        if (sent === 1) {
          reservedBeforeFirst = readdirSync(directory).filter(
            (name) => name !== PREMISE_FILE && name.endsWith(".json"),
          );
          return faithful(classify(JSON.parse(String(init?.body)) as Record<string, any>, "K"));
        }
        // The run stops mid-plan, as a refused proxy or a killed process would leave it.
        throw new OutboundProxyRefusal("unreachable", "The proxy refused the connection.");
      });
      await expect(
        recordAnswerRecordProbe(SUPER, {
          corpusPath: CORPUS_PATH,
          selection: "small-groups",
          observationDirectory: directory,
        }),
      ).rejects.toMatchObject({ code: "outbound-proxy-unreachable" });
      expect(sent).toBe(2);
      expect(reservedBeforeFirst).toHaveLength(1);
      // The reservation stays and the lock is released.
      const left = readdirSync(directory).filter((name) => name !== PREMISE_FILE);
      expect(left).toEqual(reservedBeforeFirst);
      const reservation = JSON.parse(readFileSync(join(directory, left[0]!), "utf8")) as Record<
        string,
        unknown
      >;
      // The whole remainder, which is what the run's own gates cap it at.
      expect({
        kind: reservation.kind,
        requests: reservation.requests,
        inputTokens: reservation.inputTokens,
      }).toEqual({
        kind: ANSWER_RECORD_RESERVATION_KIND,
        requests: 24 - 13,
        inputTokens: 600_000 - 78_193,
      });
      const next = await planOf(directory);
      if ("decision" in next) throw new Error(next.reason);
      expect(next.ledger).toEqual({
        observations: 2,
        reservations: 1,
        requests: 24,
        inputTokens: 600_000,
      });
      expect(next.requestBudget).toBe(0);
      expect(next.inputTokenBudget).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("writes the observation before it removes the reservation, so a failed write leaves the run charged", async () => {
    const directory = ledgerDirectory();
    try {
      vi.stubGlobal("fetch", route(faithful, "K").fetch);
      const lock = join(directory, ANSWER_RECORD_LEDGER_LOCK);
      let lockedAtObservation: boolean | undefined;
      const files: AnswerRecordProbeFiles = {
        writeFile: (async (path: unknown, text: unknown, options: unknown) => {
          if (
            typeof text === "string" &&
            path !== lock &&
            (JSON.parse(text) as { kind?: unknown }).kind === "docsfab-answer-record-probe"
          ) {
            // The lock is still held when the observation is written.
            lockedAtObservation = existsSync(lock);
            throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
          }
          return writeFilePromise(path as string, text as string, options as never);
        }) as AnswerRecordProbeFiles["writeFile"],
        rm: rmPromise,
      };
      await expect(
        recordAnswerRecordProbe(SUPER, {
          corpusPath: CORPUS_PATH,
          selection: "small-groups",
          observationDirectory: directory,
          files,
        }),
      ).rejects.toMatchObject({ code: "ENOSPC" });
      expect(lockedAtObservation).toBe(true);
      const left = readdirSync(directory).filter((name) => name !== PREMISE_FILE);
      expect(left).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(directory, left[0]!), "utf8"))).toMatchObject({
        kind: ANSWER_RECORD_RESERVATION_KIND,
        requests: 11,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("takes the lock before it reads the ledger: a run waiting on the lock gets only what the holder left", async () => {
    const directory = ledgerDirectory();
    try {
      const replay = route(faithful, "K");
      vi.stubGlobal("fetch", replay.fetch);
      const lock = join(directory, ANSWER_RECORD_LEDGER_LOCK);
      let reachLock!: () => void;
      const reachedLock = new Promise<void>((resolve) => {
        reachLock = resolve;
      });
      let openGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      // Run B stops at its lock write until run A has finished.
      const waiting: AnswerRecordProbeFiles = {
        writeFile: (async (path: unknown, text: unknown, options: unknown) => {
          if (path === lock) {
            reachLock();
            await gate;
          }
          return writeFilePromise(path as string, text as string, options as never);
        }) as AnswerRecordProbeFiles["writeFile"],
        rm: rmPromise,
      };
      const runB = recordAnswerRecordProbe(SUPER, {
        corpusPath: CORPUS_PATH,
        selection: "small-groups",
        observationDirectory: directory,
        files: waiting,
      });
      await reachedLock;
      const runA = await recordAnswerRecordProbe(SUPER, {
        corpusPath: CORPUS_PATH,
        selection: "small-groups",
        observationDirectory: directory,
      });
      expect(runA.verdict.decision).toBe("measured");
      openGate();
      await expect(runB).rejects.toMatchObject({
        code: "endpoint-probe-answer-record-group-request-budget",
        configured: 5,
        observed: 6,
      });
      // 6 small-group requests in all, within the 11 the approval had left.
      expect(replay.requests).toHaveLength(6);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps the run's result when the lock cannot be removed, and shows the failure as a coded warning", async () => {
    const directory = ledgerDirectory();
    try {
      vi.stubGlobal("fetch", route(faithful, "K").fetch);
      const lock = join(directory, ANSWER_RECORD_LEDGER_LOCK);
      const stuck: AnswerRecordProbeFiles = {
        writeFile: writeFilePromise,
        rm: (async (path: unknown, options: unknown) => {
          if (path === lock) {
            throw Object.assign(new Error("permission denied"), { code: "EACCES" });
          }
          return rmPromise(path as string, options as never);
        }) as AnswerRecordProbeFiles["rm"],
      };
      const result = await recordAnswerRecordProbe(SUPER, {
        corpusPath: CORPUS_PATH,
        selection: "small-groups",
        observationDirectory: directory,
        files: stuck,
      });
      expect(result.verdict.decision).toBe("measured");
      expect(result.observationPath).toBeDefined();
      expect(result.warnings).toEqual([
        {
          code: "answer-record-ledger-lock-not-released",
          message: expect.stringContaining(lock),
        },
      ]);
      expect(
        formatAnswerRecordProbe(result.verdict, result.observationPath, result.warnings).join("\n"),
      ).toContain("Warning (answer-record-ledger-lock-not-released)");
      expect(
        answerRecordProbeResult(result.verdict, result.observationPath, result.warnings),
      ).toMatchObject({ warnings: [{ code: "answer-record-ledger-lock-not-released" }] });
      rmSync(lock);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    const failing = ledgerDirectory();
    try {
      const lock = join(failing, ANSWER_RECORD_LEDGER_LOCK);
      const stuck: AnswerRecordProbeFiles = {
        writeFile: writeFilePromise,
        rm: (async (path: unknown, options: unknown) => {
          if (path === lock) {
            throw Object.assign(new Error("permission denied"), { code: "EACCES" });
          }
          return rmPromise(path as string, options as never);
        }) as AnswerRecordProbeFiles["rm"],
      };
      // A run that fails keeps its own error, and the lock failure is added to it.
      vi.stubGlobal("fetch", async () => {
        throw new OutboundProxyRefusal("unreachable", "The proxy refused the connection.");
      });
      await expect(
        recordAnswerRecordProbe(SUPER, {
          corpusPath: CORPUS_PATH,
          selection: "small-groups",
          observationDirectory: failing,
          files: stuck,
        }),
      ).rejects.toMatchObject({
        code: "outbound-proxy-unreachable",
        message: expect.stringContaining("answer-record-ledger-lock-not-released"),
      });
      // A thrown value that is not an Error is wrapped, so the warning is never dropped.
      rmSync(lock);
      const thrown = "stopped by the operator";
      const wrapped = await recordAnswerRecordProbe(SUPER, {
        corpusPath: CORPUS_PATH,
        selection: "small-groups",
        observationDirectory: failing,
        files: stuck,
        onPlan: () => {
          throw thrown;
        },
      }).catch((error: unknown) => error);
      expect(wrapped).toBeInstanceOf(Error);
      expect(wrapped).toMatchObject({
        cause: thrown,
        message: expect.stringContaining("answer-record-ledger-lock-not-released"),
      });
    } finally {
      rmSync(failing, { recursive: true, force: true });
    }
  });

  it("refuses with a code while another run holds the ledger lock, and never breaks it", async () => {
    const directory = ledgerDirectory();
    try {
      const replay = route(faithful, "K");
      vi.stubGlobal("fetch", replay.fetch);
      const lock = join(directory, ANSWER_RECORD_LEDGER_LOCK);
      writeFileSync(lock, '{"pid":1}\n');
      for (const selection of ["small-groups", "premise", "typed"] as const) {
        const { verdict } = await recordAnswerRecordProbe(SUPER, {
          corpusPath: CORPUS_PATH,
          selection,
          observationDirectory: directory,
        });
        expect(verdict).toMatchObject({
          decision: "not-checked",
          code: "answer-record-ledger-locked",
        });
        expect(verdict.decision === "not-checked" && verdict.reason).toContain(lock);
        expect(formatAnswerRecordProbe(verdict).join("\n")).toContain(
          "not checked (answer-record-ledger-locked)",
        );
      }
      expect(replay.requests).toHaveLength(0);
      expect(readFileSync(lock, "utf8")).toBe('{"pid":1}\n');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("holds the lock for the whole run: a run started while another is sending is refused", async () => {
    const directory = ledgerDirectory();
    try {
      let inner: Awaited<ReturnType<typeof recordAnswerRecordProbe>> | undefined;
      let started = false;
      const replay = route(async (request) => {
        if (!started) {
          started = true;
          inner = await recordAnswerRecordProbe(SUPER, {
            corpusPath: CORPUS_PATH,
            selection: "typed",
            observationDirectory: directory,
          });
        }
        return faithful(request);
      }, "K");
      vi.stubGlobal("fetch", replay.fetch);
      const { verdict } = await recordAnswerRecordProbe(SUPER, {
        corpusPath: CORPUS_PATH,
        selection: "small-groups",
        observationDirectory: directory,
      });
      expect(verdict.decision).toBe("measured");
      expect(inner?.verdict).toMatchObject({ code: "answer-record-ledger-locked" });
      expect(replay.requests).toHaveLength(6);
      expect(readdirSync(directory)).not.toContain(ANSWER_RECORD_LEDGER_LOCK);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("charges typed tokens to the combined cap without charging the untyped request tranche", async () => {
    const directory = ledgerDirectory();
    const keepFile = (value: unknown): string => {
      const text = canonicalJson(value as never);
      const name = `${createHash("sha256").update(text).digest("hex")}.json`;
      writeFileSync(join(directory, name), text);
      return name;
    };
    const samples = [{ estimatedInputTokens: 60_000, promptTokens: 61_000 }];
    try {
      keepFile({
        schemaVersion: 2,
        kind: "docsfab-answer-record-probe",
        shell: "typed",
        selection: "typed",
        samples,
        measurement: { transportRetriesUsed: 0 },
      });
      const built = await planOf(directory);
      if ("decision" in built) throw new Error(built.reason);
      expect(built.ledger).toEqual({
        observations: 2,
        reservations: 0,
        requests: 13,
        inputTokens: 78_193 + 61_000,
      });
      // Any unknown shell/selection pair is refused rather than skipped.
      for (const labels of [
        {},
        { shell: "UNTYPED" },
        { shell: "other" },
        { shell: "typed", selection: "small-groups" },
      ]) {
        const name = keepFile({
          schemaVersion: 2,
          kind: "docsfab-answer-record-probe",
          ...labels,
          samples,
        });
        const refused = await planOf(directory);
        expect(refused, JSON.stringify(labels)).toMatchObject({
          decision: "not-checked",
          code: "answer-record-ledger-invalid",
        });
        rmSync(join(directory, name));
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("is not checked, not a crash, when a directory entry named *.json is not a file", async () => {
    const directory = ledgerDirectory();
    try {
      mkdirSync(join(directory, "nested.json"));
      const replay = route(faithful, "K");
      vi.stubGlobal("fetch", replay.fetch);
      const { verdict } = await recordAnswerRecordProbe(SUPER, {
        corpusPath: CORPUS_PATH,
        selection: "small-groups",
        observationDirectory: directory,
      });
      expect(verdict).toMatchObject({
        decision: "not-checked",
        code: "answer-record-ledger-invalid",
      });
      expect(verdict.decision === "not-checked" && verdict.reason).toContain(
        "nested.json in the observation directory is not a file",
      );
      expect(replay.requests).toHaveLength(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("sends only phase K through the bound policy with --answer-record-small-groups", async () => {
    const replay = route(faithful, "K");
    vi.stubGlobal("fetch", replay.fetch);
    const shown: string[] = [];
    const directory = ledgerDirectory();
    const { verdict } = await recordAnswerRecordProbe(SUPER, {
      corpusPath: CORPUS_PATH,
      selection: "small-groups",
      observationDirectory: directory,
      onPlan: (plan) => shown.push(formatAnswerRecordProbePlan(plan)),
    }).finally(() => rmSync(directory, { recursive: true, force: true }));
    expect(verdict.decision).toBe("measured");
    expect(replay.requests).toHaveLength(6);
    expect(shown[0]).toContain(
      "within what the approval has left after 1 recorded run(s) spent 13 requests and 78193 input tokens: 11 requests and 521807 input tokens",
    );
    for (const request of replay.requests) {
      expect(request.body).toMatchObject({
        temperature: 0,
        tool_choice: "required",
        max_tokens: 8192,
      });
    }
    expect(answerRecordProbeResult(verdict, "/state/probe.json")).toMatchObject({
      decision: "measured",
      measurement: { groups: [{ recordsPerMessage: 2 }, { recordsPerMessage: 3 }] },
    });
  });

  it("sends every request with the bound request policy and is GO on a faithful route", async () => {
    const replay = route(faithful);
    vi.stubGlobal("fetch", replay.fetch);
    const shown: string[] = [];

    const verdict = await probeConfiguredAnswerRecords(SUPER, {
      corpusPath: CORPUS_PATH,
      onPlan: (plan) => shown.push(formatAnswerRecordProbePlan(plan)),
    });
    const binding = await resolveOperatorExecutionBinding({ model: SUPER });

    expect(verdict.decision).toBe("go");
    expect(binding.bound).toBeDefined();
    expect(verdict.observation.deploymentBinding).toEqual({
      status: "bound",
      routeId: binding.bound!.composition.deployment.routeId,
      deploymentIdentitySha256: binding.bound!.composition.deployment.identitySha256,
      transport: binding.bound!.composition.deployment.transport,
    });
    expect(shown[0]).toContain("9 phase B prompts × P=60588");
    expect(shown[0]).toContain("of 600000 approved");
    for (const request of replay.requests) {
      expect(request.body).toMatchObject({
        model: SUPER.modelId,
        max_tokens: 8192,
        temperature: 0,
        top_p: 1,
        chat_template_kwargs: { thinking: false },
        tool_choice: "required",
      });
    }
    const lines = formatAnswerRecordProbe(verdict, "/state/probe.json").join("\n");
    expect(lines).toContain("Answer record probe: GO (24 requests");
    expect(lines).toContain("maxRecordBytes 8192 B (GO needs 4085 B)");
    expect(lines).toContain(`Corpus: sha256 ${ANSWER_RECORD_CORPUS_SHA256}`);
    // The projections read the composition's turn ceiling.
    if (verdict.decision === "not-checked") throw new Error(verdict.reason);
    expect(verdict.measurement.projections[0]).toMatchObject({ maxProviderTurns: 128 });
  });

  it("records unavailable identity for unmatched BYO without inventing a deployment hash", async () => {
    const replay = route(faithful);
    vi.stubGlobal("fetch", replay.fetch);

    const verdict = await probeConfiguredAnswerRecords(validModelConfig, {
      corpusPath: CORPUS_PATH,
    });

    expect(verdict.decision).toBe("go");
    expect(verdict.observation.deploymentBinding).toEqual({
      status: "unavailable",
      reason: "unmatched-byo",
    });
    expect(JSON.stringify(verdict.observation)).not.toContain(validModelConfig.baseUrl);
    expect(JSON.stringify(verdict.observation)).not.toContain("test-secret");
    expect(replay.requests.length).toBeGreaterThan(0);
  });

  it("sends the record probe with the key for an endpoint from secrets.env", async () => {
    const replay = route(faithful);
    vi.stubGlobal("fetch", replay.fetch);

    const verdict = await probeConfiguredAnswerRecords(
      { ...validModelConfig, endpointSource: "secrets-env" },
      { corpusPath: CORPUS_PATH },
    );

    expect(verdict.decision).toBe("go");
    expect(replay.requests.length).toBeGreaterThan(0);
  });

  it("stops before any record request for an endpoint taken from repository files", async () => {
    const replay = route(faithful);
    vi.stubGlobal("fetch", replay.fetch);

    await expect(
      probeConfiguredAnswerRecords(
        { ...validModelConfig, endpointSource: "untrusted:repository" },
        { corpusPath: CORPUS_PATH },
      ),
    ).rejects.toMatchObject({ code: "credential-endpoint-untrusted" });
    expect(replay.requests).toEqual([]);
  });

  it("pins the committed corpus and sends nothing for any other (NB10)", async () => {
    expect(createHash("sha256").update(CORPUS_TEXT).digest("hex")).toBe(
      ANSWER_RECORD_CORPUS_SHA256,
    );
    const replay = route(faithful);
    vi.stubGlobal("fetch", replay.fetch);
    const directory = mkdtempSync(join(tmpdir(), "docsfab-answer-record-corpus-"));
    try {
      const substitute = join(directory, "corpus.json");
      writeFileSync(
        substitute,
        CORPUS_TEXT.replace('"targetTokens": 60588', '"targetTokens": 60587'),
      );
      const verdict = await probeConfiguredAnswerRecords(SUPER, { corpusPath: substitute });
      expect(verdict).toMatchObject({ decision: "not-checked" });
      expect(verdict.decision === "not-checked" && verdict.reason).toContain(
        ANSWER_RECORD_CORPUS_SHA256,
      );
      expect(replay.requests).toHaveLength(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("is not checked, and spends nothing, without the corpus", async () => {
    const replay = route(faithful);
    vi.stubGlobal("fetch", replay.fetch);
    const verdict = await probeConfiguredAnswerRecords(SUPER, {
      corpusPath: "/nonexistent/corpus.json",
    });
    expect(verdict.decision).toBe("not-checked");
    expect(replay.requests).toHaveLength(0);
    expect(answerRecordProbeExitCode(verdict)).toBe(1);
  });
});
