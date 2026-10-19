// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The attempt's `answerSubmission` record (#1707) through every reader: the
 * shared validator, the record decoder, the lease migration, the run index
 * and its stored rows, and `docsfab why`. The attempt is written by the real
 * harness and retry writer, never built by hand, before it is read back.
 */
import { afterEach, describe, expect, it } from "vitest";

import { diagnoseRun } from "../src/diagnosis/engine.js";
import type { InferenceAttemptEvidence } from "../src/execution/contracts.js";
import type {
  QualityAnswerRecordCapabilityV1,
  QualityAnswerRecordProgressV1,
} from "../src/execution/contracts.js";
import { QUALITY_ANSWER_RECORD_TOOL_NAME } from "../src/harness/answer-submission.js";
import { attemptArtifactSha256 } from "../src/harness/pi-offline.js";
import { migrateLegacyInferenceAttemptEvidence } from "../src/execution/lease-contracts.js";
import { isInferenceAnswerSubmissionEvidence } from "../src/records/answer-submission-evidence.js";
import {
  RUN_INDEX_PROJECTION_REVISION,
  RUN_INDEX_QUERY_FIELDS,
  decodeRunIndexRow,
  projectRunIndexRows,
} from "../src/records/run-index.js";
import { decodeInference } from "../src/scorecard-record-decode.js";
import { parseRetryPolicy } from "../src/config/retry-policy.js";
import {
  createRepository,
  executeInferenceStep,
  resetSharedTestState,
  textTurn,
} from "./support/pi-harness-session-fixtures.js";
import {
  FIXTURE_REPORT,
  qualityStepInput,
  rawToolCallTurn,
  recordingProvider,
  submissionCall,
  toolPathHarness,
} from "./support/answer-submission-fixtures.js";

afterEach(resetSharedTestState);

const SUBMISSION = JSON.stringify({
  evaluation: { evaluation_id: "eval-1", overall_decision: "insufficient-evidence" },
  qualityScore: null,
});

function rebindTurnLedger(attempt: InferenceAttemptEvidence): void {
  const lease = attempt.executionLease!;
  Object.assign(lease.binding, {
    providerTurnLedgerSha256: attemptArtifactSha256(attempt.turns),
  });
  const { evidenceSha256: _old, ...body } = lease;
  Object.assign(lease, { evidenceSha256: attemptArtifactSha256(body) });
}

function recordsCapability() {
  const requiredKeys = ["dimension:one", "dimension:two"];
  let progress: QualityAnswerRecordProgressV1 = {
    requiredKeys,
    remainingKeys: [...requiredKeys],
    completedKeys: [],
    openSets: [],
    complete: false,
  };
  const callKeys = new Map<string, string>();
  let reportReady = false;
  const capability: QualityAnswerRecordCapabilityV1 = {
    answerNowProgress: () => progress,
    prepareBatch: async ({ toolCalls }) => {
      reportReady = false;
      for (const call of toolCalls) {
        if (!call.rawArguments) continue;
        const parsed = JSON.parse(call.rawArguments) as { key?: unknown };
        if (typeof parsed.key === "string") callKeys.set(call.toolCallId, parsed.key);
      }
    },
    receipt: (toolCallId) => ({
      status: "admitted",
      type: "dimension",
      key: callKeys.get(toolCallId) ?? "one",
      remaining: progress.remainingKeys,
      complete: false,
    }),
    settle: async ({ authorizedToolCallIds, successfulToolCallIds }) => {
      reportReady = false;
      const completed = new Set(progress.completedKeys);
      for (const id of successfulToolCallIds) {
        const key = callKeys.get(id);
        if (key) completed.add(`dimension:${key}`);
      }
      const remainingKeys = requiredKeys.filter((key) => !completed.has(key));
      progress = {
        requiredKeys,
        remainingKeys,
        completedKeys: [...completed],
        openSets: [],
        complete: remainingKeys.length === 0,
      };
      const terminalAuthorized = authorizedToolCallIds.at(-1);
      reportReady =
        progress.complete &&
        terminalAuthorized !== undefined &&
        successfulToolCallIds.includes(terminalAuthorized);
    },
    takeReportReadiness: () => {
      const ready = reportReady;
      reportReady = false;
      return ready;
    },
  };
  return { capability, progress: () => progress };
}

describe("isInferenceAnswerSubmissionEvidence", () => {
  const admitted = {
    path: "tool-call",
    reason: "recorded-route",
    submission: "admitted",
    reportTurn: "admitted",
  };

  it("admits each closed state that agrees with its path and reason", () => {
    expect(isInferenceAnswerSubmissionEvidence(admitted)).toBe(true);
    expect(
      isInferenceAnswerSubmissionEvidence({
        path: "text-final",
        reason: "operator-override",
        submission: "absent",
        reportTurn: "not-asked",
      }),
    ).toBe(true);
    expect(
      isInferenceAnswerSubmissionEvidence({
        path: "answer-records",
        reason: "record-ledger",
        submission: "not-applicable",
        reportTurn: "in-flight",
        reportInFlightBytes: 0,
      }),
    ).toBe(true);
    expect(
      isInferenceAnswerSubmissionEvidence({
        ...admitted,
        submission: "in-flight",
        reportTurn: "not-asked",
        submissionInFlightBytes: 12,
      }),
    ).toBe(true);
    expect(
      isInferenceAnswerSubmissionEvidence({
        ...admitted,
        reportTurn: "in-flight",
        reportInFlightBytes: 0,
      }),
    ).toBe(true);
    // How the admitted members arrived (#1707 v9).
    expect(
      isInferenceAnswerSubmissionEvidence({
        ...admitted,
        memberEncoding: { evaluation: "object", qualityScore: "null" },
      }),
    ).toBe(true);
    expect(
      isInferenceAnswerSubmissionEvidence({
        ...admitted,
        memberEncoding: { evaluation: "string", qualityScore: "string" },
        submissionInnerBytes: 96,
      }),
    ).toBe(true);
  });

  it.each([
    ["an unknown key", { ...admitted, note: "x" }],
    ["an unknown path", { ...admitted, path: "json-mode" }],
    ["a tool call for another reason", { ...admitted, reason: "not-recorded" }],
    [
      "records report with a non-ledger reason",
      {
        path: "answer-records",
        reason: "not-recorded",
        submission: "not-applicable",
        reportTurn: "admitted",
      },
    ],
    [
      "records report with an applicable submission state",
      {
        path: "answer-records",
        reason: "record-ledger",
        submission: "admitted",
        reportTurn: "admitted",
      },
    ],
    ["ordinary answer path with records-only reason", { ...admitted, reason: "record-ledger" }],
    [
      "a text answer with a submission",
      { ...admitted, path: "text-final", reason: "not-recorded" },
    ],
    ["a report asked before admission", { ...admitted, submission: "refused" }],
    [
      "in-flight without its bytes",
      { ...admitted, submission: "in-flight", reportTurn: "not-asked" },
    ],
    ["bytes without in-flight", { ...admitted, submissionInFlightBytes: 3 }],
    ["negative bytes", { ...admitted, reportTurn: "in-flight", reportInFlightBytes: -1 }],
    ["an array", [admitted]],
    [
      "a member encoding before admission",
      {
        ...admitted,
        submission: "refused",
        reportTurn: "not-asked",
        memberEncoding: { evaluation: "object", qualityScore: "null" },
      },
    ],
    [
      "an unknown member encoding",
      { ...admitted, memberEncoding: { evaluation: "array", qualityScore: "null" } },
    ],
    [
      "an extra member encoding key",
      {
        ...admitted,
        memberEncoding: { evaluation: "object", qualityScore: "null", reportMarkdown: "string" },
      },
    ],
    [
      "a string member without its inner bytes",
      { ...admitted, memberEncoding: { evaluation: "string", qualityScore: "null" } },
    ],
    [
      "inner bytes without a string member",
      {
        ...admitted,
        memberEncoding: { evaluation: "object", qualityScore: "null" },
        submissionInnerBytes: 4,
      },
    ],
    ["inner bytes without an encoding", { ...admitted, submissionInnerBytes: 4 }],
  ])("refuses %s", (_name, value) => {
    expect(isInferenceAnswerSubmissionEvidence(value)).toBe(false);
  });
});

describe("a tool-path attempt through every record reader", () => {
  it("is written by the harness and retry writer and decoded by each reader", async () => {
    const repositoryPath = await createRepository();
    const input = await qualityStepInput(repositoryPath);
    recordingProvider([
      rawToolCallTurn([submissionCall("submit-1", "[1]")]),
      rawToolCallTurn([submissionCall("submit-2", SUBMISSION)], { created: 2 }),
      textTurn(FIXTURE_REPORT),
    ]);
    const harness = toolPathHarness();

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

    expect(execution.status).toBe("succeeded");
    const [refused, admitted] = execution.evidence.attempts;
    expect(refused).toMatchObject({
      outcome: "malformed-response",
      retryRule: "retried-contract-correction",
      rejection: { code: "quality-submission-shape", location: "$" },
      answerSubmission: { submission: "refused", reportTurn: "not-asked" },
    });
    expect(refused?.turns?.at(-1)?.terminalPreExecutionRejections).toBe(1);
    expect(admitted?.answerSubmission).toEqual({
      path: "tool-call",
      reason: "recorded-route",
      submission: "admitted",
      reportTurn: "admitted",
      memberEncoding: { evaluation: "object", qualityScore: "null" },
    });

    // The record decoder keeps the field exactly.
    const decoded = decodeInference(structuredClone(execution.evidence));
    expect(decoded.attempts.map((attempt) => attempt.answerSubmission)).toEqual(
      execution.evidence.attempts.map((attempt) => attempt.answerSubmission),
    );
    const tamper = (change: (attempt: InferenceAttemptEvidence) => void) => {
      const changed = structuredClone(execution.evidence);
      const attempt = changed.attempts[0]!;
      change(attempt);
      rebindTurnLedger(attempt);
      expect(() => decodeInference(changed)).toThrow();
    };
    tamper((attempt) => {
      delete attempt.turns!.at(-1)!.terminalPreExecutionRejections;
    });
    tamper((attempt) => {
      attempt.turns!.at(-1)!.terminalPreExecutionRejections = 2;
    });
    tamper((attempt) => {
      attempt.rejection = undefined;
    });
    tamper((attempt) => {
      attempt.rejection = { code: "quality-submission-json", location: "$" };
    });
    // The lease migration reads attempts written before execution leases; it
    // admits the field and refuses a malformed one.
    const legacy = (attempt: InferenceAttemptEvidence) => {
      const { executionLease: _lease, ...rest } = structuredClone(attempt);
      return rest as InferenceAttemptEvidence;
    };
    for (const attempt of execution.evidence.attempts) {
      expect(() => migrateLegacyInferenceAttemptEvidence(legacy(attempt))).not.toThrow();
    }
    expect(() =>
      migrateLegacyInferenceAttemptEvidence({
        ...legacy(admitted!),
        answerSubmission: { path: "tool-call" },
      } as unknown as InferenceAttemptEvidence),
    ).toThrow();
    expect(() =>
      decodeInference({
        ...structuredClone(execution.evidence),
        attempts: [
          { ...structuredClone(refused!), answerSubmission: { path: "tool-call" } },
          structuredClone(admitted!),
        ] as never,
      }),
    ).toThrow();

    // The run index carries the four states on attempt rows.
    const rows = indexRows(runRecord(execution.evidence.attempts));
    const attemptRows = rows.filter((row) => row.rowKind === "attempt");
    expect(
      attemptRows.map((row) => [
        row.answerPath,
        row.answerPathReason,
        row.answerSubmission,
        row.answerReportTurn,
      ]),
    ).toEqual([
      ["tool-call", "recorded-route", "refused", "not-asked"],
      ["tool-call", "recorded-route", "admitted", "admitted"],
    ]);
    for (const row of rows.filter((candidate) => candidate.rowKind !== "attempt")) {
      expect(row.answerPath).toBeNull();
    }
  }, 60_000);

  it("binds only the final SDK-rejected submission after earlier rejected calls", async () => {
    const repositoryPath = await createRepository();
    const input = await qualityStepInput(repositoryPath);
    const unknown = (id: string) => ({ id, name: "no_such_tool", chunks: ["{}"] });
    recordingProvider([
      rawToolCallTurn([{ id: "executed-list", name: "ls", chunks: ['{"path":"."}'] }]),
      rawToolCallTurn([unknown("early-rejected")], { created: 2 }),
      rawToolCallTurn([submissionCall("terminal-refused", "[1]"), unknown("also-rejected")], {
        created: 3,
      }),
      rawToolCallTurn([submissionCall("retry-admitted", SUBMISSION)], { created: 4 }),
      textTurn(FIXTURE_REPORT),
    ]);
    const harness = toolPathHarness();
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

    expect(execution.status).toBe("succeeded");
    const refused = execution.evidence.attempts[0]!;
    expect(refused.tools.totalCalls).toBe(1);
    expect(refused.tools.preExecutionRejections?.count).toBe(3);
    expect(refused.turns?.map((turn) => turn.terminalPreExecutionRejections)).toEqual([
      undefined,
      undefined,
      2,
    ]);
    expect(refused.turns?.at(-1)?.toolCalls).toBe(2);
    expect(decodeInference(structuredClone(execution.evidence))).toEqual(execution.evidence);

    const undercounted = structuredClone(execution.evidence);
    const undercountedAttempt = undercounted.attempts[0]!;
    undercountedAttempt.turns![2]!.terminalPreExecutionRejections = 1;
    rebindTurnLedger(undercountedAttempt);
    expect(() => decodeInference(undercounted)).toThrow();

    const duplicated = structuredClone(execution.evidence);
    const duplicatedAttempt = duplicated.attempts[0]!;
    duplicatedAttempt.turns![0]!.terminalPreExecutionRejections = 2;
    rebindTurnLedger(duplicatedAttempt);
    expect(() => decodeInference(duplicated)).toThrow();

    const moved = structuredClone(execution.evidence);
    const movedAttempt = moved.attempts[0]!;
    movedAttempt.turns![0]!.terminalPreExecutionRejections = 2;
    delete movedAttempt.turns![2]!.terminalPreExecutionRejections;
    rebindTurnLedger(movedAttempt);
    expect(() => decodeInference(moved)).toThrow();
  }, 60_000);
});

describe("records-only report evidence through the shared decoder", () => {
  it("writes and decodes the host ledger path from real Pi output", async () => {
    const repositoryPath = await createRepository();
    const input = await qualityStepInput(repositoryPath);
    const { answerSubmission: _answerSubmission, ...recordsInput } = input;
    const state = recordsCapability();
    const recordCall = (id: string, key: string) => ({
      id,
      name: QUALITY_ANSWER_RECORD_TOOL_NAME,
      chunks: [JSON.stringify({ type: "dimension", key, record: { evidence: "fixture" } })],
    });
    recordingProvider([
      rawToolCallTurn([recordCall("record-one", "one"), recordCall("record-two", "two")]),
      textTurn(FIXTURE_REPORT),
    ]);
    const harness = toolPathHarness({ capability: null });

    const execution = await executeInferenceStep({
      mode: input.step.mode,
      policy: parseRetryPolicy({}),
      evidenceIdentity: input.evidenceIdentity,
      sleep: async () => {},
      execute: (attempt, responseCorrection) =>
        harness.runStep({
          ...recordsInput,
          qualityAnswerRecords: state.capability,
          qualityAnswerRecordCallCeiling: 2,
          qualityAnswerRecordProgress: state.progress,
          inferenceAttempt: attempt,
          retriesConsumed: attempt - 1,
          ...(responseCorrection ? { responseCorrection } : {}),
        }),
    });

    expect(execution.status).toBe("succeeded");
    expect(state.progress().complete).toBe(true);
    expect(state.capability.takeReportReadiness?.()).toBe(false);
    expect(execution.evidence.attempts[0]?.answerSubmission).toEqual({
      path: "answer-records",
      reason: "record-ledger",
      submission: "not-applicable",
      reportTurn: "admitted",
    });
    const decoded = decodeInference(structuredClone(execution.evidence));
    expect(decoded.attempts[0]?.answerSubmission).toEqual(
      execution.evidence.attempts[0]?.answerSubmission,
    );
  });
});

function runRecord(attempts: readonly unknown[]): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: "answer-path-run",
    workflow: "review-documentation",
    status: "failed",
    createdAt: "2026-10-02T12:00:00.000Z",
    steps: [
      {
        id: "evaluate-document-quality",
        status: "failed",
        skill: "evaluate-document-quality",
        inference: { attempts },
      },
    ],
  };
}

function indexRows(record: Record<string, unknown>) {
  const projection = projectRunIndexRows(record, {
    origin: "import",
    snapshotId: "snapshot-answer-path",
    indexedAt: "2026-10-02T12:00:00.000Z",
    recordSha256: "a".repeat(64),
    fieldMaxChars: 512,
  });
  if (!projection.ok) throw new Error(`record refused: ${projection.reason}`);
  return projection.rows;
}

const inFlight = {
  attempt: 1,
  outcome: "timeout",
  retryable: true,
  durationMs: 10,
  condition: "attempt-deadline",
  model: { provider: "nvidia-api-catalog", model: "nvidia/nemotron-3-super-120b-a12b" },
  answerSubmission: {
    path: "tool-call",
    reason: "recorded-route",
    submission: "in-flight",
    reportTurn: "not-asked",
    submissionInFlightBytes: 31_000,
  },
};

describe("the run index", () => {
  it("projects the answer-path query fields from revision 14", () => {
    expect(RUN_INDEX_PROJECTION_REVISION).toBeGreaterThanOrEqual(14);
    expect(RUN_INDEX_QUERY_FIELDS).toEqual(
      expect.arrayContaining([
        "answerPath",
        "answerPathReason",
        "answerSubmission",
        "answerReportTurn",
        "answerMemberEncoding",
      ]),
    );
  });

  it("carries each in-flight state, refuses a malformed record, and round-trips stored rows", () => {
    const reportInFlight = {
      ...inFlight,
      answerSubmission: {
        path: "tool-call",
        reason: "recorded-route",
        submission: "admitted",
        reportTurn: "in-flight",
        reportInFlightBytes: 120,
      },
    };
    const reading = { ...inFlight, answerSubmission: { ...inFlight.answerSubmission } };
    reading.answerSubmission = {
      path: "tool-call",
      reason: "recorded-route",
      submission: "absent",
      reportTurn: "not-asked",
    } as never;
    const rows = indexRows(runRecord([inFlight, reportInFlight, reading]));
    const attempts = rows.filter((row) => row.rowKind === "attempt");
    expect(attempts.map((row) => [row.answerSubmission, row.answerReportTurn])).toEqual([
      ["in-flight", "not-asked"],
      ["admitted", "in-flight"],
      ["absent", "not-asked"],
    ]);
    for (const row of rows) {
      expect(decodeRunIndexRow(JSON.parse(JSON.stringify(row)))).toEqual(row);
    }
    expect(attempts.map((row) => row.answerMemberEncoding)).toEqual([null, null, null]);
    const stringified = indexRows(
      runRecord([
        {
          ...inFlight,
          outcome: "succeeded",
          answerSubmission: {
            path: "tool-call",
            reason: "recorded-route",
            submission: "admitted",
            reportTurn: "admitted",
            memberEncoding: { evaluation: "string", qualityScore: "string" },
            submissionInnerBytes: 96,
          },
        },
      ]),
    ).find((row) => row.rowKind === "attempt")!;
    expect(stringified.answerMemberEncoding).toBe("string/string");
    expect(decodeRunIndexRow(JSON.parse(JSON.stringify(stringified)))).toEqual(stringified);
    const malformed = indexRows(
      runRecord([{ ...inFlight, answerSubmission: { path: "tool-call", submission: "maybe" } }]),
    ).find((row) => row.rowKind === "attempt")!;
    expect(malformed.answerPath).toBeNull();
    expect(malformed.omittedFields).toEqual(
      expect.arrayContaining([
        "answerPath",
        "answerPathReason",
        "answerSubmission",
        "answerReportTurn",
      ]),
    );
  });

  it("reads a stored row from before revision 12 with null answer-path fields", () => {
    const [row] = indexRows(runRecord([inFlight])).filter((item) => item.rowKind === "attempt");
    const {
      answerPath: _path,
      answerPathReason: _reason,
      answerSubmission: _submission,
      answerReportTurn: _report,
      ...older
    } = row!;
    expect(decodeRunIndexRow({ ...older, projectionRevision: 11 })).toMatchObject({
      answerPath: null,
      answerPathReason: null,
      answerSubmission: null,
      answerReportTurn: null,
    });
  });
});

describe("docsfab why", () => {
  function diagnosis(attempt: Record<string, unknown>) {
    const rows = indexRows(runRecord([attempt]));
    return diagnoseRun(rows, {
      location: { indexArgs: " --state-dir /state/runs", showArgs: " --state-dir /state/runs" },
      source: "run-index",
      population: rows,
      lookbackRuns: 20,
    });
  }

  it("names the answer path and both states on the attempt line", () => {
    const [finding] = diagnosis(inFlight).findings;
    expect(finding?.what).toContain(
      "(answer path tool-call, recorded-route; submission in-flight, report not-asked)",
    );
  });

  it("names an operator override as operator configuration", () => {
    const [finding] = diagnosis({
      ...inFlight,
      answerSubmission: {
        path: "text-final",
        reason: "operator-override",
        submission: "absent",
        reportTurn: "not-asked",
      },
    }).findings;
    expect(finding?.what).toContain(
      "(answer path text-final, set by operator configuration DOCSFAB_ANSWER_SUBMISSION=text-final)",
    );
  });

  it("names the text-answer remediation for a tool-path shape refusal", () => {
    const [finding] = diagnosis({
      ...inFlight,
      outcome: "malformed-response",
      condition: undefined,
      rejection: { code: "quality-submission-shape", location: "$.evaluation" },
      answerSubmission: {
        path: "tool-call",
        reason: "recorded-route",
        submission: "refused",
        reportTurn: "not-asked",
      },
    }).findings;
    expect(finding?.cause).toBe("reply-shape-rejected");
    expect(finding?.nextAction).toContain("DOCSFAB_ANSWER_SUBMISSION=text-final");
  });
});
