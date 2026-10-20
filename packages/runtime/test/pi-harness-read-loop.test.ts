// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseRetryPolicy } from "../src/config/retry-policy.js";
import { RETRY_RULES } from "../src/contracts/model-output.generated.js";
import { PI_CONCLUDE_NOW_PROMPT } from "../src/harness/pi-session.js";
import { READ_EVIDENCE_NOTICE_PREFIX } from "../src/harness/read-evidence.js";
import { createModelConnection } from "../src/model/provider.js";
import { decodeTools } from "../src/execution/inference-evidence.js";
import { decodeInference } from "../src/scorecard-record-decode.js";
import { ScorecardRecordError } from "../src/scorecard-record.js";
import { evaluateStructure, parseEvaluationFixture } from "../src/quality-evaluation/structural.js";
import type { HarnessStepInput } from "../src/execution/contracts.js";
import type { InferenceProgressObservationV1, RunRecord } from "../src/records/contracts.js";
import {
  PiHarness,
  captureInferenceFailure,
  createAuditHarness,
  createProviderConnectionFactory,
  fixtureCompositionExecutionProfile,
  skillCrateDirectory,
  createRepository,
  executeInferenceStep,
  resetSharedTestState,
  stepInput,
  textTurn,
  toolTurn,
  validModelConfig,
} from "./support/pi-harness-session-fixtures.js";

afterEach(resetSharedTestState);

/** Two full repeats and two notice-only repeats, through the shipped overrides. */
const SMALL_BOUNDS = {
  environment: {
    DOCSFAB_EXECUTION_READ_LOOP_REPEAT_STREAK: "2",
    DOCSFAB_EXECUTION_READ_LOOP_WITHHELD_READS: "2",
  },
};

interface DelegatedRequest {
  messages: Array<{ role?: string; content?: unknown; tool_call_id?: string }>;
}

function recordProvider(responses: readonly Response[]): DelegatedRequest[] {
  const delegated: DelegatedRequest[] = [];
  let index = 0;
  vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
    delegated.push(JSON.parse(String(init?.body ?? "{}")) as DelegatedRequest);
    const response = responses[index];
    index += 1;
    if (!response) throw new Error("Unexpected provider request.");
    return response.clone();
  });
  return delegated;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part as { text?: string }).text ?? "").join("\n");
  }
  return "";
}

/** The model-visible result of the most recent tool call in one delegated request. */
function lastToolResult(request: DelegatedRequest): string {
  const tool = request.messages.filter((message) => message.role === "tool").at(-1);
  return messageText(tool?.content);
}

function readTurn(id: string, path: string, created: number): Response {
  return toolTurn([{ id, name: "read", arguments: { path } }], created);
}

/**
 * A model that re-reads one unchanged file is steered by host-authored tool
 * results and stopped by name. Cases drive `PiHarness.runStep` against the real
 * Pi session with a scripted provider.
 */
describe("PiHarness read-loop supervision", () => {
  it("emits content-free Pi turn and tool boundaries with cumulative provider usage", async () => {
    const repositoryPath = await createRepository();
    await writeFile(resolve(repositoryPath, "guide.md"), "GUIDE-BODY-MARKER\n");
    recordProvider([readTurn("p1", "guide.md", 1), textTurn("Review complete.")]);
    const harness = await createAuditHarness();
    const observations: InferenceProgressObservationV1[] = [];
    const result = await harness.runStep({
      ...stepInput(repositoryPath),
      inferenceAttempt: 1,
      onProgress: (observation) => observations.push(observation),
    });

    expect(observations.filter((item) => item.event === "provider-turn-started").length).toBe(2);
    expect(observations.filter((item) => item.event === "provider-turn-settled").length).toBe(2);
    expect(observations.some((item) => item.event === "tool-execution-started")).toBe(true);
    expect(observations.some((item) => item.event === "tool-execution-settled")).toBe(true);
    const toolSettled = observations.find((item) => item.event === "tool-execution-settled")!;
    expect(toolSettled.toolActivity).toMatchObject({
      readSearch: { started: 1, settled: 1, errorResults: 0 },
    });
    expect(Object.isFrozen(toolSettled.toolActivity)).toBe(true);
    expect(Object.isFrozen(toolSettled.toolActivity?.readSearch)).toBe(true);
    expect(
      observations.find((item) => item.event === "tool-execution-started")?.toolActivity,
    ).toMatchObject({ readSearch: { started: 1, settled: 0, errorResults: 0 } });
    const settled = observations.filter((item) => item.event === "provider-turn-settled").at(-1)!;
    expect(settled.usage).toBeDefined();
    expect(settled.usage?.input).toBeGreaterThan(0);
    expect(settled.usage?.output).toBeGreaterThan(0);
    expect(result.usage).toMatchObject({
      input: settled.usage?.input,
      output: settled.usage?.output,
      cacheRead: settled.usage?.cacheRead,
      cacheWrite: settled.usage?.cacheWrite,
      total: settled.usage?.total,
    });
    expect(JSON.stringify(observations)).not.toContain("GUIDE-BODY-MARKER");
    expect(JSON.stringify(observations)).not.toContain("guide.md");
  }, 120_000);

  it("records Pi error results in their fixed activity category without retaining names", async () => {
    const repositoryPath = await createRepository();
    recordProvider([readTurn("missing-read", "not-present.md", 1), textTurn("Review complete.")]);
    const harness = await createAuditHarness();
    const observations: InferenceProgressObservationV1[] = [];
    await harness.runStep({
      ...stepInput(repositoryPath),
      onProgress: (observation) => observations.push(observation),
    });

    const settled = observations.filter((item) => item.event === "tool-execution-settled").at(-1)!;
    expect(settled.toolActivity).toMatchObject({
      readSearch: { started: 1, settled: 1, errorResults: 1 },
    });
    expect(JSON.stringify(observations)).not.toContain("missing-read");
    expect(JSON.stringify(observations)).not.toContain("not-present.md");
  }, 120_000);

  it("steers unchanged re-reads and lets the step finish with the content it has", async () => {
    const repositoryPath = await createRepository();
    await writeFile(resolve(repositoryPath, "guide.md"), "GUIDE-BODY-MARKER\n");
    const delegated = recordProvider([
      readTurn("r1", "guide.md", 1),
      readTurn("r2", "guide.md", 2),
      readTurn("r3", "guide.md", 3),
      readTurn("r4", "guide.md", 4),
      textTurn("Review complete."),
    ]);
    const harness = await createAuditHarness({ limits: SMALL_BOUNDS });
    const result = await harness.runStep(stepInput(repositoryPath));

    expect(result.summary).toBe("Review complete.");
    expect(delegated).toHaveLength(5);
    // First delivery: the content alone.
    expect(lastToolResult(delegated[1]!)).toContain("GUIDE-BODY-MARKER");
    expect(lastToolResult(delegated[1]!)).not.toContain(READ_EVIDENCE_NOTICE_PREFIX);
    // Repeats within the streak: the content in full, plus the host notice.
    for (const [index, request] of [delegated[2]!, delegated[3]!].entries()) {
      const delivered = lastToolResult(request);
      expect(delivered).toContain("GUIDE-BODY-MARKER");
      expect(delivered).toContain(
        `${READ_EVIDENCE_NOTICE_PREFIX} This read result for guide.md is unchanged since turn 1 and is already in your context.`,
      );
      expect(delivered).toContain(`(re-read ${index + 1} times;`);
    }
    // Past the streak: the notice alone. The bytes are still in this request.
    const withheld = lastToolResult(delegated[4]!);
    expect(withheld).not.toContain("GUIDE-BODY-MARKER");
    expect(withheld).toContain(
      "Not re-sent: this read result for guide.md is unchanged since turn 1, and that content is still in your context.",
    );
    expect(JSON.stringify(delegated[4]!.messages)).toContain("GUIDE-BODY-MARKER");
    expect(result.tools?.byTool).toEqual([{ name: "read", calls: 4, failures: 0 }]);
    // Content-free counters on the attempt record: every repeat got a notice.
    expect(result.tools?.readEvidence).toEqual({
      unchangedReReads: 3,
      withheld: 1,
      maxRepeatsOfOneResult: 3,
      maxUnchangedReReadsAcrossResults: 3,
    });
  }, 120_000);

  it("ends a read loop at exactly K+L+1 unchanged re-reads as no-progress, by name, then retries once and concludes now", async () => {
    const repositoryPath = await createRepository();
    await writeFile(resolve(repositoryPath, "guide.md"), "GUIDE-BODY-MARKER\n");
    const delegated = recordProvider([
      // Attempt 1: the host stops it before a seventh turn.
      ...["r1", "r2", "r3", "r4", "r5", "r6"].map((id, index) =>
        readTurn(id, "guide.md", index + 1),
      ),
      // Attempt 2, the conclude-now retry: one new read, K repeats, then the
      // first withheld re-read; the host then asks for the answer.
      ...["s1", "s2", "s3", "s4"].map((id, index) => readTurn(id, "guide.md", index + 7)),
      textTurn("Review complete."),
    ]);
    const harness = await createAuditHarness({ limits: SMALL_BOUNDS });
    const input = stepInput(repositoryPath);
    // Through the runner's retry layer, as `docsfab run` drives the step.
    const execution = await executeInferenceStep({
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

    expect(delegated).toHaveLength(11);
    expect(execution.status).toBe("succeeded");
    if (execution.status !== "succeeded") throw new Error("expected a succeeded step");
    expect(execution.result.summary).toBe("Review complete.");
    const [stopped, concluded] = execution.evidence.attempts;
    // Attempt 1 is the read-loop stop, by name, now retried by its own rule.
    expect(stopped).toMatchObject({
      outcome: "no-progress",
      retryable: true,
      retryScheduled: true,
      conditionRetryability: "eligible",
      retryDecision: "retried",
      retryRule: "retried-no-progress",
      // One catalog code per bound, on the record itself.
      rejection: { code: "execution-read-loop-withheld-reads-bound", location: "$.tools" },
    });
    expect(stopped?.tools?.readEvidence).toEqual({
      unchangedReReads: 5,
      withheld: 3,
      maxRepeatsOfOneResult: 5,
      maxUnchangedReReadsAcrossResults: 5,
    });
    expect(stopped?.executionLease).toMatchObject({
      phase: "terminal",
      terminalReason: "checkpoint-not-renewable",
      terminalDisposition: "progress-stopped",
    });
    // Attempt 2 carries the rule's statement, withdraws the tools at its first
    // withheld re-read, and records when.
    expect(messageText(delegated[6]!.messages.at(-1)?.content)).toContain(
      RETRY_RULES["retried-no-progress"].statement!,
    );
    expect(messageText(delegated[10]!.messages.at(-1)?.content)).toBe(PI_CONCLUDE_NOW_PROMPT);
    expect(concluded).toMatchObject({
      outcome: "succeeded",
      retryRule: "not-applicable",
      concludeNow: { trigger: "read-loop", turn: 4 },
    });
    // The saved attempt evidence decodes through the record decoder.
    expect(
      decodeInference(structuredClone(execution.evidence)).attempts.map(
        (attempt) => attempt.outcome,
      ),
    ).toEqual(["no-progress", "succeeded"]);
  }, 120_000);

  it("stops a cycle across several unchanged results by the cross-result code, then the conclude-now retry answers", async () => {
    const repositoryPath = await createRepository();
    const paths = ["a.md", "b.md", "c.md"];
    for (const path of paths) await writeFile(resolve(repositoryPath, path), `BODY-${path}\n`);
    // Each file is re-read at most twice per attempt, under its own streak of 4,
    // so only the cross-result allowance of 3 can catch the cycle.
    const bounds = {
      environment: {
        DOCSFAB_EXECUTION_READ_LOOP_REPEAT_STREAK: "4",
        DOCSFAB_EXECUTION_READ_LOOP_WITHHELD_READS: "2",
        DOCSFAB_EXECUTION_READ_LOOP_UNCHANGED_RE_READS: "3",
      },
    };
    const cycle = (prefix: string, reads: number, firstCreated: number) =>
      Array.from({ length: reads }, (_, index) =>
        readTurn(`${prefix}${index}`, paths[index % paths.length]!, firstCreated + index),
      );
    const delegated = recordProvider([
      // Attempt 1: 3 new reads, then 6 unchanged re-reads: 3 in full, 3 notice-only.
      ...cycle("r", 9, 1),
      // Attempt 2: 3 new reads, 3 re-reads in full, the first withheld re-read,
      // then the host asks for the answer.
      ...cycle("s", 7, 10),
      textTurn("Review complete."),
    ]);
    const harness = await createAuditHarness({ limits: bounds });
    const input = stepInput(repositoryPath);
    const execution = await executeInferenceStep({
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

    expect(delegated).toHaveLength(17);
    expect(execution.status).toBe("succeeded");
    if (execution.status !== "succeeded") throw new Error("expected a succeeded step");
    expect(execution.result.summary).toBe("Review complete.");
    const [stopped, concluded] = execution.evidence.attempts;
    expect(stopped).toMatchObject({
      outcome: "no-progress",
      retryRule: "retried-no-progress",
      rejection: { code: "execution-read-loop-unchanged-re-reads-bound", location: "$.tools" },
    });
    expect(stopped?.tools?.readEvidence).toEqual({
      unchangedReReads: 6,
      withheld: 3,
      maxRepeatsOfOneResult: 2,
      maxUnchangedReReadsAcrossResults: 6,
    });
    expect(stopped?.tools?.byTool).toEqual([{ name: "read", calls: 9, failures: 0 }]);
    // The 4th re-read is withheld although its file was re-read only twice.
    const firstWithheld = lastToolResult(delegated[7]!);
    expect(firstWithheld).not.toContain("BODY-a.md");
    expect(firstWithheld).toContain(
      "This attempt has re-read 4 unchanged results with no progress between; past 3 the host sends only this notice.",
    );
    // The retry flips at its first cross-result withheld re-read.
    expect(messageText(delegated[16]!.messages.at(-1)?.content)).toBe(PI_CONCLUDE_NOW_PROMPT);
    expect(concluded).toMatchObject({
      outcome: "succeeded",
      concludeNow: { trigger: "read-loop", turn: 7 },
    });
    expect(
      decodeInference(structuredClone(execution.evidence)).attempts.map(
        (attempt) => attempt.outcome,
      ),
    ).toEqual(["no-progress", "succeeded"]);
  }, 120_000);

  it("delivers a pass over several unchanged results in full up to the cross-result allowance", async () => {
    const repositoryPath = await createRepository();
    const paths = ["a.md", "b.md", "c.md"];
    for (const path of paths) await writeFile(resolve(repositoryPath, path), `BODY-${path}\n`);
    const delegated = recordProvider([
      ...[...paths, ...paths].map((path, index) => readTurn(`p${index}`, path, index + 1)),
      textTurn("Review complete."),
    ]);
    const harness = await createAuditHarness({
      limits: {
        environment: {
          DOCSFAB_EXECUTION_READ_LOOP_REPEAT_STREAK: "4",
          DOCSFAB_EXECUTION_READ_LOOP_WITHHELD_READS: "2",
          DOCSFAB_EXECUTION_READ_LOOP_UNCHANGED_RE_READS: "3",
        },
      },
    });
    const result = await harness.runStep(stepInput(repositoryPath));

    expect(result.summary).toBe("Review complete.");
    for (const [index, path] of paths.entries()) {
      expect(lastToolResult(delegated[index + 4]!)).toContain(`BODY-${path}`);
    }
    expect(result.tools?.readEvidence).toEqual({
      unchangedReReads: 3,
      withheld: 0,
      maxRepeatsOfOneResult: 1,
      maxUnchangedReReadsAcrossResults: 3,
    });
  }, 120_000);

  it("refuses a read-loop stop relabelled as a context stop or as a tool-call ceiling stop", async () => {
    const repositoryPath = await createRepository();
    await writeFile(resolve(repositoryPath, "guide.md"), "GUIDE-BODY-MARKER\n");
    recordProvider(
      ["r1", "r2", "r3", "r4", "r5", "r6"].map((id, index) => readTurn(id, "guide.md", index + 1)),
    );
    const harness = await createAuditHarness({ limits: SMALL_BOUNDS });
    const input = stepInput(repositoryPath);
    const execution = await executeInferenceStep({
      mode: input.step.mode,
      policy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableCategories: [] },
      evidenceIdentity: input.evidenceIdentity,
      sleep: async () => {},
      execute: (attempt) =>
        harness.runStep({ ...input, inferenceAttempt: attempt, retriesConsumed: attempt - 1 }),
    });
    const evidence = structuredClone(execution.evidence);
    // Positive control: the stop after a settled tool turn decodes as recorded.
    expect(decodeInference(structuredClone(evidence)).attempts[0]?.outcome).toBe("no-progress");
    expect(evidence.attempts[0]?.executionLease?.terminalReason).not.toBe("hard-tool-call-ceiling");
    // The same shape relabelled a context stop: its lease ended below the ceiling.
    const relabelled = structuredClone(evidence);
    const attempt = relabelled.attempts[0]! as unknown as Record<string, unknown>;
    attempt.outcome = "context-exhausted";
    attempt.retryable = false;
    attempt.retryScheduled = false;
    delete attempt.rejection;
    // The retry fields a real context stop under this policy records.
    attempt.conditionRetryability = "not-eligible";
    attempt.retryDecision = "not-applicable";
    attempt.retryRule = "not-applicable";
    expect(() => decodeInference(structuredClone(relabelled))).toThrow(ScorecardRecordError);
    // The same stop claiming the tool-call ceiling: its lease ended below it.
    const ceilingClaim = structuredClone(evidence);
    (ceilingClaim.attempts[0]! as unknown as Record<string, unknown>).condition =
      "tool-call-ceiling";
    expect(() => decodeInference(structuredClone(ceilingClaim))).toThrow(ScorecardRecordError);
    // The structural evaluator agrees, and admits the stop as recorded.
    const governance = (inference: typeof evidence) => {
      const tools = structuredClone(inference.attempts[0]!.tools);
      const record = {
        id: "read-loop-stop",
        repository: { revision: "a".repeat(40) },
        tools,
        steps: [
          { id: "audit-documentation", status: "failed", mode: "read-only", tools, inference },
        ],
      } as unknown as RunRecord;
      return evaluateStructure(
        parseEvaluationFixture({
          version: 1,
          name: "read-loop stop",
          assertions: [{ type: "turn-governance-evidence" }],
        }),
        [record],
      ).results[0]?.message;
    };
    expect(governance(evidence)).toBe("provider turns are locally governed and revision-bound");
    expect(governance(relabelled)).toContain("outcome/turn disposition mismatch");
  }, 120_000);

  it("keeps the conclude-now ask across a transport retry, in a record the decoder admits", async () => {
    const repositoryPath = await createRepository();
    await writeFile(resolve(repositoryPath, "guide.md"), "GUIDE-BODY-MARKER\n");
    const answers = [
      // Attempt 1: the read-loop stop.
      ...["r1", "r2", "r3", "r4", "r5", "r6"].map((id, index) =>
        readTurn(id, "guide.md", index + 1),
      ),
      // Attempt 3: the conclude-now retry the transport retry carried forward.
      ...["s1", "s2", "s3", "s4"].map((id, index) => readTurn(id, "guide.md", index + 7)),
      textTurn("Review complete."),
    ];
    // Attempt 2: every request it sends is throttled, however many in-turn
    // replays the provider layer spends before the attempt fails.
    let currentAttempt = 0;
    let throttles = 0;
    const answered: DelegatedRequest[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      if (currentAttempt === 2) {
        throttles += 1;
        return new Response(JSON.stringify({ message: "Rate limit exceeded" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      answered.push(JSON.parse(String(init?.body ?? "{}")) as DelegatedRequest);
      const response = answers[answered.length - 1];
      if (!response) throw new Error("Unexpected provider request.");
      return response.clone();
    });
    // The in-turn replay backoff is collapsed, so the suite does not wait.
    const harness = new PiHarness({
      skillCrateDirectory,
      model: validModelConfig,
      limits: SMALL_BOUNDS,
      createConnection: (model, options) =>
        createModelConnection(
          model,
          options ? { ...options, providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0 } } : options,
        ),
    });
    const input = stepInput(repositoryPath);
    const execution = await executeInferenceStep({
      mode: input.step.mode,
      policy: parseRetryPolicy({}),
      evidenceIdentity: input.evidenceIdentity,
      sleep: async () => {},
      execute: (attempt, responseCorrection) => {
        currentAttempt = attempt;
        return harness.runStep({
          ...input,
          inferenceAttempt: attempt,
          retriesConsumed: attempt - 1,
          ...(responseCorrection ? { responseCorrection } : {}),
        });
      },
    });

    expect(execution.status).toBe("succeeded");
    expect(throttles).toBeGreaterThan(0);
    expect(answered).toHaveLength(answers.length);
    expect(execution.evidence.attempts.map((attempt) => attempt.retryRule)).toEqual([
      "retried-no-progress",
      "retried-transport",
      "not-applicable",
    ]);
    // The retry after the throttle still asks for the answer at its first
    // withheld re-read, and records it.
    expect(messageText(answered.at(-1)!.messages.at(-1)?.content)).toBe(PI_CONCLUDE_NOW_PROMPT);
    expect(execution.evidence.attempts[2]?.concludeNow).toEqual({ trigger: "read-loop", turn: 4 });
    expect(
      decodeInference(structuredClone(execution.evidence)).attempts.map(
        (attempt) => attempt.outcome,
      ),
    ).toEqual(["no-progress", "throttled", "succeeded"]);
  }, 120_000);

  it.each([
    ["a conclude-now retry", { retryRule: "retried-no-progress" as const }, "succeeded"],
    // Adjacent: the same batch without the conclude-now correction is stopped.
    ["an ordinary attempt", undefined, "no-progress"],
  ] as const)(
    "lets %s ask for the answer when one batch reaches both the first withheld read and the stop",
    async (_label, responseCorrection, expected) => {
      const repositoryPath = await createRepository();
      await writeFile(resolve(repositoryPath, "guide.md"), "GUIDE-BODY-MARKER\n");
      const delegated = recordProvider([
        // K = L = 1: the third identical read in this one batch is the first
        // withheld one, and the fourth makes the stop due.
        toolTurn(
          ["b1", "b2", "b3", "b4"].map((id) => ({
            id,
            name: "read",
            arguments: { path: "guide.md" },
          })),
          1,
        ),
        textTurn("Review complete."),
      ]);
      const harness = await createAuditHarness({
        limits: {
          environment: {
            DOCSFAB_EXECUTION_READ_LOOP_REPEAT_STREAK: "1",
            DOCSFAB_EXECUTION_READ_LOOP_WITHHELD_READS: "1",
          },
        },
      });
      const input = {
        ...stepInput(repositoryPath),
        inferenceAttempt: 2,
        retriesConsumed: 1,
        ...(responseCorrection ? { responseCorrection } : {}),
      };
      if (expected === "succeeded") {
        const result = await harness.runStep(input);
        expect(result.summary).toBe("Review complete.");
        expect(messageText(delegated[1]!.messages.at(-1)?.content)).toBe(PI_CONCLUDE_NOW_PROMPT);
        expect(result.concludeNow).toEqual({ trigger: "read-loop", turn: 1 });
      } else {
        const error = await captureInferenceFailure(harness, input);
        expect(error.category).toBe("no-progress");
        expect(delegated).toHaveLength(1);
      }
    },
    120_000,
  );

  it("stops a conclude-now retry whose model ignores the ask, by the read-loop code, with every later call denied", async () => {
    const repositoryPath = await createRepository();
    await writeFile(resolve(repositoryPath, "guide.md"), "GUIDE-BODY-MARKER\n");
    // K = L = 2. Four reads reach the first withheld re-read, so request 5
    // carries the ask; the model keeps reading. The scripted tail is longer
    // than the stop allows, so an unarmed stop would show as extra requests.
    const delegated = recordProvider(
      Array.from({ length: 12 }, (_, index) => readTurn(`c${index + 1}`, "guide.md", index + 1)),
    );
    const harness = await createAuditHarness({ limits: SMALL_BOUNDS });
    const error = await captureInferenceFailure(harness, {
      ...stepInput(repositoryPath),
      inferenceAttempt: 2,
      retriesConsumed: 1,
      responseCorrection: { retryRule: "retried-no-progress" },
    });

    expect(error.category).toBe("no-progress");
    expect(error.rejection).toEqual({
      code: "execution-read-loop-withheld-reads-bound",
      location: "$.tools",
    });
    // One withheld re-read and two denied calls spend the allowance of 2.
    expect(error.message).toContain(
      "After the host withdrew the tools and asked for the answer, the model made 2 more tool calls, each denied.",
    );
    expect(delegated).toHaveLength(6);
    expect(messageText(delegated[4]!.messages.at(-1)?.content)).toBe(PI_CONCLUDE_NOW_PROMPT);
    // The tools are withdrawn: no call after the ask runs, so the file's bytes
    // never come back, and the read count stops at the four before the ask.
    expect(lastToolResult(delegated[5]!)).not.toContain("GUIDE-BODY-MARKER");
    expect(lastToolResult(delegated[5]!)).not.toContain(READ_EVIDENCE_NOTICE_PREFIX);
    const tools = error.evidence?.tools;
    expect(tools?.byTool).toEqual([{ name: "read", calls: 4, failures: 0 }]);
    // The record alone explains the stop's observed value: the notice-only
    // re-reads of the worst result (3 - K) plus the denied calls, 1 + 2 = 3 > L.
    expect(tools?.readEvidence).toEqual({
      unchangedReReads: 3,
      withheld: 1,
      maxRepeatsOfOneResult: 3,
      maxUnchangedReReadsAcrossResults: 3,
      deniedAfterAsk: 2,
    });
    expect(error.message).toContain(
      "execution-read-loop-withheld-reads-bound: 3 exceeds execution.readLoopWithheldReads = 2 count.",
    );
    // The denied calls are governance stops, and the decoder admits the record.
    expect(
      tools?.failureCategories?.find((entry) => entry.category === "governance-stop")?.count,
    ).toBe(2);
    expect(decodeTools(structuredClone(tools)).readEvidence?.deniedAfterAsk).toBe(2);
  }, 120_000);

  it("still decodes a read-loop stop recorded before the no-progress retry existed", async () => {
    const repositoryPath = await createRepository();
    await writeFile(resolve(repositoryPath, "guide.md"), "GUIDE-BODY-MARKER\n");
    recordProvider(
      ["r1", "r2", "r3", "r4", "r5", "r6"].map((id, index) => readTurn(id, "guide.md", index + 1)),
    );
    const harness = await createAuditHarness({ limits: SMALL_BOUNDS });
    const input = stepInput(repositoryPath);
    const execution = await executeInferenceStep({
      mode: input.step.mode,
      policy: parseRetryPolicy({ DOCSFAB_READ_ONLY_MAX_NO_PROGRESS_RETRIES: "0" }),
      evidenceIdentity: input.evidenceIdentity,
      sleep: async () => {},
      execute: (attempt) => harness.runStep({ ...input, inferenceAttempt: attempt }),
    });
    // Rewrite it as the read-loop release wrote it: no condition budgets, no
    // retry rule, the category off the policy, and the stop terminal.
    const legacy = structuredClone(execution.evidence) as typeof execution.evidence & {
      attempts: Array<Record<string, unknown>>;
    };
    delete legacy.conditionRetry;
    legacy.retryableCategories = legacy.retryableCategories.filter(
      (category) => category !== "no-progress",
    );
    for (const attempt of legacy.attempts) {
      delete attempt.retryRule;
      attempt.retryable = false;
      attempt.conditionRetryability = "not-eligible";
      attempt.retryDecision = "not-applicable";
    }
    expect(decodeInference(structuredClone(legacy)).attempts[0]?.outcome).toBe("no-progress");
    // Adjacent: claiming the stop retryable in that older shape is refused.
    const claimed = structuredClone(legacy);
    claimed.attempts[0]!.conditionRetryability = "eligible";
    claimed.attempts[0]!.retryDecision = "declined";
    expect(() => decodeInference(claimed)).toThrow();
  }, 120_000);

  it("lets the step answer at K+L unchanged re-reads, one short of the stop", async () => {
    const repositoryPath = await createRepository();
    await writeFile(resolve(repositoryPath, "guide.md"), "GUIDE-BODY-MARKER\n");
    recordProvider([
      ...["r1", "r2", "r3", "r4", "r5"].map((id, index) => readTurn(id, "guide.md", index + 1)),
      textTurn("Review complete."),
    ]);
    const harness = await createAuditHarness({ limits: SMALL_BOUNDS });
    const result = await harness.runStep(stepInput(repositoryPath));
    expect(result.summary).toBe("Review complete.");
  }, 120_000);

  it("delivers a parallel identical pair, the second as a full repeat", async () => {
    const repositoryPath = await createRepository();
    await writeFile(resolve(repositoryPath, "guide.md"), "GUIDE-BODY-MARKER\n");
    const delegated = recordProvider([
      toolTurn(
        [
          { id: "p1", name: "read", arguments: { path: "guide.md" } },
          { id: "p2", name: "read", arguments: { path: "guide.md" } },
        ],
        1,
      ),
      textTurn("Review complete."),
    ]);
    const harness = await createAuditHarness({ limits: SMALL_BOUNDS });
    const result = await harness.runStep(stepInput(repositoryPath));
    expect(result.summary).toBe("Review complete.");
    const results = delegated[1]!.messages
      .filter((message) => message.role === "tool")
      .map((message) => messageText(message.content));
    expect(results).toHaveLength(2);
    expect(results.every((text) => text.includes("GUIDE-BODY-MARKER"))).toBe(true);
    expect(results.filter((text) => text.includes(READ_EVIDENCE_NOTICE_PREFIX))).toHaveLength(1);
  }, 120_000);

  it("withholds a capped repeat only as the identical capped projection, and recall still works", async () => {
    const repositoryPath = await createRepository();
    await writeFile(
      resolve(repositoryPath, "big.md"),
      "BIG-HEAD-MARKER\n" + "filler line of documentation evidence\n".repeat(200),
    );
    const delegated = recordProvider([
      readTurn("c1", "big.md", 1),
      readTurn("c2", "big.md", 2),
      readTurn("c3", "big.md", 3),
      textTurn("Review complete."),
    ]);
    const harness = await createAuditHarness({
      toolOutputCapBytes: 1_024,
      limits: {
        environment: {
          DOCSFAB_EXECUTION_READ_LOOP_REPEAT_STREAK: "1",
          DOCSFAB_EXECUTION_READ_LOOP_WITHHELD_READS: "2",
        },
      },
    });
    const result = await harness.runStep(stepInput(repositoryPath));
    expect(result.summary).toBe("Review complete.");
    const first = lastToolResult(delegated[1]!);
    expect(first).toContain("BIG-HEAD-MARKER");
    expect(first).toContain("docsfab-output-cap");
    // The full repeat is the same capped projection plus the notice.
    expect(lastToolResult(delegated[2]!)).toContain(first);
    // The withheld repeat sends only the notice; the capped first delivery,
    // with its continuation marker, is still in the request.
    expect(lastToolResult(delegated[3]!)).not.toContain("BIG-HEAD-MARKER");
    expect(JSON.stringify(delegated[3]!.messages)).toContain("BIG-HEAD-MARKER");
  }, 120_000);

  it("never steers distinct files, however many are read", async () => {
    const repositoryPath = await createRepository();
    const paths = ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md"];
    for (const path of paths) await writeFile(resolve(repositoryPath, path), `body of ${path}\n`);
    const delegated = recordProvider([
      ...paths.map((path, index) => readTurn(`r${index}`, path, index + 1)),
      textTurn("Review complete."),
    ]);
    const harness = await createAuditHarness({ limits: SMALL_BOUNDS });
    const result = await harness.runStep(stepInput(repositoryPath));

    expect(result.summary).toBe("Review complete.");
    for (const request of delegated) {
      expect(JSON.stringify(request.messages)).not.toContain(READ_EVIDENCE_NOTICE_PREFIX);
    }
    expect(result.tools?.readEvidence).toBeUndefined();
  }, 120_000);

  it("re-delivers a file in full after a compaction removed it from the context", async () => {
    const repositoryPath = await createRepository();
    const alphaMarker = "ALPHA-EVIDENCE-MARKER";
    await writeFile(
      resolve(repositoryPath, "big-a.md"),
      `${alphaMarker} line of documentation evidence\n`.repeat(430),
    );
    await writeFile(
      resolve(repositoryPath, "big-b.md"),
      "bravo line of documentation evidence\n".repeat(430),
    );
    await writeFile(
      resolve(repositoryPath, "big-c.md"),
      "delta line of documentation evidence\n".repeat(430),
    );
    // A single-repeat streak, so without a new epoch the re-read below would be withheld.
    const delegated = recordProvider([
      readTurn("call_1", "big-a.md", 1),
      readTurn("call_2", "big-b.md", 2),
      readTurn("call_3", "big-c.md", 3),
      readTurn("call_4", "big-a.md", 4),
      textTurn("Review complete."),
    ]);
    const harness = await createAuditHarness({
      toolOutputCapBytes: 16_384,
      limits: {
        environment: {
          DOCSFAB_EXECUTION_READ_LOOP_REPEAT_STREAK: "1",
          DOCSFAB_EXECUTION_READ_LOOP_WITHHELD_READS: "1",
        },
      },
      model: {
        ...validModelConfig,
        profile: {
          ...validModelConfig.profile,
          contextWindow: 18_096,
          maxInputTokens: 18_096,
          maxOutputTokens: 2_048,
        },
      },
    });
    const result = await harness.runStep(stepInput(repositoryPath));

    expect((result.turns ?? []).map((turn) => turn.decision)).toEqual([
      "proceed",
      "proceed",
      "proceed",
      "compact",
      "proceed",
    ]);
    // The compaction dropped the first read; the re-read restores it in full.
    expect(JSON.stringify(delegated[3]!.messages)).not.toContain(alphaMarker);
    const reRead = lastToolResult(delegated[4]!);
    expect(reRead).toContain(alphaMarker);
    expect(reRead).not.toContain(READ_EVIDENCE_NOTICE_PREFIX);
  }, 120_000);

  // A complete host-preflighted batch reaches the read-loop checkpoint. A
  // mixed batch with an unregistered name must fail closed at turn_end.
  it.each([
    ["settled as observed", false],
    ["mixed unpreflighted batch", true],
  ] as const)(
    "handles unchanged re-reads under fresh call IDs (%s)",
    async (_label, mixedBatch) => {
      // Two calls per lease, and enough turns for three leases so the second
      // checkpoint is a renewal decision rather than the hard ceiling. The
      // default read-loop bounds leave the decision to the lease checkpoint.
      vi.stubEnv("DOCSFAB_COMPOSITION_EXECUTION_CALLS_PER_LEASE", "2");
      vi.stubEnv("DOCSFAB_COMPOSITION_EXECUTION_MAX_LEASES", "3");
      const run = async (secondLeasePath: string) => {
        const repositoryPath = await createRepository();
        await writeFile(resolve(repositoryPath, "guide.md"), "GUIDE-BODY-MARKER\n");
        await writeFile(resolve(repositoryPath, "other.md"), "OTHER-BODY\n");
        const secondLease = mixedBatch
          ? [
              toolTurn(
                [
                  { id: "s0", name: "read", arguments: { path: secondLeasePath } },
                  { id: "s1", name: "no_such_tool", arguments: {} },
                ],
                3,
              ),
            ]
          : [readTurn("s0", secondLeasePath, 3), readTurn("s1", "guide.md", 4)];
        const delegated = recordProvider([
          readTurn("r1", "guide.md", 1),
          readTurn("r2", "guide.md", 2),
          ...secondLease,
          textTurn("Review complete."),
        ]);
        const executionProfile = fixtureCompositionExecutionProfile({
          maxProviderTurns: 256,
          timeoutMs: 30_000,
          maxResponseBytes: 65_536,
        });
        const harness = new PiHarness({
          skillCrateDirectory,
          executionProfile,
          credential: { family: "nvidia-inference-api", apiKey: validModelConfig.apiKey },
          providerConnectionFactory: createProviderConnectionFactory({
            routeId: executionProfile.routeId,
            transport: executionProfile.transport,
          }),
        });
        return { harness, repositoryPath, delegated, turns: 2 + secondLease.length };
      };

      // Positive control: a second lease that brought a new file renews.
      const renewed = await run("other.md");
      if (mixedBatch) {
        const failure = await captureInferenceFailure(
          renewed.harness,
          stepInput(renewed.repositoryPath),
        );
        expect(failure.category).toBe("provider-terminal");
        expect(failure.message).toContain("unpreflighted tool result");
        expect(failure.evidence?.executionLease).toMatchObject({
          terminalReason: "evidence-preservation-required",
        });
        expect(failure.evidence?.tools.preExecutionRejections).toBeUndefined();
        expect(renewed.delegated).toHaveLength(renewed.turns);
        return;
      }
      const result = await renewed.harness.runStep(stepInput(renewed.repositoryPath));
      expect(result.summary).toBe("Review complete.");
      expect(result.executionLease?.checkpoints).toBeDefined();

      // A second lease of unchanged re-reads is not useful progress.
      const stalled = await run("guide.md");
      const failure = await captureInferenceFailure(
        stalled.harness,
        stepInput(stalled.repositoryPath),
      );
      expect(failure.category).toBe("no-progress");
      expect(failure.retryable).toBe(false);
      expect(failure.message).toContain(
        "The execution checkpoint stopped without a host renew: checkpoint-not-renewable.",
      );
      // The provider was never asked for the answer turn.
      expect(stalled.delegated).toHaveLength(stalled.turns);
      expect(failure.evidence?.usage).toMatchObject({
        input: expect.any(Number),
        output: expect.any(Number),
        total: expect.any(Number),
      });
      expect(failure.evidence?.usage?.turns).toBeGreaterThan(0);
      expect(failure.evidence?.turns?.length).toBeGreaterThan(0);
      expect(failure.evidence?.executionLease).toMatchObject({
        terminalReason: "checkpoint-not-renewable",
        terminalDisposition: "progress-stopped",
      });
    },
    120_000,
  );

  /**
   * The read that crosses the bound can also fill an execution lease. Then the
   * stop cannot settle on that turn; the lease renews and the next turn opens.
   * An answer there is evaluated, never discarded. A tool turn there ends the
   * attempt as no-progress. Either record decodes.
   */
  describe("when the crossing read also fills a lease", () => {
    async function crossOnCheckpoint(next: Response) {
      const repositoryPath = await createRepository();
      await writeFile(resolve(repositoryPath, "guide.md"), "GUIDE-BODY-MARKER\n");
      await writeFile(resolve(repositoryPath, "other.md"), "OTHER-BODY\n");
      const delegated = recordProvider([
        readTurn("r1", "other.md", 1),
        readTurn("r2", "guide.md", 2),
        readTurn("r3", "guide.md", 3),
        readTurn("r4", "guide.md", 4),
        // The fifth call is the third re-read of guide.md, past K+L = 2, and
        // it fills the five-call lease.
        readTurn("r5", "guide.md", 5),
        next,
        textTurn("Unexpected seventh turn."),
      ]);
      const executionProfile = fixtureCompositionExecutionProfile({
        maxProviderTurns: 256,
        timeoutMs: 30_000,
        maxResponseBytes: 65_536,
      });
      const harness = new PiHarness({
        skillCrateDirectory,
        executionProfile,
        limits: {
          environment: {
            DOCSFAB_COMPOSITION_EXECUTION_CALLS_PER_LEASE: "5",
            DOCSFAB_COMPOSITION_EXECUTION_MAX_LEASES: "3",
            DOCSFAB_EXECUTION_READ_LOOP_REPEAT_STREAK: "1",
            DOCSFAB_EXECUTION_READ_LOOP_WITHHELD_READS: "1",
          },
        },
        credential: { family: "nvidia-inference-api", apiKey: validModelConfig.apiKey },
        providerConnectionFactory: createProviderConnectionFactory({
          routeId: executionProfile.routeId,
          transport: executionProfile.transport,
        }),
      });
      const input = stepInput(repositoryPath);
      const execution = await executeInferenceStep({
        mode: input.step.mode,
        // These cases pin the stop itself, so the no-progress retry is off.
        policy: parseRetryPolicy({ DOCSFAB_READ_ONLY_MAX_NO_PROGRESS_RETRIES: "0" }),
        evidenceIdentity: input.evidenceIdentity,
        sleep: async () => {},
        execute: (attempt) => harness.runStep({ ...input, inferenceAttempt: attempt }),
      });
      return { execution, delegated };
    }

    it("evaluates the answer the notice asked for", async () => {
      const { execution, delegated } = await crossOnCheckpoint(textTurn("Review complete."));
      expect(delegated).toHaveLength(6);
      expect(JSON.stringify(delegated.at(-1))).toContain(READ_EVIDENCE_NOTICE_PREFIX);
      expect(execution.status).toBe("succeeded");
      if (execution.status !== "succeeded") throw new Error("expected a succeeded step");
      expect(execution.result.summary).toBe("Review complete.");
      expect(execution.result.tools?.readEvidence).toEqual({
        unchangedReReads: 3,
        withheld: 2,
        maxRepeatsOfOneResult: 3,
        maxUnchangedReReadsAcrossResults: 3,
      });
      expect(decodeInference(structuredClone(execution.evidence)).attempts[0]?.outcome).toBe(
        "succeeded",
      );
    }, 120_000);

    it("ends a further tool turn as no-progress, with no extra governed turn", async () => {
      const { execution, delegated } = await crossOnCheckpoint(readTurn("r6", "guide.md", 6));
      expect(delegated).toHaveLength(6);
      expect(execution.status).toBe("failed");
      if (execution.status !== "failed") throw new Error("expected a failed step");
      expect(execution.error.category).toBe("no-progress");
      const attempt = execution.evidence.attempts[0]!;
      expect(attempt.turns).toHaveLength(6);
      expect(attempt.executionLease).toMatchObject({
        providerTurns: 6,
        terminalDisposition: "progress-stopped",
      });
      expect(decodeInference(structuredClone(execution.evidence)).attempts[0]?.outcome).toBe(
        "no-progress",
      );
    }, 120_000);
  });

  /**
   * The lease contract requires a terminal record's reason to be the highest
   * one its state derives. In the last lease that is `lease-limit`, so the
   * read-loop stop takes its reason from the same derivation.
   */
  it.each([
    // [label, calls per lease and max leases (undefined: the default shape),
    //  provider turns, distinct reads first, reason, disposition]
    ["an operator-lowered single lease", ["100", "1"], 256, 0, "lease-limit", "budget-stopped"],
    ["the last of two leases", ["5", "2"], 256, 5, "lease-limit", "budget-stopped"],
    // The installed 128-turn compositions: 100 calls per lease, 2 leases.
    ["the last default lease", undefined, 128, 100, "lease-limit", "budget-stopped"],
    [
      "a lease that is not the last",
      ["5", "3"],
      256,
      5,
      "checkpoint-not-renewable",
      "progress-stopped",
    ],
  ] as const)(
    "ends a read loop in %s as no-progress with a record that decodes",
    async (_label, shape, maxProviderTurns, distinctReads, reason, disposition) => {
      const repositoryPath = await createRepository();
      await writeFile(resolve(repositoryPath, "guide.md"), "GUIDE-BODY-MARKER\n");
      for (let index = 0; index < distinctReads; index += 1) {
        await writeFile(resolve(repositoryPath, `n${index}.md`), `N${index}\n`);
      }
      const reads = [
        ...Array.from({ length: distinctReads }, (_, index) => `n${index}.md`),
        "guide.md",
        "guide.md",
        "guide.md",
        "guide.md",
      ];
      const delegated = recordProvider([
        ...reads.map((path, index) => readTurn(`r${index}`, path, index + 1)),
        textTurn("Unexpected answer turn."),
      ]);
      const executionProfile = fixtureCompositionExecutionProfile({
        maxProviderTurns,
        timeoutMs: 30_000,
        maxResponseBytes: 65_536,
      });
      const harness = new PiHarness({
        skillCrateDirectory,
        executionProfile,
        limits: {
          environment: {
            DOCSFAB_EXECUTION_READ_LOOP_REPEAT_STREAK: "1",
            DOCSFAB_EXECUTION_READ_LOOP_WITHHELD_READS: "1",
            ...(shape === undefined
              ? {}
              : {
                  DOCSFAB_COMPOSITION_EXECUTION_CALLS_PER_LEASE: shape[0],
                  DOCSFAB_COMPOSITION_EXECUTION_MAX_LEASES: shape[1],
                }),
          },
        },
        credential: { family: "nvidia-inference-api", apiKey: validModelConfig.apiKey },
        providerConnectionFactory: createProviderConnectionFactory({
          routeId: executionProfile.routeId,
          transport: executionProfile.transport,
        }),
      });
      const input = stepInput(repositoryPath);
      const execution = await executeInferenceStep({
        mode: input.step.mode,
        // These cases pin the stop itself, so the no-progress retry is off.
        policy: parseRetryPolicy({ DOCSFAB_READ_ONLY_MAX_NO_PROGRESS_RETRIES: "0" }),
        evidenceIdentity: input.evidenceIdentity,
        sleep: async () => {},
        execute: (attempt) => harness.runStep({ ...input, inferenceAttempt: attempt }),
      });

      expect(delegated).toHaveLength(reads.length);
      expect(execution.status).toBe("failed");
      if (execution.status !== "failed") throw new Error("expected a failed step");
      expect(execution.error.category).toBe("no-progress");
      const attempt = execution.evidence.attempts[0]!;
      expect(attempt.turns).toHaveLength(reads.length);
      expect(attempt.executionLease).toMatchObject({
        providerTurns: reads.length,
        terminalReason: reason,
        terminalDisposition: disposition,
      });
      expect(decodeInference(structuredClone(execution.evidence)).attempts[0]?.outcome).toBe(
        "no-progress",
      );
    },
    120_000,
  );
});
