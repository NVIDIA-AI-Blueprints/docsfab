// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * What the attempt record says about the tool-call answer path (#1707): the
 * in-flight states a deadline leaves (design D1), the turn_end branches that
 * end an attempt before admission, the text-final record, the host invariant,
 * the advisory tool's raw decode, and compaction before the report turn.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { OUTPUT_HOST_TEXT } from "../src/contracts/model-output.generated.js";
import { QUALITY_CANDIDATE_VALIDATION_TOOL_NAME } from "../src/harness/pi-tool-confine.js";
import {
  captureInferenceFailure,
  createRepository,
  resetSharedTestState,
  sseResponse,
  textTurn,
  validModelConfig,
} from "./support/pi-harness-session-fixtures.js";
import {
  FIXTURE_REPORT,
  SUBMIT,
  qualityStepInput,
  rawToolCallTurn,
  recordingProvider,
  submissionCall,
  toolPathHarness,
  toolResults,
  userText,
} from "./support/answer-submission-fixtures.js";

afterEach(resetSharedTestState);

const SESSION = 60_000;

const SUBMISSION = JSON.stringify({
  evaluation: { evaluation_id: "eval-1", overall_decision: "insufficient-evidence" },
  qualityScore: null,
});

const event = (delta: Record<string, unknown>) => ({
  id: "completion-stalled",
  object: "chat.completion.chunk",
  created: 1,
  model: validModelConfig.modelId,
  choices: [{ index: 0, delta, finish_reason: null }],
});

/**
 * A provider whose response at `stallAt` streams `events` and then stalls
 * until the request is aborted; the others answer from `responses`.
 * `onDrained` runs once the reader has taken every event and asks for more.
 */
function stallingProvider(
  responses: readonly Response[],
  stallAt: number,
  events: readonly object[],
  onDrained?: () => void,
): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    const index = bodies.length - 1;
    if (index !== stallAt) {
      const response = responses[index];
      if (!response) throw new Error("Unexpected provider request.");
      return response.clone();
    }
    const encoder = new TextEncoder();
    const signal = init?.signal;
    let drained = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const item of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(item)}\n\n`));
        }
        const fail = () => controller.error(signal?.reason ?? new Error("aborted"));
        if (signal?.aborted) fail();
        else signal?.addEventListener("abort", fail, { once: true });
      },
      // Called only when the queue is empty and the reader wants more: every
      // event above has been read.
      pull() {
        if (drained) return;
        drained = true;
        onDrained?.();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  return bodies;
}

/** A short attempt timer, so the stalled stream ends at the host's own deadline. */
const DEADLINE_MS = 1_500;

/**
 * Cancel the step once the stalled stream's events have been read and handled.
 * No wall-clock timer: the stream's own pull starts the abort, and two
 * macrotask hops let the host finish handling the last event first, so the
 * order does not depend on machine load.
 */
function abortWhenDrained(): { readonly signal: AbortSignal; readonly onDrained: () => void } {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    onDrained: () => setImmediate(() => setImmediate(() => controller.abort())),
  };
}

/**
 * The attempt ended while the stream was still arriving. The capture reads
 * the stream as Pi receives it, so these cases run on a lane whose transport
 * hands Pi each event as it arrives: the unmatched operator endpoint, ended by
 * cancellation. On a composition route the transport reads the whole response
 * before Pi sees any part, in `validateProviderResponseModel`, so an aborted
 * response there reaches neither Pi nor this capture, and a submission it was
 * carrying reads as absent.
 */
describe("in-flight states when the attempt ends mid-stream (D1)", () => {
  it(
    "records a submission whose arguments were streaming as in-flight, with the bytes captured",
    async () => {
      const repositoryPath = await createRepository();
      const input = await qualityStepInput(repositoryPath);
      const parts = ['{"evaluation":{"evaluation_id":', '"eval-1","overall_'];
      const cancel = abortWhenDrained();
      stallingProvider(
        [],
        0,
        [
          event({
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "submit-1",
                type: "function",
                function: { name: SUBMIT, arguments: parts[0] },
              },
            ],
          }),
          event({ tool_calls: [{ index: 0, function: { arguments: parts[1] } }] }),
        ],
        cancel.onDrained,
      );

      const error = await captureInferenceFailure(toolPathHarness({ composition: false }), {
        ...input,
        signal: cancel.signal,
      });

      expect(error.evidence?.answerSubmission).toEqual({
        path: "tool-call",
        reason: "recorded-route",
        submission: "in-flight",
        reportTurn: "not-asked",
        submissionInFlightBytes: Buffer.byteLength(parts.join(""), "utf8"),
      });
    },
    SESSION,
  );

  it(
    "records a report being written as in-flight, with the bytes captured",
    async () => {
      const repositoryPath = await createRepository();
      const input = await qualityStepInput(repositoryPath);
      const partial = "# Documentation quality evaluation report\n\nPartial";
      const cancel = abortWhenDrained();
      stallingProvider(
        [rawToolCallTurn([submissionCall("submit-1", SUBMISSION)])],
        1,
        [event({ role: "assistant", content: partial })],
        cancel.onDrained,
      );

      const error = await captureInferenceFailure(toolPathHarness({ composition: false }), {
        ...input,
        signal: cancel.signal,
      });

      expect(error.evidence?.answerSubmission).toEqual({
        path: "tool-call",
        reason: "recorded-route",
        submission: "admitted",
        reportTurn: "in-flight",
        reportInFlightBytes: Buffer.byteLength(partial, "utf8"),
        memberEncoding: { evaluation: "object", qualityScore: "null" },
      });
    },
    SESSION,
  );

  it(
    "records a stream that ended during a reading turn as an absent submission",
    async () => {
      const repositoryPath = await createRepository();
      const input = await qualityStepInput(repositoryPath);
      const cancel = abortWhenDrained();
      stallingProvider(
        [],
        0,
        [
          event({
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "read-1",
                type: "function",
                function: { name: "read", arguments: '{"path":' },
              },
            ],
          }),
        ],
        cancel.onDrained,
      );

      const error = await captureInferenceFailure(toolPathHarness({ composition: false }), {
        ...input,
        signal: cancel.signal,
      });

      expect(error.evidence?.answerSubmission).toEqual({
        path: "tool-call",
        reason: "recorded-route",
        submission: "absent",
        reportTurn: "not-asked",
      });
    },
    SESSION,
  );

  it(
    "records a report turn the attempt deadline ended on a composition route as in-flight",
    async () => {
      const repositoryPath = await createRepository();
      const input = await qualityStepInput(repositoryPath);
      stallingProvider([rawToolCallTurn([submissionCall("submit-1", SUBMISSION)])], 1, [
        event({ role: "assistant", content: "# Report\n\nPartial" }),
      ]);

      const error = await captureInferenceFailure(
        toolPathHarness({ timeoutMs: DEADLINE_MS }),
        input,
      );

      expect(error.condition).toBe("attempt-deadline");
      expect(error.evidence?.answerSubmission).toMatchObject({
        submission: "admitted",
        reportTurn: "in-flight",
      });
    },
    SESSION,
  );
});

describe("turn_end branches that end the attempt before admission", () => {
  it(
    "keeps a host authorization denial's own error and never decodes the submission",
    async () => {
      const repositoryPath = await createRepository();
      const input = await qualityStepInput(repositoryPath);
      recordingProvider([
        rawToolCallTurn([
          { id: "ls-1", name: "ls", chunks: ['{"path":"."}'] },
          submissionCall("submit-1", SUBMISSION),
        ]),
      ]);

      const error = await captureInferenceFailure(
        toolPathHarness({
          beforeToolCall: async (context) =>
            context.toolCall.name === "ls" ? { block: true, reason: "host policy" } : undefined,
        }),
        input,
      );

      expect(error.message).toContain("host authorization denial");
      expect(error.rejection?.code ?? "").not.toMatch(/^quality-submission-/u);
      expect(error.evidence?.answerSubmission).toMatchObject({ submission: "absent" });
    },
    SESSION,
  );

  it(
    "keeps a host preflight failure's own error and never decodes the submission",
    async () => {
      const repositoryPath = await createRepository();
      const input = await qualityStepInput(repositoryPath);
      recordingProvider([
        rawToolCallTurn([
          { id: "ls-1", name: "ls", chunks: ['{"path":"."}'] },
          submissionCall("submit-1", '{"evaluation":"broken","qualityScore":null}'),
        ]),
      ]);

      const error = await captureInferenceFailure(
        toolPathHarness({
          beforeToolCall: async (context) => {
            if (context.toolCall.name === "ls") throw new Error("host preflight exploded");
            return undefined;
          },
        }),
        input,
      );

      expect(error.message).toContain("host preflight exploded");
      expect(error.rejection?.code ?? "").not.toMatch(/^quality-submission-/u);
      expect(error.evidence?.answerSubmission).toMatchObject({ submission: "absent" });
    },
    SESSION,
  );

  it(
    "keeps a failed provider turn's own error and leaves the submission in flight",
    async () => {
      const repositoryPath = await createRepository();
      const input = await qualityStepInput(repositoryPath);
      recordingProvider([
        sseResponse([
          event({
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "submit-1",
                type: "function",
                function: { name: SUBMIT, arguments: '{"evaluation":"broken"' },
              },
            ],
          }),
          { error: { message: "upstream failed mid-stream", type: "server_error", code: 500 } },
        ]),
      ]);

      const error = await captureInferenceFailure(toolPathHarness(), input);

      expect(error.rejection?.code ?? "").not.toMatch(/^quality-submission-/u);
      expect(error.evidence?.answerSubmission).toMatchObject({ submission: "in-flight" });
    },
    SESSION,
  );
});

describe("the answer path record and the host invariant", () => {
  it(
    "records the text answer path and its reason, and offers no submission tool",
    async () => {
      const repositoryPath = await createRepository();
      const input = await qualityStepInput(repositoryPath, {
        path: "text-final",
        reason: "operator-override",
      });
      const bodies = recordingProvider([textTurn(`${SUBMISSION}\n\n${FIXTURE_REPORT}`)]);

      const result = await toolPathHarness().runStep(input);

      expect(result.answerSubmission).toEqual({
        path: "text-final",
        reason: "operator-override",
        submission: "absent",
        reportTurn: "not-asked",
      });
      const tools = (bodies[0]!.tools as Array<{ function: { name: string } }>).map(
        (tool) => tool.function.name,
      );
      expect(tools).not.toContain(SUBMIT);
      expect(userText(bodies[0]!)).toContain(
        "Start the response with exactly one JSON object, with no Markdown fence and no text before it",
      );
      expect(userText(bodies[0]!)).not.toContain(
        OUTPUT_HOST_TEXT["quality-submission-contract-call"],
      );
    },
    SESSION,
  );

  it(
    "states the submission contract and offers the tool on the tool-call path",
    async () => {
      const repositoryPath = await createRepository();
      const input = await qualityStepInput(repositoryPath);
      const bodies = recordingProvider([
        rawToolCallTurn([submissionCall("submit-1", SUBMISSION)]),
        textTurn(FIXTURE_REPORT),
      ]);

      const result = await toolPathHarness().runStep(input);

      const prompt = userText(bodies[0]!);
      expect(prompt).toContain(OUTPUT_HOST_TEXT["quality-submission-contract-call"]);
      expect(prompt).toContain(OUTPUT_HOST_TEXT["quality-submission-contract-validate"]);
      expect(prompt).not.toContain("Start the response with exactly one JSON object");
      expect(result.tools?.presented).toContain(SUBMIT);
    },
    SESSION,
  );

  it(
    "refuses a tool-call step input on a harness whose route recorded no answer submission",
    async () => {
      const repositoryPath = await createRepository();
      const input = await qualityStepInput(repositoryPath);
      const bodies = recordingProvider([]);

      await expect(toolPathHarness({ capability: null }).runStep(input)).rejects.toThrow(
        /records no answer submission/u,
      );
      expect(bodies).toHaveLength(0);
    },
    SESSION,
  );
});

describe("the advisory tool on the tool-call path", () => {
  it(
    "takes the submission's own arguments and decodes them from their raw text",
    async () => {
      const repositoryPath = await createRepository();
      const input = await qualityStepInput(repositoryPath);
      const duplicate =
        '{"evaluation":{"findings":[],"limitations":[],"findings":[]},"qualityScore":null}';
      const clean = '{"evaluation":{"findings":[],"limitations":[]},"qualityScore":null}';
      const bodies = recordingProvider([
        rawToolCallTurn([
          { id: "check-1", name: QUALITY_CANDIDATE_VALIDATION_TOOL_NAME, chunks: [duplicate] },
          { id: "check-2", name: QUALITY_CANDIDATE_VALIDATION_TOOL_NAME, chunks: [clean] },
        ]),
        rawToolCallTurn([submissionCall("submit-1", SUBMISSION)], { created: 2 }),
        textTurn(FIXTURE_REPORT),
      ]);

      await toolPathHarness().runStep(input);

      const tools = bodies[0]!.tools as Array<{ function: { name: string; parameters: unknown } }>;
      const parameters = (name: string) =>
        tools.find((tool) => tool.function.name === name)?.function.parameters;
      expect(parameters(QUALITY_CANDIDATE_VALIDATION_TOOL_NAME)).toEqual(parameters(SUBMIT));
      const results = toolResults(bodies[1]!);
      // Pi's lenient parse drops the duplicate; the host's strict decode refuses it.
      expect(JSON.parse(results.get("check-1")!)).toMatchObject({
        status: "invalid",
        violations: [{ code: "malformed-candidate" }],
      });
      expect(JSON.parse(results.get("check-2")!).violations).not.toContainEqual({
        code: "malformed-candidate",
      });
    },
    SESSION,
  );
});
