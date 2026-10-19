// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The final quality evaluator's answer through a host tool call (#1707,
 * #1138 option B), over the real Pi session with raw-string chunked SSE
 * fixtures: the host decodes the submission from the forwarded argument
 * bytes when the turn settles, asks for the report in a tool-free turn, and
 * assembles the same candidate the text answer produces.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseRetryPolicy } from "../src/config/retry-policy.js";
import { OUTPUT_HOST_TEXT } from "../src/contracts/model-output.generated.js";
import type { HarnessStepInput } from "../src/execution/contracts.js";
import { PI_ANSWER_NOW_TOOL_REFUSAL } from "../src/harness/pi-session.js";
import { decodeQualityArtifactResponse } from "../src/harness/quality-candidate-tool.js";
import { QUALITY_REPORT_CUT_STEM } from "../src/harness/cut-judgment.js";
import { qualityResponseCorrection } from "../src/workflow-execution/quality-response-correction.js";
import { decodeInference } from "../src/scorecard-record-decode.js";
import {
  OUTPUT_AUTHORITY_FLOOR_TOKENS,
  type PiHarness,
  type PiHarnessOptions,
  captureInferenceFailure,
  createRepository,
  executeInferenceStep,
  resetSharedTestState,
  textTurn,
  toolTurn,
  validModelConfig,
} from "./support/pi-harness-session-fixtures.js";
import {
  FIXTURE_REPORT,
  RECORDED_CAPABILITY,
  SUBMIT,
  chunkedTextTurn,
  qualityStepInput,
  rawToolCallTurn,
  recordingProvider,
  submissionCall,
  toolPathHarness,
  toolResults,
  userText,
} from "./support/answer-submission-fixtures.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";
import { CredentialBoundaryError } from "../src/security/credential-isolation.js";
import { classifyThrownFailure } from "../src/operator/failure-classification.js";

afterEach(async () => {
  vi.useRealTimers();
  await resetSharedTestState();
});

const SESSION = 60_000;

const EVALUATION = {
  evaluation_id: "eval-1",
  overall_decision: "insufficient-evidence",
  note: 'a "quoted" value with {braces}, a \\ backslash, and ```fences```',
};
const SUBMISSION = JSON.stringify({ evaluation: EVALUATION, qualityScore: null });

/** A ceiling the tool-call lease reaches in one batch of `maxProviderTurns - 1` calls. */
const MAX_PROVIDER_TURNS = 8;
const CEILING = MAX_PROVIDER_TURNS - 1;

function lsCalls(prefix: string, count: number) {
  return Array.from({ length: count }, (_, offset) => ({
    id: `${prefix}-${offset}`,
    name: "ls",
    chunks: [JSON.stringify({ path: offset === 0 ? "." : `./${String(offset)}` })],
  }));
}

function readCall(id: string, path = "README.md") {
  return { id, name: "read", chunks: [JSON.stringify({ path })] };
}

/** The settled assistant tool calls' arguments as Pi parsed them, per turn. */
function capturePiArguments() {
  const turns: Array<Array<{ name: string; arguments: unknown }>> = [];
  const configureSession: NonNullable<PiHarnessOptions["configureSession"]> = (session) => {
    session.subscribe((event) => {
      if (event.type !== "turn_end" || event.message.role !== "assistant") return;
      const content = (event.message as { content?: unknown[] }).content ?? [];
      turns.push(
        content
          .filter((block) => (block as { type?: string }).type === "toolCall")
          .map((block) => ({
            name: (block as { name: string }).name,
            arguments: (block as { arguments: unknown }).arguments,
          })),
      );
    });
  };
  return { turns, configureSession };
}

function run(harness: PiHarness, input: HarnessStepInput) {
  return executeInferenceStep({
    mode: input.step.mode,
    policy: parseRetryPolicy({}),
    evidenceIdentity: input.evidenceIdentity,
    sleep: async () => {},
    execute: (attempt, responseCorrection) =>
      harness.runStep({
        ...input,
        inferenceAttempt: attempt,
        retriesConsumed: attempt - 1,
        ...(responseCorrection ? { responseCorrection } : {}),
      }),
  });
}

describe("PiHarness answer submitted through the tool call", () => {
  it(
    "admits a raw chunked submission at settlement and stores the report reply with it",
    async () => {
      const repositoryPath = await createRepository();
      const input = await qualityStepInput(repositoryPath);
      const bodies = recordingProvider([
        rawToolCallTurn([submissionCall("submit-1", SUBMISSION, 7)]),
        chunkedTextTurn([FIXTURE_REPORT.slice(0, 40), FIXTURE_REPORT.slice(40)]),
      ]);

      const result = await toolPathHarness().runStep(input);

      expect(bodies).toHaveLength(2);
      // The model candidate matches the text answer; the tool path also retains
      // its host-owned transport correlation.
      expect(result.qualityArtifactCandidate).toEqual({
        ...decodeQualityArtifactResponse(
          `${SUBMISSION}\n\n${FIXTURE_REPORT}`,
          input.qualityProfileSelection!,
        ),
        answerPath: "tool-call",
      });
      expect(result.answerSubmission).toEqual({
        path: "tool-call",
        reason: "recorded-route",
        submission: "admitted",
        reportTurn: "admitted",
        memberEncoding: { evaluation: "object", qualityScore: "null" },
      });
      expect(result.answerBytes).toBe(
        Buffer.byteLength(SUBMISSION, "utf8") + Buffer.byteLength(FIXTURE_REPORT, "utf8"),
      );
      // The model saw the fixed acknowledgement, then the report ask, and the
      // report turn carried tool_choice none with the tools kept.
      expect([...toolResults(bodies[1]!).values()]).toEqual([
        OUTPUT_HOST_TEXT["quality-submission-acknowledgement"],
      ]);
      expect(userText(bodies[1]!)).toContain(OUTPUT_HOST_TEXT["quality-submission-report-ask"]);
      expect(bodies[0]!.tool_choice ?? "auto").toBe("auto");
      expect(bodies[1]!.tool_choice).toBe("none");
      expect((bodies[1]!.tools as unknown[]).length).toBeGreaterThan(0);
      // The submission tool is offered with the untyped shell the route recorded.
      const submitTool = (bodies[0]!.tools as Array<{ function: Record<string, unknown> }>).find(
        (tool) => tool.function.name === SUBMIT,
      );
      expect(submitTool?.function.parameters).toMatchObject({
        type: "object",
        properties: { evaluation: { description: expect.any(String) } },
      });
      expect(
        (submitTool!.function.parameters as { properties: Record<string, object> }).properties
          .evaluation,
      ).not.toHaveProperty("type");
    },
    SESSION,
  );

  it(
    "keeps tool_choice auto on the report turn when the route recorded auto",
    async () => {
      const repositoryPath = await createRepository();
      const input = await qualityStepInput(repositoryPath);
      const bodies = recordingProvider([
        rawToolCallTurn([submissionCall("submit-1", SUBMISSION)]),
        textTurn(FIXTURE_REPORT),
      ]);

      await toolPathHarness({
        capability: { ...RECORDED_CAPABILITY, reportTurnToolChoice: "auto" },
      }).runStep(input);

      expect(bodies[1]!.tool_choice ?? "auto").toBe("auto");
    },
    SESSION,
  );

  describe("raw-decode refusals that Pi's own parse would have passed", () => {
    const cases = [
      {
        name: "a duplicate key split across chunk boundaries",
        chunks: [
          '{"evaluation":{"evaluation_id":"e","evaluation_',
          'id":"f"},"qualityScore":null}',
        ],
        rejection: { code: "quality-submission-duplicate-key", location: "$.evaluation" },
      },
      {
        name: "a raw line break inside a string",
        chunks: ['{"evaluation":{"note":"line one\nline', ' two"},"qualityScore":null}'],
        rejection: { code: "quality-submission-json", location: "$.evaluation" },
      },
      {
        name: "a trailing closing brace",
        chunks: ['{"evaluation":{"a":1},', '"qualityScore":null}}'],
        rejection: { code: "quality-submission-json", location: "$" },
      },
      {
        name: "qualityScore false",
        chunks: ['{"evaluation":{"a":1},"qualityScore":false}'],
        rejection: { code: "quality-submission-shape", location: "$.qualityScore" },
      },
      {
        name: "a double-encoded evaluation",
        chunks: ['{"evaluation":"\\"{\\\\\\"a\\\\\\":1}', '\\"","qualityScore":null}'],
        rejection: { code: "quality-submission-shape", location: "$.evaluation" },
      },
      {
        name: "a reportMarkdown argument",
        chunks: [
          JSON.stringify({ evaluation: { a: 1 }, qualityScore: null, reportMarkdown: "# R" }),
        ],
        rejection: { code: "quality-submission-shape", location: "$" },
      },
    ] as const;

    it.each(cases)(
      "refuses $name",
      async ({ chunks, rejection }) => {
        const repositoryPath = await createRepository();
        const input = await qualityStepInput(repositoryPath);
        const bodies = recordingProvider([
          rawToolCallTurn([{ id: "submit-1", name: SUBMIT, chunks }]),
        ]);
        const pi = capturePiArguments();

        const error = await captureInferenceFailure(
          toolPathHarness({ configureSession: pi.configureSession }),
          input,
        );

        expect(bodies).toHaveLength(1);
        expect(error.rejection).toEqual(rejection);
        expect(error.retryable).toBe(true);
        expect(error.category).toBe("malformed-response");
        expect(error.evidence?.answerSubmission).toEqual({
          path: "tool-call",
          reason: "recorded-route",
          submission: "refused",
          reportTurn: "not-asked",
        });
        // Pi parsed the arguments into an object and ran the tool: its own
        // reading would have passed what the host refused.
        expect(pi.turns[0]?.[0]?.name).toBe(SUBMIT);
        expect(typeof pi.turns[0]?.[0]?.arguments).toBe("object");
        expect(error.evidence?.tools?.byTool).toContainEqual({
          name: SUBMIT,
          calls: 1,
          failures: 0,
        });
        // The refusal retains the raw arguments' shape, not the advisory text.
        expect(error.rejectedReplyShape).toBeDefined();
      },
      SESSION,
    );

    it(
      "names the received keys in the retry repair for a shape refusal at the root",
      async () => {
        const repositoryPath = await createRepository();
        const input = await qualityStepInput(repositoryPath);
        recordingProvider([
          rawToolCallTurn([
            submissionCall(
              "submit-1",
              JSON.stringify({ evaluation: { a: 1 }, qualityScore: null, reportMarkdown: "# R" }),
            ),
          ]),
        ]);

        const error = await captureInferenceFailure(toolPathHarness(), input);

        expect(qualityResponseCorrection(error)).toEqual({
          kind: "quality-key-set",
          missing: [],
          undeclared: ["reportMarkdown"],
          withheldCount: 0,
        });
      },
      SESSION,
    );
  });

  it.each([
    ["an array", "[1,2]"],
    ["a string", '"str"'],
  ])(
    "refuses a submission whose root is %s, which Pi rejects before beforeToolCall, with no re-issue",
    async (_name, raw) => {
      const repositoryPath = await createRepository();
      const input = await qualityStepInput(repositoryPath);
      const bodies = recordingProvider([rawToolCallTurn([submissionCall("submit-1", raw, 2)])]);

      const error = await captureInferenceFailure(toolPathHarness(), input);

      expect(bodies).toHaveLength(1);
      expect(error.rejection).toEqual({ code: "quality-submission-shape", location: "$" });
      expect(error.retryable).toBe(true);
      expect(error.evidence?.answerSubmission).toMatchObject({ submission: "refused" });
      // Pi never ran the call.
      expect(error.evidence?.tools?.byTool.find((tool) => tool.name === SUBMIT)).toBeUndefined();
    },
    SESSION,
  );

  describe("byte bounds", () => {
    it(
      "screens the raw submission text for credentials, even where Pi's own parse drops them",
      async () => {
        const repositoryPath = await createRepository();
        const input = await qualityStepInput(repositoryPath);
        // Pi's lenient parse keeps the last of two duplicate keys, so only the
        // raw text the host captured still carries the first value: one of
        // DocsFab's own configured credentials (#1807). Eight parts keep every
        // streamed chunk under the registry's 16-character pieces, so the
        // transport's whole-response screen cannot see the credential and the
        // screen over the joined raw submission text must.
        const credential = configureCredential(`glpat-${"A1b2C3d4E5f6G7h8J9k0"}`);
        recordingProvider([
          rawToolCallTurn([
            submissionCall(
              "submit-1",
              `{"evaluation":{"note":"${credential}","note":"clean"},"qualityScore":null}`,
              8,
            ),
          ]),
        ]);

        const error = await captureInferenceFailure(toolPathHarness(), input);

        expect(error.message).toMatch(/credential/u);
        expect(error.rejection?.code).not.toBe("quality-submission-duplicate-key");
        expect(JSON.stringify(error.evidence)).not.toContain(credential);
      },
      SESSION,
    );

    it(
      "ends the step with a coded credential-isolation stop when the transport refuses the response",
      async () => {
        const repositoryPath = await createRepository();
        const input = await qualityStepInput(repositoryPath);
        // One part keeps the whole configured credential in one streamed
        // chunk, so the transport's whole-response screen refuses the
        // response before Pi reads it. Pi reports that as a connection error;
        // the step names the refusal instead (#1807).
        const credential = configureCredential(
          ["harbor", plantedCredentialValue(97, 24)].join("-"),
        );
        const bodies = recordingProvider([
          rawToolCallTurn([
            submissionCall(
              "submit-1",
              `{"evaluation":{"note":"${credential}"},"qualityScore":null}`,
              1,
            ),
          ]),
        ]);

        const error = await captureInferenceFailure(toolPathHarness(), input);

        const refusal = new CredentialBoundaryError("model-response");
        expect(error.message).toBe(
          `Model request failed [provider-terminal; retryable=false]: ${refusal.message}`,
        );
        expect(error.message).not.toContain("Connection error");
        expect(error.retryable).toBe(false);
        expect(error.cause).toBeInstanceOf(CredentialBoundaryError);
        expect((error.cause as CredentialBoundaryError).boundary).toBe("model-response");
        expect((error.cause as CredentialBoundaryError).nextAction).toContain(
          "DOCSFAB_TEST_CONFIGURED_",
        );
        expect(Object.getOwnPropertyDescriptor(error, "cause")?.enumerable).toBe(false);
        expect(classifyThrownFailure(error, "workflow")).toEqual({
          class: "operator-input",
          layer: "workflow",
          code: "credential-isolation-boundary",
        });
        // One request, never replayed, and the value is in no evidence.
        expect(bodies).toHaveLength(1);
        expect(JSON.stringify({ error, evidence: error.evidence })).not.toContain(credential);
      },
      SESSION,
    );

    it(
      "refuses a cut report whose prefix and the submission pass the bound, before asking to continue",
      async () => {
        const repositoryPath = await createRepository();
        const input = await qualityStepInput(repositoryPath);
        const submission = JSON.stringify({
          evaluation: { padding: "x".repeat(1_000) },
          qualityScore: null,
        });
        // Each turn's capture is under the bound alone; the submission and the
        // cut report's prefix together are over it.
        const prefix = `# Report\n\n${"y".repeat(1_100)}`;
        const bodies = recordingProvider([
          rawToolCallTurn([submissionCall("submit-1", submission, 1)]),
          textTurn(prefix, validModelConfig.modelId, "length"),
          textTurn(" and the rest of the report.", validModelConfig.modelId, "length"),
        ]);

        const error = await captureInferenceFailure(
          toolPathHarness({ maxResponseBytes: 2_048 }),
          input,
        );

        expect(error.message).toContain("exceeded the composition response byte limit");
        // The bound refused the stitched answer at the cut, so no continuation was asked.
        expect(bodies).toHaveLength(2);
        expect(error.evidence?.answerSubmission).toMatchObject({
          submission: "admitted",
          reportTurn: "refused",
        });
      },
      SESSION,
    );

    it(
      "bounds the submission and its report together, as a stitched text answer is bounded",
      async () => {
        const repositoryPath = await createRepository();
        const input = await qualityStepInput(repositoryPath);
        const submission = JSON.stringify({
          evaluation: { padding: "x".repeat(1_000) },
          qualityScore: null,
        });
        const report = `# Report\n\n${"y".repeat(1_100)}`;
        recordingProvider([
          rawToolCallTurn([submissionCall("submit-1", submission, 1)]),
          textTurn(report),
        ]);

        const error = await captureInferenceFailure(
          toolPathHarness({ maxResponseBytes: 2_048 }),
          input,
        );

        expect(error.message).toContain("exceeded the composition response byte limit");
        expect(error.message).toContain("limit=2048");
        expect(error.evidence?.answerSubmission).toMatchObject({
          submission: "admitted",
          reportTurn: "refused",
        });
      },
      SESSION,
    );
  });

  it(
    "refuses a reply that never calls the submission tool, without trying the text decoder",
    async () => {
      const repositoryPath = await createRepository();
      const input = await qualityStepInput(repositoryPath);
      recordingProvider([textTurn(`${SUBMISSION}\n\n${FIXTURE_REPORT}`)]);

      const error = await captureInferenceFailure(toolPathHarness(), input);

      expect(error.rejection).toEqual({ code: "quality-submission-missing", location: "$" });
      expect(error.condition).toBeUndefined();
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
    "refuses a cut text envelope as a missing submission, never completing it through the text decoder",
    async () => {
      const repositoryPath = await createRepository();
      const input = await qualityStepInput(repositoryPath);
      // The text answer's whole envelope, cut at the output limit, continued, and
      // cut again: the text path would complete and admit it; the tool path must not.
      const envelope = JSON.stringify({
        evaluation: EVALUATION,
        qualityScore: null,
        reportMarkdown: FIXTURE_REPORT,
      });
      const third = Math.ceil(envelope.length / 3);
      const bodies = recordingProvider(
        [0, 1, 2].map((part) =>
          textTurn(
            envelope.slice(part * third, (part + 1) * third),
            validModelConfig.modelId,
            "length",
          ),
        ),
      );

      const error = await captureInferenceFailure(toolPathHarness(), input);

      expect(error.rejection).toEqual({ code: "quality-submission-missing", location: "$" });
      expect(bodies).toHaveLength(1);
      expect(error.evidence?.answerSubmission).toMatchObject({
        path: "tool-call",
        submission: "absent",
        reportTurn: "not-asked",
      });
    },
    SESSION,
  );

  it(
    "refuses a report that breaks a report rule and records the report turn as refused",
    async () => {
      const repositoryPath = await createRepository();
      const input = await qualityStepInput(repositoryPath);
      recordingProvider([
        rawToolCallTurn([submissionCall("submit-1", SUBMISSION)]),
        textTurn(`,"reportMarkdown":"# Report"}`),
      ]);

      const error = await captureInferenceFailure(toolPathHarness(), input);

      expect(error.rejection).toEqual({
        code: "quality-submission-report",
        location: "$.reportMarkdown",
      });
      expect(error.evidence?.answerSubmission).toMatchObject({
        submission: "admitted",
        reportTurn: "refused",
      });
    },
    SESSION,
  );

  it(
    "keeps the first submission and denies a later submission call with the report-turn refusal",
    async () => {
      const repositoryPath = await createRepository();
      const input = await qualityStepInput(repositoryPath);
      const second = JSON.stringify({ evaluation: { replaced: true }, qualityScore: null });
      const bodies = recordingProvider([
        rawToolCallTurn([submissionCall("submit-1", SUBMISSION)]),
        rawToolCallTurn([submissionCall("submit-2", second), readCall("read-after")], {
          created: 2,
        }),
        textTurn(FIXTURE_REPORT),
      ]);

      const result = await toolPathHarness({
        capability: { ...RECORDED_CAPABILITY, reportTurnToolChoice: "auto" },
      }).runStep(input);

      expect(result.qualityArtifactCandidate?.evaluation).toEqual(EVALUATION);
      const refusals = toolResults(bodies[2]!);
      expect(refusals.get("submit-2")).toBe(
        OUTPUT_HOST_TEXT["quality-submission-report-turn-refusal"],
      );
      expect(refusals.get("read-after")).toBe(
        OUTPUT_HOST_TEXT["quality-submission-report-turn-refusal"],
      );
    },
    SESSION,
  );

  it(
    "decodes only the lowest-ordinal submission in a batch and denies the rest",
    async () => {
      const repositoryPath = await createRepository();
      const input = await qualityStepInput(repositoryPath);
      const bodies = recordingProvider([
        rawToolCallTurn([
          submissionCall("submit-1", SUBMISSION),
          submissionCall("submit-2", '{"evaluation":"broken"'),
        ]),
        textTurn(FIXTURE_REPORT),
      ]);

      const result = await toolPathHarness().runStep(input);

      expect(result.qualityArtifactCandidate?.evaluation).toEqual(EVALUATION);
      const results = toolResults(bodies[1]!);
      expect(results.get("submit-1")).toBe(OUTPUT_HOST_TEXT["quality-submission-acknowledgement"]);
      expect(results.get("submit-2")).toBe(
        OUTPUT_HOST_TEXT["quality-submission-extra-call-refusal"],
      );
    },
    SESSION,
  );

  it(
    "ends the attempt on a submission cut at the output limit, with no re-issue",
    async () => {
      const repositoryPath = await createRepository();
      const input = await qualityStepInput(repositoryPath);
      const bodies = recordingProvider([
        rawToolCallTurn([submissionCall("submit-1", '{"evaluation":{"a":"tru', 2)], {
          finishReason: "length",
        }),
        rawToolCallTurn([submissionCall("submit-2", '{"evaluation":{"b":"fal', 2)], {
          finishReason: "length",
          created: 2,
        }),
      ]);

      const execution = await run(toolPathHarness(), input);

      // One cut attempt and its cut-answer retry, which also ends cut.
      expect(bodies.length).toBe(1 + 1);
      expect(execution.evidence.attempts[0]).toMatchObject({
        outcome: "malformed-response",
        condition: "cut-answer",
        rejection: { code: "quality-submission-cut", location: "$" },
        retryRule: "retried-cut-answer",
        answerSubmission: { submission: "refused", reportTurn: "not-asked" },
      });
    },
    SESSION,
  );

  it(
    "continues a cut report, then completes it from the admitted members",
    async () => {
      const repositoryPath = await createRepository();
      const input = await qualityStepInput(repositoryPath);
      recordingProvider([
        rawToolCallTurn([submissionCall("submit-1", SUBMISSION)]),
        textTurn("# Report\n\nThe report was cut", validModelConfig.modelId, "length"),
        textTurn(" and cut again", validModelConfig.modelId, "length"),
      ]);

      const result = await toolPathHarness().runStep(input);

      expect(result.qualityArtifactCandidate).toMatchObject({
        evaluation: EVALUATION,
        qualityScore: null,
      });
      expect(result.qualityArtifactCandidate?.reportMarkdown).toContain(QUALITY_REPORT_CUT_STEM);
      expect(result.answerSubmission).toMatchObject({
        submission: "admitted",
        reportTurn: "admitted",
      });
    },
    SESSION,
  );

  describe("ceiling precedence", () => {
    it.each([
      ["a broken", '{"evaluation":"broken"}'],
      ["a valid", SUBMISSION],
    ])(
      "records the tool-call ceiling, not the submission, when %s submission reaches it",
      async (_name, raw) => {
        const repositoryPath = await createRepository();
        const input = await qualityStepInput(repositoryPath);
        const bodies = recordingProvider([
          rawToolCallTurn([...lsCalls("ceiling", CEILING - 1), submissionCall("submit-1", raw)]),
          rawToolCallTurn([submissionCall("submit-2", SUBMISSION)], { created: 2 }),
          textTurn(FIXTURE_REPORT),
        ]);

        const execution = await run(
          toolPathHarness({ maxProviderTurns: MAX_PROVIDER_TURNS }),
          input,
        );

        expect(execution.status).toBe("succeeded");
        expect(bodies).toHaveLength(3);
        expect(execution.evidence.attempts[0]).toMatchObject({
          outcome: "no-progress",
          condition: "tool-call-ceiling",
          retryRule: "retried-tool-call-ceiling",
          answerSubmission: { submission: "not-decoded-at-ceiling", reportTurn: "not-asked" },
        });
        expect(execution.evidence.attempts[0]!.rejection).toBeUndefined();
        expect(decodeInference(structuredClone(execution.evidence)).attempts).toHaveLength(2);
      },
      SESSION,
    );

    it(
      "refuses a mixed batch when the SDK rejects its submission before host preflight",
      async () => {
        const repositoryPath = await createRepository();
        const input = await qualityStepInput(repositoryPath);
        const bodies = recordingProvider([
          rawToolCallTurn([...lsCalls("below", 2), submissionCall("submit-1", "[1]")]),
        ]);

        const error = await captureInferenceFailure(
          toolPathHarness({ maxProviderTurns: MAX_PROVIDER_TURNS }),
          input,
        );

        expect(bodies).toHaveLength(1);
        expect(error.category).toBe("provider-terminal");
        expect(error.rejection).toBeUndefined();
        expect(error.message).toContain("unpreflighted tool result");
        expect(error.evidence?.executionLease).toMatchObject({
          terminalReason: "evidence-preservation-required",
        });
        expect(error.evidence?.tools).toMatchObject({ totalCalls: 2 });
        expect(error.evidence?.tools.preExecutionRejections).toBeUndefined();
      },
      SESSION,
    );

    it(
      "stops a conclude-now retry turn that also withheld a re-read, before the conclude-now return",
      async () => {
        const repositoryPath = await createRepository();
        const input = await qualityStepInput(repositoryPath);
        const bodies = recordingProvider([
          rawToolCallTurn([readCall("read-1")]),
          rawToolCallTurn([readCall("read-2")], { created: 2 }),
          rawToolCallTurn(
            [
              readCall("read-3"),
              submissionCall("submit-1", '{"evaluation":[],"qualityScore":null}'),
            ],
            {
              created: 3,
            },
          ),
          rawToolCallTurn([submissionCall("submit-2", SUBMISSION)], { created: 4 }),
        ]);

        const error = await captureInferenceFailure(
          toolPathHarness({
            maxProviderTurns: MAX_PROVIDER_TURNS,
            environment: { DOCSFAB_EXECUTION_READ_LOOP_REPEAT_STREAK: "1" },
          }),
          { ...input, responseCorrection: { retryRule: "retried-no-progress" } },
        );

        expect(bodies).toHaveLength(3);
        expect(error.rejection).toEqual({
          code: "quality-submission-shape",
          location: "$.evaluation",
        });
        expect(error.evidence?.tools?.readEvidence?.withheld).toBe(1);
      },
      SESSION,
    );
  });

  describe("per-call authorization under the conclude-now ask", () => {
    it(
      "runs only the submission in a mixed batch and charges the denied reads",
      async () => {
        const repositoryPath = await createRepository();
        const input = await qualityStepInput(repositoryPath);
        const bodies = recordingProvider([
          rawToolCallTurn([readCall("read-1")]),
          rawToolCallTurn([readCall("read-2")], { created: 2 }),
          rawToolCallTurn([readCall("read-3")], { created: 3 }),
          rawToolCallTurn(
            [
              readCall("read-4", "a.md"),
              submissionCall("submit-1", SUBMISSION),
              readCall("read-5", "b.md"),
            ],
            { created: 4 },
          ),
          textTurn(FIXTURE_REPORT),
        ]);

        const result = await toolPathHarness({
          environment: { DOCSFAB_EXECUTION_READ_LOOP_REPEAT_STREAK: "1" },
        }).runStep({ ...input, responseCorrection: { retryRule: "retried-no-progress" } });

        expect(userText(bodies[3]!)).toContain(
          OUTPUT_HOST_TEXT["quality-submission-conclude-now-ask"],
        );
        const results = toolResults(bodies[4]!);
        expect(results.get("read-4")).toBe(PI_ANSWER_NOW_TOOL_REFUSAL);
        expect(results.get("read-5")).toBe(PI_ANSWER_NOW_TOOL_REFUSAL);
        expect(results.get("submit-1")).toBe(
          OUTPUT_HOST_TEXT["quality-submission-acknowledgement"],
        );
        expect(userText(bodies[4]!)).toContain(OUTPUT_HOST_TEXT["quality-submission-report-ask"]);
        expect(result.tools?.readEvidence?.deniedAfterAsk).toBe(2);
        expect(result.concludeNow).toEqual({ trigger: "read-loop", turn: 3 });
        expect(result.qualityArtifactCandidate?.evaluation).toEqual(EVALUATION);
      },
      SESSION,
    );

    /**
     * The design's case (#1707 §4): under the ask, two denied reads spend the
     * last two chargeable attempts, so the lease withholds the submission.
     * Chargeable attempts are capped at the hard tool-call ceiling, so the
     * lease cannot renew afterwards: the host still admits the submission, the
     * report is never asked, and the attempt ends on the lease stop's code.
     */
    it(
      "admits a submission withheld when chargeable attempts run out, then ends on the lease stop",
      async () => {
        const repositoryPath = await createRepository();
        const input = await qualityStepInput(repositoryPath);
        const bodies = recordingProvider([
          rawToolCallTurn([...lsCalls("first", 2), readCall("read-1")]),
          rawToolCallTurn([readCall("read-2")], { created: 2 }),
          rawToolCallTurn([readCall("read-3")], { created: 3 }),
          rawToolCallTurn(
            [
              readCall("read-4", "a.md"),
              readCall("read-5", "b.md"),
              submissionCall("submit-1", SUBMISSION),
            ],
            { created: 4 },
          ),
        ]);

        const error = await captureInferenceFailure(
          toolPathHarness({
            maxProviderTurns: MAX_PROVIDER_TURNS,
            environment: { DOCSFAB_EXECUTION_READ_LOOP_REPEAT_STREAK: "1" },
          }),
          { ...input, responseCorrection: { retryRule: "retried-no-progress" } },
        );

        expect(bodies).toHaveLength(4);
        expect(error.message).toContain("hard-tool-call-ceiling");
        expect(error.evidence?.answerSubmission).toEqual({
          path: "tool-call",
          reason: "recorded-route",
          submission: "admitted",
          reportTurn: "not-asked",
          memberEncoding: { evaluation: "object", qualityScore: "null" },
        });
      },
      SESSION,
    );

    it(
      "records a broken submission the lease withheld with its own code",
      async () => {
        const repositoryPath = await createRepository();
        const input = await qualityStepInput(repositoryPath);
        recordingProvider([
          rawToolCallTurn([...lsCalls("first", 2), readCall("read-1")]),
          rawToolCallTurn([readCall("read-2")], { created: 2 }),
          rawToolCallTurn([readCall("read-3")], { created: 3 }),
          rawToolCallTurn(
            [
              readCall("read-4", "a.md"),
              readCall("read-5", "b.md"),
              submissionCall("submit-1", '{"evaluation":["broken"],"qualityScore":null}'),
            ],
            { created: 4 },
          ),
        ]);

        const error = await captureInferenceFailure(
          toolPathHarness({
            maxProviderTurns: MAX_PROVIDER_TURNS,
            environment: { DOCSFAB_EXECUTION_READ_LOOP_REPEAT_STREAK: "1" },
          }),
          { ...input, responseCorrection: { retryRule: "retried-no-progress" } },
        );

        expect(error.rejection).toEqual({
          code: "quality-submission-shape",
          location: "$.evaluation",
        });
        expect(error.evidence?.answerSubmission).toMatchObject({ submission: "refused" });
      },
      SESSION,
    );
  });

  describe("after an admitted submission", () => {
    it(
      "moves on to the report when the same turn makes the read-loop stop due",
      async () => {
        const repositoryPath = await createRepository();
        const input = await qualityStepInput(repositoryPath);
        // One full re-read, then one notice-only re-read; the next re-read,
        // in the submission's turn, makes the read-loop stop due.
        const bodies = recordingProvider([
          rawToolCallTurn([readCall("read-1")]),
          rawToolCallTurn([readCall("read-2")], { created: 2 }),
          rawToolCallTurn([readCall("read-3")], { created: 3 }),
          rawToolCallTurn([readCall("read-4"), submissionCall("submit-1", SUBMISSION)], {
            created: 4,
          }),
          textTurn(FIXTURE_REPORT),
        ]);

        const result = await toolPathHarness({
          maxProviderTurns: 16,
          environment: {
            DOCSFAB_EXECUTION_READ_LOOP_REPEAT_STREAK: "1",
            DOCSFAB_EXECUTION_READ_LOOP_WITHHELD_READS: "1",
          },
        }).runStep(input);

        expect(result.tools?.readEvidence?.withheld).toBe(2);
        expect(bodies).toHaveLength(5);
        expect(userText(bodies[4]!)).toContain(OUTPUT_HOST_TEXT["quality-submission-report-ask"]);
        expect(result.qualityArtifactCandidate?.evaluation).toEqual(EVALUATION);
      },
      SESSION,
    );

    it(
      "never adds the conclude-now ask after the report ask",
      async () => {
        const repositoryPath = await createRepository();
        const input = await qualityStepInput(repositoryPath);
        // On a conclude-now retry, the submission's turn also withheld a
        // re-read, so the conclude-now ask would fire on the next prepared
        // turn; the report ask comes first and stays the only ask.
        const bodies = recordingProvider([
          rawToolCallTurn([readCall("read-1")]),
          rawToolCallTurn([readCall("read-2")], { created: 2 }),
          rawToolCallTurn([readCall("read-3"), submissionCall("submit-1", SUBMISSION)], {
            created: 3,
          }),
          rawToolCallTurn([readCall("read-after")], { created: 4 }),
          textTurn(FIXTURE_REPORT),
        ]);

        const result = await toolPathHarness({
          capability: { ...RECORDED_CAPABILITY, reportTurnToolChoice: "auto" },
          environment: { DOCSFAB_EXECUTION_READ_LOOP_REPEAT_STREAK: "1" },
        }).runStep({ ...input, responseCorrection: { retryRule: "retried-no-progress" } });

        expect(bodies).toHaveLength(5);
        expect(toolResults(bodies[4]!).get("read-after")).toBe(
          OUTPUT_HOST_TEXT["quality-submission-report-turn-refusal"],
        );
        for (const body of bodies) {
          expect(userText(body)).not.toContain(
            OUTPUT_HOST_TEXT["quality-submission-conclude-now-ask"],
          );
        }
        expect(result.concludeNow).toBeUndefined();
        expect(result.qualityArtifactCandidate?.evaluation).toEqual(EVALUATION);
      },
      SESSION,
    );
  });

  it(
    "admits a submission the lease withheld at a lease boundary, and the report ask says so",
    async () => {
      const repositoryPath = await createRepository();
      const input = await qualityStepInput(repositoryPath);
      await writeFile(resolve(repositoryPath, "guide.md"), "# Guide\n");
      // Two calls per lease: the two reads use the lease, so the lease
      // withholds the submission listed after them; the next lease renews on
      // their progress.
      const bodies = recordingProvider([
        rawToolCallTurn([
          readCall("read-1", "README.md"),
          readCall("read-2", "guide.md"),
          submissionCall("submit-1", SUBMISSION),
        ]),
        textTurn(FIXTURE_REPORT),
      ]);

      // A turn budget large enough for the compiled shape to admit three leases.
      const result = await toolPathHarness({
        maxProviderTurns: 256,
        environment: {
          DOCSFAB_COMPOSITION_EXECUTION_CALLS_PER_LEASE: "2",
          DOCSFAB_COMPOSITION_EXECUTION_MAX_LEASES: "3",
        },
      }).runStep(input);

      expect(toolResults(bodies[1]!).get("submit-1")).toBe(
        "DocsFab withheld this tool call at an execution-lease boundary.",
      );
      expect(userText(bodies[1]!)).toContain(
        OUTPUT_HOST_TEXT["quality-submission-report-ask-after-withheld-submission"],
      );
      expect(result.qualityArtifactCandidate?.evaluation).toEqual(EVALUATION);
      expect(result.answerSubmission).toMatchObject({
        submission: "admitted",
        reportTurn: "admitted",
      });
    },
    SESSION,
  );

  describe("output authority on the report turn", () => {
    const perTurnOutput = 32_768;
    const leaseOutput = 128_000;
    const floor =
      validModelConfig.requestPolicy.minimumOutputTokens + OUTPUT_AUTHORITY_FLOOR_TOKENS;

    it.each([
      ["clamped", leaseOutput - perTurnOutput + 1_000, "clamped"],
      ["stopped", leaseOutput - floor + 1, "authority-stopped"],
    ] as const)(
      "records a report turn the cumulative output authority %s",
      async (_name, spent, reportTurn) => {
        const repositoryPath = await createRepository();
        const input = await qualityStepInput(repositoryPath);
        recordingProvider([
          rawToolCallTurn([submissionCall("submit-1", SUBMISSION)], {
            usage: { prompt_tokens: 10, completion_tokens: spent, total_tokens: 10 + spent },
          }),
          textTurn(FIXTURE_REPORT),
        ]);
        const harness = toolPathHarness({
          maxOutputTokens: perTurnOutput,
          contextWindow: 524_288,
          environment: {
            DOCSFAB_COMPOSITION_EXECUTION_MAX_CUMULATIVE_OUTPUT_TOKENS: String(leaseOutput),
          },
        });

        const outcome = await harness.runStep(input).then(
          (result) => result.answerSubmission,
          (error: { evidence?: { answerSubmission?: unknown } }) =>
            error.evidence?.answerSubmission,
        );

        expect(outcome).toMatchObject({ submission: "admitted", reportTurn });
      },
      SESSION,
    );
  });
});
