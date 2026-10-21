// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { limitDefinition } from "../src/config/limits.js";
import {
  EXECUTION_LEASE_DEFAULTS,
  resolveLeaseShapeForTurns,
} from "../src/execution/lease-contracts.js";
import { classifyAttemptRow, classifyRecordedFailure } from "../src/diagnosis/classify.js";
import {
  DIAGNOSIS_CAUSE_OWNERS,
  DIAGNOSIS_OWNER_CLASSES,
  type RunDiagnosisV1,
} from "../src/diagnosis/contracts.js";
import { formatRunDiagnosisLines } from "../src/diagnosis/render.js";
import {
  currentRunRows,
  diagnoseRun,
  newestRunIds,
  summarizeByModel,
  type DiagnosisLocation,
} from "../src/diagnosis/engine.js";
import {
  decodeRunIndexRow,
  projectRunIndexRows,
  type RunIndexRowV1,
} from "../src/records/run-index.js";
import { queryRunIndex } from "../src/records/run-index-query.js";
import { isHostBuiltQualityRejection } from "../src/workflow-execution/quality-rejection-retryability.js";
import { NIM_FIXTURE_EXPECTATIONS, nimFixtureRecords } from "./helpers/diagnosis-nim-fixture.js";

const LOCATION: DiagnosisLocation = {
  indexArgs: " --state-dir /state/runs",
  showArgs: " --state-dir /state/runs",
};
const COMMANDS = { whyJson: "docsfab why run --json", runsShow: "docsfab runs show run" };

function fixtureRows(): RunIndexRowV1[] {
  return nimFixtureRecords().flatMap((record, index) => {
    const projection = projectRunIndexRows(record, {
      origin: "import",
      snapshotId: `snapshot-${String(index)}`,
      indexedAt: "2026-09-30T17:00:00.000Z",
      recordSha256: "a".repeat(64),
      fieldMaxChars: 512,
    });
    if (!projection.ok) throw new Error(`fixture record refused: ${projection.reason}`);
    return [...projection.rows];
  });
}

/** Rows as a DocsFab indexed them before attempt rows carried whole-attempt totals. */
function withoutAttemptTotals(rows: readonly RunIndexRowV1[]): RunIndexRowV1[] {
  return rows.map((row) => ({
    ...row,
    attemptOutputTokens: null,
    continuations: null,
    firstFinishReason: null,
    answerOutputTokens: null,
  }));
}

function diagnoseAll(rows: readonly RunIndexRowV1[]) {
  const byRun = currentRunRows(rows);
  return newestRunIds(byRun).map((runId) =>
    diagnoseRun(byRun.get(runId) ?? [], {
      location: LOCATION,
      source: "run-index",
      population: rows,
      lookbackRuns: 20,
    }),
  );
}

/** A failing attempt row with every telemetry field unavailable unless named. */
function attemptRow(fields: Partial<RunIndexRowV1>): RunIndexRowV1 {
  const [row] = fixtureRows().filter(
    (candidate) => candidate.runId === "nim-super-stream-a" && candidate.rowKind === "attempt",
  );
  return {
    ...row!,
    outcome: "provider-terminal",
    rejectionCode: null,
    rejectionLocation: null,
    rejectedReplyParseCode: null,
    finishReason: null,
    outputTokens: null,
    outputAllowance: null,
    providerErrorClass: null,
    httpStatus: null,
    ...fields,
  };
}

describe("docsfab why diagnosis of the September 30, 2026 hosted Nemotron runs", () => {
  it("names each run's terminal cause and owner as the manual analysis did", () => {
    const diagnoses = diagnoseAll(fixtureRows());
    expect(diagnoses).toHaveLength(13);
    const terminal = Object.fromEntries(
      diagnoses.map((diagnosis) => {
        const finding = diagnosis.findings.find((candidate) => candidate.role === "terminal");
        return [diagnosis.runId, { ownerClass: finding?.ownerClass, cause: finding?.cause }];
      }),
    );
    expect(terminal).toEqual(NIM_FIXTURE_EXPECTATIONS);
  });

  it("keeps the earlier failures a terminal cause does not explain", () => {
    const diagnoses = diagnoseAll(fixtureRows());
    const omni = diagnoses.find((diagnosis) => diagnosis.runId === "nim-omni-content")!;
    const earlier = omni.findings
      .filter((finding) => finding.role === "contributing")
      .map((finding) => [finding.cause, finding.attempts, finding.recovered]);
    expect(earlier).toEqual([
      ["reply-not-json", [1], false],
      ["reply-content-rejected", [2], false],
      ["reply-cut-over-allowance", [3], false],
    ]);
    const ultra = diagnoses.find((diagnosis) => diagnosis.runId === "nim-ultra-composition")!;
    expect(
      ultra.findings
        .filter((finding) => finding.role === "contributing")
        .map((finding) => [finding.stepId, finding.cause, finding.attempts, finding.recovered]),
    ).toEqual([
      ["audit-documentation", "boundary-refusal", [1, 2, 3], true],
      ["derive-source-obligations", "boundary-refusal", [1], false],
      ["derive-source-obligations", "reply-not-json", [2, 3], false],
    ]);
  });

  it("counts recurrence with the exact clauses its printed runs query carries", () => {
    const rows = fixtureRows();
    const diagnoses = diagnoseAll(rows);
    const third = diagnoses.find((diagnosis) => diagnosis.runId === "nim-super-stream-c")!;
    const recurrence = third.findings[0]!.recurrence!;
    expect([recurrence.runs, recurrence.ofRuns, recurrence.clipped]).toEqual([3, 3, false]);
    expect(recurrence.firstSeen?.runId).toBe("nim-super-stream-a");
    // Re-run the printed command's clauses through the query engine.
    for (const [command, expected] of [
      [recurrence.query, recurrence.runs],
      [recurrence.denominatorQuery, recurrence.ofRuns],
    ] as const) {
      const where = new Map<string, string[]>();
      for (const match of command.matchAll(/--where (\S+?)=(\S+)/gu)) {
        where.set(match[1]!, [...(where.get(match[1]!) ?? []), match[2]!]);
      }
      const until = /--until (\S+)/u.exec(command)?.[1];
      const result = queryRunIndex(rows, {
        where: where as never,
        groupBy: [],
        ...(until ? { untilMs: Date.parse(until) } : {}),
      });
      expect(result.population.runs).toBe(expected);
    }
  });

  it("owns a reply continued past the allowance as output limit, with the shape as a second cause", () => {
    const superRun = diagnoseAll(fixtureRows()).find(
      (diagnosis) => diagnosis.runId === "nim-super-not-json",
    )!;
    const finding = superRun.findings[0]!;
    expect([finding.ownerClass, finding.cause]).toEqual([
      "output-limit",
      "reply-continued-over-allowance",
    ]);
    expect(finding.why).toContain(
      "produced 7062 output tokens against a per-request allowance of 4096",
    );
    expect(finding.evidence.attemptTotals).toEqual({
      outputTokens: 7062,
      allowance: 4096,
      continuations: 1,
    });
    expect(finding.alsoCause).toMatchObject({
      ownerClass: "contract-shape",
      cause: "reply-not-json",
    });
    expect(finding.nextAction).toContain("maxOutputTokens");
    expect(finding.alsoCause?.nextAction).toContain("JSON output");
    expect(finding.limitations).toEqual([]);
  });

  it("names both owners without asserting one when the row carries no output total", () => {
    const superRun = diagnoseAll(withoutAttemptTotals(fixtureRows())).find(
      (diagnosis) => diagnosis.runId === "nim-super-not-json",
    )!;
    const finding = superRun.findings[0]!;
    expect(finding.cause).toBe("reply-not-json");
    expect(finding.limitations).toContain("attempt-output-total-not-recorded");
    expect(finding.alsoCause).toMatchObject({
      ownerClass: "output-limit",
      cause: "reply-continued-over-allowance",
    });
  });

  it("keeps a reply under its allowance with no continuation as contract shape only", () => {
    const ultra = diagnoseAll(fixtureRows()).find(
      (diagnosis) => diagnosis.runId === "nim-ultra-composition",
    )!;
    const finding = ultra.findings[0]!;
    expect([finding.cause, finding.alsoCause, finding.limitations]).toEqual([
      "reply-not-json",
      null,
      [],
    ]);
  });

  it("counts recurrence below the window size, as N of M runs", () => {
    const superRun = diagnoseAll(fixtureRows()).find(
      (diagnosis) => diagnosis.runId === "nim-super-not-json",
    )!;
    expect(superRun.findings[0]!.recurrence).toMatchObject({ runs: 1, ofRuns: 6, clipped: false });
  });

  it("reports no recurrence for an attempt without provider or model", () => {
    const refused = diagnoseAll(fixtureRows()).find(
      (diagnosis) => diagnosis.runId === "nim-endpoint-refused",
    )!;
    expect(refused.findings[0]!.recurrence).toBeNull();
    expect(refused.findings[0]!.limitations).toContain("recurrence-model-unavailable");
  });

  it("windows recurrence to the newest lookback runs and says so", () => {
    const rows = fixtureRows();
    const byRun = currentRunRows(rows);
    const diagnosis = diagnoseRun(byRun.get("nim-super-stream-c") ?? [], {
      location: LOCATION,
      source: "run-index",
      population: rows,
      lookbackRuns: 2,
    });
    const recurrence = diagnosis.findings[0]!.recurrence!;
    expect(recurrence).toMatchObject({ runs: 2, ofRuns: 2, clipped: true, lookbackRuns: 2 });
    expect(recurrence.query).toContain("--since 2026-09-30T13:07:09.880Z");
    // First seen still reads the whole index, not the window.
    expect(recurrence.firstSeen?.runId).toBe("nim-super-stream-a");
  });

  it("summarizes causes per provider and model", () => {
    const rows = fixtureRows();
    const summary = summarizeByModel(diagnoseAll(rows), currentRunRows(rows));
    const superCompatible = summary.find(
      (entry) =>
        entry.provider === "operator-configured-openai-compatible" &&
        entry.model === "nvidia/nemotron-3-super-120b-a12b",
    )!;
    expect(superCompatible.runs).toBe(6);
    // A model-free lint step does not add a run under an unavailable model.
    expect(summary.filter((entry) => entry.model === null).map((entry) => entry.runs)).toEqual([1]);
    expect(
      superCompatible.causes
        .filter((cause) => cause.role === "terminal")
        .map((cause) => [cause.cause, cause.runs]),
    ).toEqual([
      ["provider-stream-error", 5],
      ["reply-continued-over-allowance", 1],
    ]);
  });

  it("names a step that failed after its final attempt succeeded as the step's own failure", () => {
    const failure = { class: "unknown", layer: "workflow", code: "uncoded-error" };
    const projection = projectRunIndexRows(
      {
        schemaVersion: 2,
        id: "run-step-own-failure",
        workflow: "restructure-documentation",
        status: "failed",
        createdAt: "2026-10-01T09:00:00.000Z",
        failure,
        steps: [
          {
            id: "audit-documentation",
            status: "failed",
            failure,
            inference: {
              attempts: [
                {
                  attempt: 1,
                  outcome: "succeeded",
                  retryable: false,
                  durationMs: 1,
                  model: { provider: "fixture-provider", model: "fixture/model-a" },
                },
              ],
            },
          },
        ],
      },
      {
        origin: "import",
        snapshotId: "snapshot-step-own-failure",
        indexedAt: "2026-10-01T09:00:00.000Z",
        recordSha256: "a".repeat(64),
        fieldMaxChars: 512,
      },
    );
    if (!projection.ok) throw new Error(`fixture record refused: ${projection.reason}`);
    const diagnosis = diagnoseRun(projection.rows, {
      location: LOCATION,
      source: "record",
      population: null,
      lookbackRuns: 20,
    });
    expect(diagnosis.findings).toHaveLength(1);
    expect(diagnosis.findings[0]).toMatchObject({
      role: "terminal",
      stepId: "audit-documentation",
      what: "Step audit-documentation ended failed after its final attempt succeeded, with failure code uncoded-error.",
      evidence: { rowKind: "step", failureClass: "unknown", failureLayer: "workflow" },
    });
  });

  it("leads with the step's own refusal and lists the retried attempt as recovered", () => {
    // The shape of #1735's live create run 262c15aa: attempt 1 refused and
    // retried, attempt 2 succeeded, then the planner refusal ended the step.
    const failure = { class: "planning-refusal", layer: "workflow", code: "create-target-exists" };
    const model = { provider: "fixture-provider", model: "fixture/model-a" };
    const projection = projectRunIndexRows(
      {
        schemaVersion: 2,
        id: "run-create-target-exists",
        workflow: "create-documentation",
        status: "failed",
        createdAt: "2026-10-01T15:27:35.318Z",
        failure,
        steps: [
          {
            id: "plan-documentation",
            status: "failed",
            failure,
            inference: {
              attempts: [
                {
                  attempt: 1,
                  outcome: "malformed-response",
                  retryable: true,
                  retryScheduled: true,
                  conditionRetryability: "eligible",
                  retryDecision: "retried",
                  durationMs: 1,
                  model,
                  rejection: { code: "invalid-json", location: "$" },
                },
                { attempt: 2, outcome: "succeeded", retryable: false, durationMs: 1, model },
              ],
            },
          },
          { id: "derive-source-obligations", status: "pending" },
        ],
      },
      {
        origin: "import",
        snapshotId: "snapshot-create-target-exists",
        indexedAt: "2026-10-01T15:30:00.000Z",
        recordSha256: "a".repeat(64),
        fieldMaxChars: 512,
      },
    );
    if (!projection.ok) throw new Error(`fixture record refused: ${projection.reason}`);
    const diagnosis = diagnoseRun(projection.rows, {
      location: LOCATION,
      source: "record",
      population: null,
      lookbackRuns: 20,
    });
    const [terminal, ...rest] = diagnosis.findings;
    expect(terminal).toMatchObject({
      role: "terminal",
      stepId: "plan-documentation",
      evidence: { rowKind: "step", failureClass: "planning-refusal" },
    });
    expect(terminal!.why).toContain("(code create-target-exists)");
    expect(rest).toMatchObject([
      { role: "contributing", attempts: [1], cause: "reply-shape-rejected", recovered: true },
    ]);
    expect(formatRunDiagnosisLines(diagnosis, { location: LOCATION }).join("\n")).toContain(
      "Also: step plan-documentation attempt 1: contract shape (reply-shape-rejected); a later attempt succeeded, but the step then ended on the cause above.",
    );
  });

  it("reports recurrence as unread when the index could not be read", () => {
    const byRun = currentRunRows(fixtureRows());
    const diagnosis = diagnoseRun(byRun.get("nim-ultra-truncated") ?? [], {
      location: LOCATION,
      source: "record",
      population: null,
      lookbackRuns: 20,
    });
    expect(diagnosis.findings[0]!.recurrence).toBeNull();
    expect(diagnosis.findings[0]!.limitations).toContain("recurrence-index-unread");
  });
});

describe("recorded input and human-decision stops", () => {
  function stopRows(
    status: "needs-input" | "needs-human-decision",
    steps: readonly Record<string, unknown>[],
    id = `stop-${status}`,
  ): RunIndexRowV1[] {
    const record = {
      schemaVersion: 2,
      id,
      workflow: "review-documentation",
      repository: {
        sourcePath: "/synthetic/source",
        requestedRevision: "HEAD",
        revision: "a".repeat(40),
      },
      workspace: { strategy: "tracked-export", disposable: true },
      status,
      createdAt: "2026-10-09T00:00:00.000Z",
      models: [],
      skills: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
      tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
      steps,
    };
    const projection = projectRunIndexRows(record, {
      origin: "import",
      snapshotId: `snapshot-${id}`,
      indexedAt: "2026-10-09T00:00:00.000Z",
      recordSha256: "a".repeat(64),
      fieldMaxChars: 512,
    });
    if (!projection.ok) throw new Error(projection.reason);
    return [...projection.rows];
  }

  function diagnose(rows: readonly RunIndexRowV1[]) {
    return diagnoseRun(rows, {
      location: LOCATION,
      source: "run-index",
      population: rows,
      lookbackRuns: 20,
    });
  }

  it("keeps a no-step input stop separate from failure findings", () => {
    const rows = stopRows("needs-input", []);
    const diagnosis = diagnose(rows);
    expect(diagnosis).toMatchObject({
      verdict: "incomplete",
      findings: [],
      stop: {
        status: "needs-input",
        stepId: null,
        admission: "unknown",
        limitations: [
          "stop-detail-unavailable",
          "stop-step-unavailable",
          "stop-admission-unavailable",
        ],
      },
    });
    expect(diagnosis.summary).toContain("needs-input");
    expect(diagnosis.summary).not.toContain("without a failing step");
    expect(formatRunDiagnosisLines(diagnosis, { location: LOCATION }).join("\n")).toContain(
      "Stop: needs-input; admission unknown.",
    );
    expect(
      summarizeByModel([diagnosis], new Map([[diagnosis.runId, rows]])).every(
        (entry) => entry.failedRuns === 0 && entry.causes.length === 0,
      ),
    ).toBe(true);
  });

  it("selects one coherent stopped step and rejects conflicting terminal evidence", () => {
    const one = stopRows("needs-human-decision", [
      {
        id: "review-gate",
        status: "needs-human-decision",
        skill: "review-gate",
        inference: { attempts: [] },
      },
    ]);
    expect(diagnose(one).stop).toMatchObject({
      status: "needs-human-decision",
      stepId: "review-gate",
      stepIndex: 0,
      admission: "unknown",
    });
    const ambiguous = stopRows(
      "needs-human-decision",
      [
        { id: "first", status: "needs-human-decision", inference: { attempts: [] } },
        { id: "second", status: "needs-human-decision", inference: { attempts: [] } },
      ],
      "stop-ambiguous",
    );
    expect(diagnose(ambiguous).stop).toMatchObject({
      stepId: null,
      limitations: ["stop-detail-unavailable", "stop-step-ambiguous"],
    });
    const inconsistent = one.map((row) =>
      row.rowKind === "run" ? { ...row, terminalStepId: "different" } : row,
    );
    expect(diagnose(inconsistent).stop).toMatchObject({
      stepId: null,
      limitations: ["stop-detail-unavailable", "stop-step-inconsistent"],
    });
    const admissionConflict = one.map((row) =>
      row.rowKind === "run" ? { ...row, intentAdmission: "question" as const } : row,
    );
    expect(diagnose(admissionConflict).stop).toMatchObject({
      stepId: null,
      admission: "unknown",
      limitations: ["stop-detail-unavailable", "stop-step-inconsistent"],
    });
    const absent = stopRows(
      "needs-input",
      [{ id: "done", status: "succeeded", inference: { attempts: [] } }],
      "stop-no-terminal-step",
    );
    expect(diagnose(absent).stop).toMatchObject({
      stepId: null,
      limitations: ["stop-detail-unavailable", "stop-step-inconsistent"],
    });
  });

  it("keeps genuine failed attempts contributing without making the gate a model failure", () => {
    for (const laterSucceeded of [false, true]) {
      const rows = stopRows(
        "needs-human-decision",
        [{ id: "gate", status: "needs-human-decision", inference: { attempts: [] } }],
        `stop-attempt-${String(laterSucceeded)}`,
      );
      const step = rows.find((row) => row.rowKind === "step")!;
      const failed = attemptRow({
        ...step,
        rowKind: "attempt",
        attempt: 1,
        finalAttempt: !laterSucceeded,
        outcome: "malformed-response",
        provider: "fixture-provider",
        model: "fixture-model",
        rejectionCode: null,
      });
      const succeeded = { ...failed, attempt: 2, finalAttempt: true, outcome: "succeeded" };
      const diagnosis = diagnose([...rows, failed, ...(laterSucceeded ? [succeeded] : [])]);
      expect(diagnosis.stop?.status).toBe("needs-human-decision");
      expect(diagnosis.findings).toHaveLength(1);
      expect(diagnosis.findings[0]).toMatchObject({
        role: "contributing",
        attempts: [1],
        recovered: laterSucceeded,
      });
      const models = summarizeByModel(
        [diagnosis],
        new Map([[diagnosis.runId, [...rows, failed, ...(laterSucceeded ? [succeeded] : [])]]]),
      );
      expect(
        models.every(
          (entry) =>
            entry.failedRuns === 0 && entry.causes.every((cause) => cause.role === "contributing"),
        ),
      ).toBe(true);
      const text = formatRunDiagnosisLines(diagnosis, { location: LOCATION }).join("\n");
      if (laterSucceeded) {
        expect(text).toContain("a later attempt succeeded, but the run then stopped");
        expect(text).not.toContain("the step later succeeded");
      } else {
        expect(text).toContain("the step did not recover from it");
      }
    }
  });

  it("keeps other statuses null and renders older objects with no stop property", () => {
    const source = stopRows("needs-input", []);
    for (const status of ["failed", "succeeded", "queued", "running"]) {
      const rows = source.map((row) => ({
        ...row,
        runStatus: status,
        ...(row.rowKind === "run" ? { outcome: status } : {}),
      }));
      expect(diagnose(rows).stop).toBeNull();
    }
    const current = diagnose(source);
    const { stop: _stop, ...older } = current;
    expect(() =>
      formatRunDiagnosisLines(older as RunDiagnosisV1, { location: LOCATION }),
    ).not.toThrow();
    expect(
      formatRunDiagnosisLines({ ...current, stop: null }, { location: LOCATION }).join("\n"),
    ).not.toContain("Stop:");
  });
});

describe("diagnosis attempt classifier", () => {
  it("limits search pre-inference wording to the failed step after an earlier inference", () => {
    const record = {
      schemaVersion: 2,
      id: "search-after-inference",
      workflow: "review-documentation",
      repository: {
        sourcePath: "/synthetic/source",
        requestedRevision: "HEAD",
        revision: "a".repeat(40),
      },
      workspace: { strategy: "tracked-export", disposable: true },
      status: "failed",
      failure: {
        class: "contract-shape",
        layer: "workflow",
        code: "workflow-search-contract-failed",
      },
      createdAt: "2026-10-09T00:00:00.000Z",
      models: [],
      skills: [],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, turns: 1 },
      tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
      steps: [
        {
          id: "first-inference",
          status: "succeeded",
          inference: {
            attempts: [{ attempt: 1, outcome: "succeeded", retryable: false, durationMs: 1 }],
          },
        },
        {
          id: "search-step",
          status: "failed",
          failure: {
            class: "contract-shape",
            layer: "workflow",
            code: "workflow-search-contract-failed",
          },
          error: "Governed workflow search could not be completed.",
        },
      ],
    };
    const projection = projectRunIndexRows(record, {
      origin: "import",
      snapshotId: "search-after-inference",
      indexedAt: record.createdAt,
      recordSha256: "a".repeat(64),
      fieldMaxChars: 512,
    });
    if (!projection.ok) throw new Error(projection.reason);
    const rows = [...projection.rows];
    expect(rows.some((row) => row.rowKind === "attempt" && row.outcome === "succeeded")).toBe(true);
    const diagnosis = diagnoseRun(rows, {
      location: LOCATION,
      source: "run-index",
      population: rows,
      lookbackRuns: 20,
    });
    const text = formatRunDiagnosisLines(diagnosis, { location: LOCATION }).join("\n");
    expect(diagnosis.findings[0]?.stepId).toBe("search-step");
    expect(text).toContain("before this step's inference");
    expect(text).not.toContain("before any model call");
  });

  it("gives every cause exactly one declared owner class", () => {
    for (const owner of Object.values(DIAGNOSIS_CAUSE_OWNERS)) {
      expect(DIAGNOSIS_OWNER_CLASSES).toContain(owner);
    }
  });

  it.each([
    [{ httpStatus: 410, providerErrorClass: "invalid-request" }, "provider-model-retired"],
    [{ httpStatus: 429, providerErrorClass: "rate-limit" }, "provider-rate-limited"],
    [{ httpStatus: 503, providerErrorClass: "server" }, "provider-server-error"],
    [{ httpStatus: 401, providerErrorClass: "auth" }, "provider-auth-refused"],
    [{ httpStatus: 404, providerErrorClass: "invalid-request" }, "provider-request-refused"],
    [{ providerErrorClass: "unknown", finishReason: "error" }, "provider-stream-error"],
    [{ providerErrorClass: "network", finishReason: "error" }, "provider-unavailable"],
    [{ providerErrorClass: "unreachable", finishReason: "error" }, "provider-endpoint-unreachable"],
    [
      { providerErrorClass: "stream-incomplete", finishReason: "error" },
      "provider-stream-incomplete",
    ],
    [{ finishReason: "error", outputAllowance: 8192 }, "boundary-refusal"],
    [{ model: null, provider: null }, "request-not-sent"],
    [{ outcome: "context-exhausted" }, "context-window-exhausted"],
    [{ outcome: "blank-response" }, "reply-blank"],
  ] as const)("reads %j as %s", (fields, cause) => {
    expect(classifyAttemptRow(attemptRow(fields as Partial<RunIndexRowV1>), COMMANDS).cause).toBe(
      cause,
    );
  });

  it("owns a refusal of a value DocsFab built as a DocsFab defect, not the model's shape", () => {
    // The retryability table marks this code host-built; its failure class reads as shape.
    expect(isHostBuiltQualityRejection("candidate-selection-mismatch")).toBe(true);
    const stepRow = {
      ...attemptRow({}),
      rowKind: "step" as const,
      attempt: null,
      outcome: "failed",
      failureClass: "contract-shape" as const,
      failureLayer: "workflow" as const,
      rejectionSource: "quality-validation" as const,
      rejectionCode: "candidate-selection-mismatch",
      rejectionLocation: "$.selectionSha256",
    };
    const hostBuilt = classifyRecordedFailure(stepRow, COMMANDS);
    expect([DIAGNOSIS_CAUSE_OWNERS[hostBuilt.cause], hostBuilt.cause]).toEqual([
      "docsfab-defect",
      "host-built-value-refused",
    ]);
    expect(hostBuilt.nextCommand).toBe(COMMANDS.whyJson);
    const onAttempt = classifyAttemptRow(
      attemptRow({
        outcome: "malformed-response",
        rejectionCode: "candidate-selection-mismatch",
        rejectedReplyParseCode: "parsed",
      }),
      COMMANDS,
    );
    expect(onAttempt.cause).toBe("host-built-value-refused");

    // A contract-shape code the evaluator authored stays the model's shape, and
    // another terminal refusal, such as a security refusal, is not host-built.
    expect(isHostBuiltQualityRejection("evaluation-schema-required")).toBe(false);
    expect(isHostBuiltQualityRejection("candidate-credential-material")).toBe(false);
    const modelAuthored = classifyRecordedFailure(
      { ...stepRow, rejectionCode: "evaluation-schema-required", rejectionLocation: "$" },
      COMMANDS,
    );
    expect(modelAuthored.cause).toBe("reply-shape-rejected");
    expect(
      classifyAttemptRow(
        attemptRow({
          outcome: "malformed-response",
          rejectionCode: "candidate-evaluation-shape",
          rejectedReplyParseCode: "parsed",
        }),
        COMMANDS,
      ).cause,
    ).toBe("reply-shape-rejected");
  });

  it("reads a cut at the allowance before the rejection code it produced", () => {
    const reading = classifyAttemptRow(
      attemptRow({
        outcome: "malformed-response",
        rejectionCode: "invalid-json",
        rejectionLocation: "$",
        rejectedReplyParseCode: "json-unexpected-end",
        finishReason: "length",
        outputTokens: 4096,
        outputAllowance: 4096,
      }),
      COMMANDS,
    );
    expect([reading.ownerClass, reading.cause]).toEqual([
      "output-limit",
      "output-allowance-reached",
    ]);
  });

  describe("a size bound on a reply that did not reach its output allowance", () => {
    /** Run 549a2968's terminal attempt: finish stop, 392 of 16384 tokens. */
    const stoppedUnderAllowance = {
      outcome: "malformed-response",
      rejectionLocation: "$response",
      rejectedReplyParseCode: "parsed",
      finishReason: "stop",
      outputTokens: 392,
      outputAllowance: 16384,
    } as const;

    it("does not blame the output allowance for an outer bounds-exceeded", () => {
      const reading = classifyAttemptRow(
        attemptRow({ ...stoppedUnderAllowance, rejectionCode: "bounds-exceeded" }),
        COMMANDS,
      );

      expect([reading.ownerClass, reading.cause]).toEqual([
        "operator-configuration",
        "operational-limit-reached",
      ]);
      expect(reading.why).toBe(
        "The reply was refused by bounds-exceeded at $response, a configured size or count bound, not the output allowance: finish reason stop, 392 of 16384 output tokens.",
      );
      expect(reading.nextAction).not.toMatch(/maxOutputTokens/u);
      expect(reading.nextCommand).toBe(COMMANDS.runsShow);
    });

    it("does not prescribe output tokens for another bound code under the allowance", () => {
      const reading = classifyAttemptRow(
        attemptRow({
          ...stoppedUnderAllowance,
          rejectionCode: "fact-inventory-limitations-exceeded",
        }),
        COMMANDS,
      );

      expect([reading.ownerClass, reading.cause]).toEqual([
        "operator-configuration",
        "operational-limit-reached",
      ]);
      expect(reading.why).toContain("fact-inventory-limitations-exceeded");
      expect(reading.nextAction).not.toMatch(/maxOutputTokens/u);
      expect(reading.nextCommand).toBe(COMMANDS.runsShow);
    });

    it("names the review scope bound its code records, with the bound's remediation", () => {
      const bound = limitDefinition("technicalCorrection.proposalMaxBytes");
      const reading = classifyAttemptRow(
        attemptRow({
          ...stoppedUnderAllowance,
          rejectionCode: "technical-correction-proposal-max-bytes-bound",
        }),
        COMMANDS,
      );

      expect(reading.cause).toBe("operational-limit-reached");
      expect(reading.why).toBe(
        "The attempt stopped at technicalCorrection.proposalMaxBytes = 262144 bytes (technical-correction-proposal-max-bytes-bound at $response). The output allowance did not bind: finish reason stop, 392 of 16384 output tokens. The saved run's failure names the observed value.",
      );
      expect(reading.nextAction).toBe(bound.remediation);
    });

    it("names the bound for a run refused at run start", () => {
      const reading = classifyRecordedFailure(
        {
          ...attemptRow({}),
          rowKind: "run",
          outcome: "failed",
          failureClass: "bound",
          failureLayer: "workflow",
          failureCode: "technical-correction-proposal-max-bytes-bound",
        },
        COMMANDS,
      );

      expect(reading.cause).toBe("operational-limit-reached");
      expect(reading.why).toBe(
        "The run stopped at technicalCorrection.proposalMaxBytes = 262144 bytes (technical-correction-proposal-max-bytes-bound). The saved run's failure names the observed value.",
      );
      expect(reading.nextAction).toBe(
        limitDefinition("technicalCorrection.proposalMaxBytes").remediation,
      );
    });

    it("does not say the allowance did not bind when the step's reply finished at length", () => {
      const reading = classifyRecordedFailure(
        {
          ...attemptRow({
            ...stoppedUnderAllowance,
            rejectionCode: "technical-correction-proposal-max-bytes-bound",
            finishReason: "length",
          }),
          rowKind: "step",
          outcome: "failed",
          failureClass: "bound",
          failureLayer: "inference",
        },
        COMMANDS,
      );

      expect(reading.cause).toBe("operational-limit-reached");
      expect(reading.why).toBe(
        `Step ${attemptRow({}).stepId} stopped at technicalCorrection.proposalMaxBytes = 262144 bytes (technical-correction-proposal-max-bytes-bound at $response). The saved run's failure names the observed value.`,
      );
    });

    it("keeps the output allowance as the cause when the reply used all of it", () => {
      const reading = classifyAttemptRow(
        attemptRow({
          ...stoppedUnderAllowance,
          rejectionCode: "bounds-exceeded",
          outputTokens: 16384,
        }),
        COMMANDS,
      );

      expect(reading.cause).toBe("output-allowance-reached");
    });

    it("keeps the output allowance as the cause when finish reason is length under the reported token count", () => {
      const reading = classifyAttemptRow(
        attemptRow({
          ...stoppedUnderAllowance,
          rejectionCode: "bounds-exceeded",
          finishReason: "length",
        }),
        COMMANDS,
      );

      expect([reading.ownerClass, reading.cause]).toEqual([
        "output-limit",
        "output-allowance-reached",
      ]);
      expect(reading.nextAction).toMatch(/maxOutputTokens/u);
    });
  });

  it("names an uncatalogued rejection code as a DocsFab defect", () => {
    const reading = classifyAttemptRow(
      attemptRow({ outcome: "malformed-response", rejectionCode: "uncatalogued-probe-code" }),
      COMMANDS,
    );
    expect([reading.ownerClass, reading.cause]).toEqual(["docsfab-defect", "uncatalogued-failure"]);
  });

  it("uses an in-stream status when the index carries one", () => {
    const row = {
      ...attemptRow({ providerErrorClass: "server", finishReason: "error" }),
      streamErrorStatus: 503,
    } as RunIndexRowV1;
    const reading = classifyAttemptRow(row, COMMANDS);
    expect(reading.cause).toBe("provider-stream-error");
    expect(reading.why).toContain("the stream declared status 503");
    expect(reading.limitations).toEqual([]);
  });

  describe("progress stops (read loops and execution ceilings)", () => {
    const READ_LOOP_ONE_RESULT = "execution-read-loop-withheld-reads-bound";
    const READ_LOOP_ACROSS = "execution-read-loop-unchanged-re-reads-bound";
    const TOOL_CEILING = "composition-execution-max-tool-calls-per-step-bound";
    const SEALED_TURNS = "sealed-composition-execution-max-provider-turns-bound";
    const HOST_TURNS = "composition-execution-max-provider-turns-bound";

    it("names a read-loop stop as model progress, never an uncatalogued code", () => {
      // Ultra 18a12295, test-audience-understanding attempt 1.
      const oneResult = classifyAttemptRow(
        attemptRow({
          outcome: "no-progress",
          rejectionCode: READ_LOOP_ONE_RESULT,
          rejectionLocation: "$.tools",
          failureClass: "bound",
          failureCode: READ_LOOP_ONE_RESULT,
          unchangedReReads: 17,
          readLoopWithheld: 9,
          maxRepeatsOfOneResult: 17,
          maxUnchangedReReadsAcrossResults: null,
        }),
        COMMANDS,
      );
      expect([oneResult.ownerClass, oneResult.cause]).toEqual([
        "model-progress",
        "read-loop-stopped",
      ]);
      expect(oneResult.why).toBe(
        `DocsFab ended the attempt as no-progress (${READ_LOOP_ONE_RESULT}): the model kept re-reading a result it already had, unchanged, instead of answering. It re-read one unchanged result 17 times with no progress call between (17 unchanged re-reads in the attempt).`,
      );
      expect(oneResult.signature).toEqual({
        outcome: "no-progress",
        rejectionCode: READ_LOOP_ONE_RESULT,
      });

      const across = classifyAttemptRow(
        attemptRow({
          outcome: "no-progress",
          rejectionCode: READ_LOOP_ACROSS,
          rejectionLocation: "$.tools",
          unchangedReReads: 25,
          readLoopWithheld: 9,
          maxRepeatsOfOneResult: 4,
          maxUnchangedReReadsAcrossResults: 25,
        }),
        COMMANDS,
      );
      expect(across.cause).toBe("read-loop-stopped");
      expect(across.why).toContain(
        "It made 25 unchanged re-reads with no progress call between, at most 4 of any one result.",
      );
      // A row indexed before the counters still names the cause, without numbers.
      const bare = classifyAttemptRow(
        attemptRow({ outcome: "no-progress", rejectionCode: READ_LOOP_ACROSS }),
        COMMANDS,
      );
      expect(bare.cause).toBe("read-loop-stopped");
      expect(bare.why).not.toContain("It re-read");
    });

    it("names a ceiling fitted to the sealed composition budget as model progress", () => {
      // Super 62f25796: the tool-call ceiling of 126 fitted to the sealed budget.
      const attempt = classifyAttemptRow(
        attemptRow({
          outcome: "no-progress",
          failureClass: "bound",
          failureLayer: "inference",
          failureCode: TOOL_CEILING,
          unchangedReReads: 84,
          executionCeilingSource: "sealed-budget",
        }),
        COMMANDS,
      );
      expect([attempt.ownerClass, attempt.cause, attempt.alsoCause]).toEqual([
        "model-progress",
        "execution-ceiling-reached",
        null,
      ]);
      expect(attempt.why).toBe(
        `The step used its whole tool-call ceiling before the model answered (${TOOL_CEILING}). It made 84 unchanged re-reads on the way. The ceiling is fitted to the composition's sealed turn budget, which only re-qualifying the composition raises.`,
      );
      expect(attempt.signature).toEqual({ outcome: "no-progress", failureCode: TOOL_CEILING });

      // The step ended at the ceiling after its attempt "succeeded".
      for (const rowKind of ["step", "run"] as const) {
        const recorded = classifyRecordedFailure(
          {
            ...attemptRow({}),
            rowKind,
            outcome: "failed",
            failureClass: "bound",
            failureLayer: "workflow",
            failureCode: TOOL_CEILING,
            executionCeilingSource: "sealed-budget",
          },
          COMMANDS,
        );
        expect([recorded.ownerClass, recorded.cause], rowKind).toEqual([
          "model-progress",
          "execution-ceiling-reached",
        ]);
        expect(recorded.signature).toEqual({ rowKind, failureCode: TOOL_CEILING });
      }
      // The sealed provider-turn code names its source by itself.
      const sealed = classifyAttemptRow(
        attemptRow({ outcome: "context-exhausted", failureCode: SEALED_TURNS }),
        COMMANDS,
      );
      expect([sealed.ownerClass, sealed.cause]).toEqual([
        "model-progress",
        "execution-ceiling-reached",
      ]);
      expect(sealed.why).toContain("its whole provider-turn ceiling");
    });

    it("names the host provider-turn ceiling as operator configuration, with model progress second", () => {
      const recorded = classifyAttemptRow(
        attemptRow({
          outcome: "context-exhausted",
          failureClass: "bound",
          failureCode: HOST_TURNS,
          executionCeilingSource: "host-limit",
        }),
        COMMANDS,
      );
      // A row indexed before the source was projected says only what its code proves.
      const older = classifyAttemptRow(
        attemptRow({
          outcome: "context-exhausted",
          failureClass: "bound",
          failureCode: HOST_TURNS,
          executionCeilingSource: null,
        }),
        COMMANDS,
      );
      for (const reading of [recorded, older]) {
        expect([reading.ownerClass, reading.cause]).toEqual([
          "operator-configuration",
          "execution-ceiling-configured",
        ]);
        expect(reading.why).not.toContain("re-qualifying");
        expect(reading.alsoCause).toMatchObject({
          ownerClass: "model-progress",
          cause: "execution-ceiling-reached",
        });
      }
      expect(recorded.why).toContain("The run host's execution limit, at its catalog value");
      expect(older.why).not.toContain("catalog value");
      expect(older.why).toContain("does not say whether an override lowered that limit");
    });

    it("names a ceiling an operator override lowered as operator configuration, with model progress second", () => {
      for (const failureCode of [TOOL_CEILING, HOST_TURNS]) {
        const reading = classifyAttemptRow(
          attemptRow({
            outcome: "no-progress",
            failureClass: "bound",
            failureCode,
            executionCeilingSource: "operator-override",
          }),
          COMMANDS,
        );
        expect([reading.ownerClass, reading.cause], failureCode).toEqual([
          "operator-configuration",
          "execution-ceiling-configured",
        ]);
        expect(reading.why).toContain("An operator override lowered this ceiling");
        // The overrides are named from the catalog, not restated here.
        for (const name of [
          "compositionExecution.maxToolCallsPerStep",
          "compositionExecution.maxProviderTurns",
        ]) {
          expect(reading.nextAction).toContain(limitDefinition(name).override!);
        }
        expect(reading.alsoCause).toMatchObject({
          ownerClass: "model-progress",
          cause: "execution-ceiling-reached",
        });
      }
    });

    it.each([
      [null, "execution-ceiling-source-not-indexed", "an earlier DocsFab indexed the run"],
      [
        "limits-not-recorded",
        "execution-ceiling-limits-not-recorded",
        "the run record does not carry",
      ],
      [
        "codes-mismatch",
        "execution-ceiling-codes-mismatch",
        "recorded ceiling code names a ceiling",
      ],
    ] as const)(
      "names both owners, and why, when the source is %s",
      (executionCeilingSource, limitation, reason) => {
        const reading = classifyAttemptRow(
          attemptRow({ outcome: "no-progress", failureCode: TOOL_CEILING, executionCeilingSource }),
          COMMANDS,
        );
        expect([reading.ownerClass, reading.cause]).toEqual([
          "model-progress",
          "execution-ceiling-reached",
        ]);
        expect(reading.limitations).toEqual([limitation]);
        expect(reading.alsoCause).toMatchObject({
          ownerClass: "operator-configuration",
          cause: "execution-ceiling-configured",
        });
        expect(reading.alsoCause?.why).toContain(reason);
      },
    );

    it("keeps other bounds on their own causes", () => {
      // A context-window stop and a compaction limit are not progress stops.
      for (const failureCode of ["context-exhausted", "compaction-limit"]) {
        const reading = classifyAttemptRow(
          attemptRow({ outcome: "context-exhausted", failureClass: "bound", failureCode }),
          COMMANDS,
        );
        expect(reading.cause, failureCode).toBe("context-window-exhausted");
      }
      // A catalogued output bound on a rejection stays the output limit.
      const output = classifyAttemptRow(
        attemptRow({ outcome: "malformed-response", rejectionCode: "text-truncated" }),
        COMMANDS,
      );
      expect(output.cause).toBe("output-allowance-reached");
      // Another workflow-layer bound stays an operational limit.
      const step = classifyRecordedFailure(
        {
          ...attemptRow({}),
          rowKind: "step",
          outcome: "failed",
          failureClass: "bound",
          failureLayer: "workflow",
          failureCode: "cumulative-token-limit",
        },
        COMMANDS,
      );
      expect(step.cause).toBe("operational-limit-reached");
    });

    const hostTurns = limitDefinition("compositionExecution.maxProviderTurns").value;
    /** The limits a composition run records: the run host's value and the sealed budgets. */
    const recordedLimits = (configured: number, sealed: number) => ({
      limits: {
        configured: { maxProviderTurns: configured },
        candidate: { maxProviderTurns: sealed },
        composition: { maxProviderTurns: sealed },
        package: { maxProviderTurns: hostTurns },
        effective: { maxProviderTurns: Math.min(configured, sealed) },
      },
    });

    it("projects what set the ceiling from the stopped attempt's turn and lease", () => {
      const ceilingRun = (
        maxToolCalls: number,
        maxProviderTurns: number,
        compositionExecution: unknown = recordedLimits(hostTurns, 128),
      ) =>
        projectRunIndexRows(
          {
            schemaVersion: 2,
            id: `run-ceiling-${String(maxToolCalls)}`,
            workflow: "review-documentation",
            status: "failed",
            createdAt: "2026-10-01T09:00:00.000Z",
            ...(compositionExecution === undefined ? {} : { compositionExecution }),
            failure: { class: "bound", layer: "inference", code: TOOL_CEILING },
            steps: [
              {
                id: "evaluate-document-quality",
                status: "failed",
                failure: { class: "bound", layer: "inference", code: TOOL_CEILING },
                inference: {
                  attempts: [
                    {
                      attempt: 1,
                      outcome: "no-progress",
                      condition: "tool-call-ceiling",
                      retryable: true,
                      durationMs: 1,
                      turns: [{ decision: "proceed", maxToolCalls, maxProviderTurns }],
                      executionLease: {
                        terminalReason: "hard-tool-call-ceiling",
                        terminalDisposition: "budget-stopped",
                        providerTurns: 26,
                        toolCalls: { executed: maxToolCalls },
                      },
                    },
                  ],
                },
              },
            ],
          },
          {
            origin: "import",
            snapshotId: "snapshot-ceiling",
            indexedAt: "2026-10-01T09:00:00.000Z",
            recordSha256: "a".repeat(64),
            fieldMaxChars: 512,
          },
        );
      const sources = (
        maxToolCalls: number,
        maxProviderTurns: number,
        compositionExecution?: unknown,
      ) => {
        const projection = ceilingRun(
          maxToolCalls,
          maxProviderTurns,
          ...(compositionExecution === undefined ? [] : [compositionExecution]),
        );
        if (!projection.ok) throw new Error(`fixture record refused: ${projection.reason}`);
        return projection.rows.map((row) => [
          row.rowKind,
          row.failureCode,
          row.executionCeilingSource,
        ]);
      };
      // 126 is the ceiling the catalog lease shape fits to a sealed budget of 128.
      expect(sources(126, 128)).toEqual([
        ["run", TOOL_CEILING, "sealed-budget"],
        ["attempt", TOOL_CEILING, "sealed-budget"],
      ]);
      // Below that fit, an override lowered it.
      expect(sources(50, 128)).toEqual([
        ["run", TOOL_CEILING, "operator-override"],
        ["attempt", TOOL_CEILING, "operator-override"],
      ]);
      const catalogCeiling = limitDefinition("compositionExecution.maxToolCallsPerStep").value;
      expect(sources(catalogCeiling, hostTurns)).toEqual([
        ["run", TOOL_CEILING, "host-limit"],
        ["attempt", TOOL_CEILING, "host-limit"],
      ]);
      // A record without the limits cannot tell a sealed budget from an override.
      expect(sources(126, 128, { limits: {} })).toEqual([
        ["run", TOOL_CEILING, "limits-not-recorded"],
        ["attempt", TOOL_CEILING, "limits-not-recorded"],
      ]);
      const query = (projection: ReturnType<typeof ceilingRun>) =>
        projection.ok
          ? queryRunIndex(projection.rows, {
              where: new Map([["executionCeilingSource", ["sealed-budget"]]]),
              groupBy: ["stepId"],
            }).groups
          : [];
      const stored = ceilingRun(126, 128);
      if (!stored.ok) throw new Error("fixture record refused");
      expect(
        decodeRunIndexRow(JSON.parse(JSON.stringify(stored.rows.at(-1))))?.executionCeilingSource,
      ).toBe("sealed-budget");
      expect(query(ceilingRun(126, 128))).toMatchObject([
        { key: { stepId: "evaluate-document-quality" }, rows: 1 },
      ]);
    });

    describe("reads the same source for a record whatever the projecting host's limits", () => {
      const OVERRIDE = "DOCSFAB_COMPOSITION_EXECUTION_MAX_PROVIDER_TURNS";
      afterEach(() => vi.unstubAllEnvs());

      /** A run whose step reached the tool-call ceiling fitted to `turns`. */
      const ceilingRecord = (turns: number, configured: number) => {
        const maxToolCalls = resolveLeaseShapeForTurns(
          EXECUTION_LEASE_DEFAULTS,
          turns,
        ).hardToolCallCeiling;
        return {
          schemaVersion: 2,
          id: `run-provenance-${String(turns)}`,
          workflow: "review-documentation",
          status: "failed",
          createdAt: "2026-10-01T09:00:00.000Z",
          compositionExecution: recordedLimits(configured, 128),
          failure: { class: "bound", layer: "inference", code: TOOL_CEILING },
          steps: [
            {
              id: "evaluate-document-quality",
              status: "failed",
              failure: { class: "bound", layer: "inference", code: TOOL_CEILING },
              inference: {
                attempts: [
                  {
                    attempt: 1,
                    outcome: "no-progress",
                    condition: "tool-call-ceiling",
                    retryable: true,
                    durationMs: 1,
                    turns: [{ decision: "proceed", maxToolCalls, maxProviderTurns: turns }],
                    executionLease: {
                      terminalReason: "hard-tool-call-ceiling",
                      terminalDisposition: "budget-stopped",
                      providerTurns: 26,
                      toolCalls: { executed: maxToolCalls },
                    },
                  },
                ],
              },
            },
          ],
        };
      };
      const read = (record: unknown) => {
        const projection = projectRunIndexRows(record, {
          origin: "import",
          snapshotId: "snapshot-provenance",
          indexedAt: "2026-10-01T09:00:00.000Z",
          recordSha256: "a".repeat(64),
          fieldMaxChars: 512,
        });
        if (!projection.ok) throw new Error(`fixture record refused: ${projection.reason}`);
        return projection.rows.map((row) => {
          const reading =
            row.rowKind === "attempt"
              ? classifyAttemptRow(row, COMMANDS)
              : classifyRecordedFailure(row, COMMANDS);
          return [row.rowKind, row.executionCeilingSource, reading.ownerClass, reading.cause];
        });
      };

      it.each([undefined, "100"])(
        "reads a run made under override 64 as operator configuration (projecting override %s)",
        (projectingOverride) => {
          if (projectingOverride !== undefined) vi.stubEnv(OVERRIDE, projectingOverride);
          else vi.stubEnv(OVERRIDE, undefined);
          // The run host's override lowered the limit to 64, below the sealed 128.
          expect(read(ceilingRecord(64, 64))).toEqual([
            ["run", "operator-override", "operator-configuration", "execution-ceiling-configured"],
            [
              "attempt",
              "operator-override",
              "operator-configuration",
              "execution-ceiling-configured",
            ],
          ]);
        },
      );

      it.each([undefined, "100"])(
        "reads a sealed-128 run as model progress (projecting override %s)",
        (projectingOverride) => {
          if (projectingOverride !== undefined) vi.stubEnv(OVERRIDE, projectingOverride);
          else vi.stubEnv(OVERRIDE, undefined);
          expect(read(ceilingRecord(128, hostTurns))).toEqual([
            ["run", "sealed-budget", "model-progress", "execution-ceiling-reached"],
            ["attempt", "sealed-budget", "model-progress", "execution-ceiling-reached"],
          ]);
        },
      );

      /**
       * A run whose step stopped at its provider-turn budget `turns`, by the
       * turn governor or by the lease, carrying the code the run host recorded.
       * Which provider-turn code a stop gets depends on the limits of the host
       * that classifies it, so only the ceiling, not the code, may be matched.
       */
      const providerTurnRecord = (
        stopBy: "governor" | "lease",
        turns: number,
        code: string,
        compositionExecution: unknown,
      ) => {
        const turn =
          stopBy === "governor"
            ? {
                decision: "stop",
                reason: "provider-turn-limit",
                turn: turns + 1,
                toolCalls: 3,
                maxToolCalls: 400,
                compactions: 0,
                maxCompactions: 8,
                maxProviderTurns: turns,
              }
            : { decision: "proceed", maxToolCalls: 400, maxProviderTurns: turns };
        return {
          schemaVersion: 2,
          id: `run-turns-${stopBy}-${String(turns)}`,
          workflow: "review-documentation",
          status: "failed",
          createdAt: "2026-10-01T09:00:00.000Z",
          compositionExecution,
          failure: { class: "bound", layer: "inference", code },
          steps: [
            {
              id: "evaluate-document-quality",
              status: "failed",
              failure: { class: "bound", layer: "inference", code },
              inference: {
                attempts: [
                  {
                    attempt: 1,
                    outcome: "context-exhausted",
                    retryable: false,
                    durationMs: 1,
                    turns: [turn],
                    ...(stopBy === "lease"
                      ? {
                          executionLease: {
                            terminalReason: "provider-turn-limit",
                            terminalDisposition: "budget-stopped",
                            providerTurns: turns - 1,
                            toolCalls: { executed: 3 },
                          },
                        }
                      : {}),
                  },
                ],
              },
            },
          ],
        };
      };
      const runRowOf = (record: unknown) => read(record).find(([rowKind]) => rowKind === "run");
      const projectingOverrides = [undefined, "100", "64"] as const;

      describe.each(["governor", "lease"] as const)("a provider-turn stop by the %s", (stopBy) => {
        it.each(projectingOverrides)(
          "reads a run under override 64 with the host code as operator configuration (projecting override %s)",
          (projectingOverride) => {
            vi.stubEnv(OVERRIDE, projectingOverride);
            expect(
              runRowOf(providerTurnRecord(stopBy, 64, HOST_TURNS, recordedLimits(64, 128))),
            ).toEqual([
              "run",
              "operator-override",
              "operator-configuration",
              "execution-ceiling-configured",
            ]);
          },
        );

        it.each(projectingOverrides)(
          "reads a sealed-128 run with the sealed code as model progress (projecting override %s)",
          (projectingOverride) => {
            vi.stubEnv(OVERRIDE, projectingOverride);
            expect(
              runRowOf(
                providerTurnRecord(stopBy, 128, SEALED_TURNS, recordedLimits(hostTurns, 128)),
              ),
            ).toEqual(["run", "sealed-budget", "model-progress", "execution-ceiling-reached"]);
          },
        );
      });

      it("takes the smallest sealed budget, the candidate's included", () => {
        const limits = {
          limits: {
            configured: { maxProviderTurns: hostTurns },
            candidate: { maxProviderTurns: 96 },
            composition: { maxProviderTurns: 128 },
            package: { maxProviderTurns: hostTurns },
            effective: { maxProviderTurns: 96 },
          },
        };
        expect(runRowOf(providerTurnRecord("governor", 96, SEALED_TURNS, limits))).toEqual([
          "run",
          "sealed-budget",
          "model-progress",
          "execution-ceiling-reached",
        ]);
      });

      it("reads an override equal to the sealed budget as the sealed budget", () => {
        // Raising or removing the override would not raise this ceiling.
        expect(
          runRowOf(providerTurnRecord("lease", 128, SEALED_TURNS, recordedLimits(128, 128))),
        ).toEqual(["run", "sealed-budget", "model-progress", "execution-ceiling-reached"]);
      });

      it("reads a ceiling code with no attempt to explain it as a mismatch, not an older index", () => {
        const record = providerTurnRecord(
          "lease",
          128,
          SEALED_TURNS,
          recordedLimits(hostTurns, 128),
        );
        record.steps[0]!.inference.attempts = [];
        expect(runRowOf(record)).toEqual([
          "run",
          "codes-mismatch",
          "model-progress",
          "execution-ceiling-reached",
        ]);
      });
    });

    it("projects the read-loop counters and classes the read-loop code as a bound", () => {
      const projection = projectRunIndexRows(
        {
          schemaVersion: 2,
          id: "run-read-loop",
          workflow: "update-documentation",
          status: "failed",
          createdAt: "2026-10-01T09:00:00.000Z",
          steps: [
            {
              id: "test-audience-understanding",
              status: "failed",
              inference: {
                attempts: [
                  {
                    attempt: 1,
                    outcome: "no-progress",
                    retryable: false,
                    durationMs: 1,
                    rejection: { code: READ_LOOP_ACROSS, location: "$.tools" },
                    tools: {
                      totalCalls: 30,
                      failedCalls: 0,
                      byTool: [],
                      failureCategories: [],
                      readEvidence: {
                        unchangedReReads: 25,
                        withheld: 9,
                        maxRepeatsOfOneResult: 4,
                        maxUnchangedReReadsAcrossResults: 25,
                      },
                    },
                  },
                  {
                    attempt: 2,
                    outcome: "succeeded",
                    retryable: false,
                    durationMs: 1,
                    tools: { totalCalls: 3, failedCalls: 0, byTool: [], failureCategories: [] },
                  },
                ],
              },
            },
          ],
        },
        {
          origin: "import",
          snapshotId: "snapshot-read-loop",
          indexedAt: "2026-10-01T09:00:00.000Z",
          recordSha256: "a".repeat(64),
          fieldMaxChars: 512,
        },
      );
      if (!projection.ok) throw new Error(`fixture record refused: ${projection.reason}`);
      const [stopped, recovered] = projection.rows.filter((row) => row.rowKind === "attempt");
      // The stored row decodes back with every counter.
      expect(decodeRunIndexRow(JSON.parse(JSON.stringify(stopped)))).toMatchObject({
        unchangedReReads: 25,
        readLoopWithheld: 9,
        maxRepeatsOfOneResult: 4,
        maxUnchangedReReadsAcrossResults: 25,
      });
      expect(stopped).toMatchObject({
        failureClass: "bound",
        failureCode: READ_LOOP_ACROSS,
        unchangedReReads: 25,
        readLoopWithheld: 9,
        maxRepeatsOfOneResult: 4,
        maxUnchangedReReadsAcrossResults: 25,
      });
      expect(recovered).toMatchObject({
        unchangedReReads: null,
        readLoopWithheld: null,
        maxRepeatsOfOneResult: null,
        maxUnchangedReReadsAcrossResults: null,
      });
      expect(
        queryRunIndex(projection.rows, {
          where: new Map([["maxUnchangedReReadsAcrossResults", ["25"]]]),
          groupBy: ["stepId", "unchangedReReads"],
        }).groups,
      ).toMatchObject([
        { key: { stepId: "test-audience-understanding", unchangedReReads: 25 }, rows: 1 },
      ]);
    });
  });
});

describe("an attempt timer that fired inside a tool loop", () => {
  /** Run 6626f66d's shape: 300 s timer, finish reason tool-use, 5,581 output tokens. */
  const timedOutInLoop = (fields: Partial<RunIndexRowV1>) =>
    attemptRow({
      outcome: "timeout",
      finishReason: "tool-use",
      attemptOutputTokens: 5_581,
      failureClass: "bound",
      failureLayer: "inference",
      failureCode: "attempt-deadline-in-tool-loop",
      ...fields,
    });

  it("reads model progress, not provider capacity", () => {
    const finding = classifyAttemptRow(timedOutInLoop({}), COMMANDS);
    expect([DIAGNOSIS_CAUSE_OWNERS[finding.cause], finding.cause]).toEqual([
      "model-progress",
      "attempt-deadline-in-tool-loop",
    ]);
    expect(finding.why).toContain("5581 output tokens");
    expect(finding.signature).toEqual({
      outcome: "timeout",
      failureCode: "attempt-deadline-in-tool-loop",
    });
  });

  it("reads a timer that found a request with no first byte as provider capacity", () => {
    const finding = classifyAttemptRow(
      timedOutInLoop({
        failureClass: "infrastructure",
        failureCode: "attempt-deadline-awaiting-provider",
      }),
      COMMANDS,
    );
    expect([DIAGNOSIS_CAUSE_OWNERS[finding.cause], finding.cause]).toEqual([
      "provider-capacity",
      "attempt-deadline-awaiting-provider",
    ]);
    expect(finding.why).toContain("had sent no first byte");
    expect(finding.nextAction).toContain("Rerun after the provider recovers");
  });

  it("keeps a provider timeout the classifier did not call a tool-loop deadline", () => {
    const finding = classifyAttemptRow(
      timedOutInLoop({ failureClass: "unknown", failureCode: "timeout" }),
      COMMANDS,
    );
    expect([DIAGNOSIS_CAUSE_OWNERS[finding.cause], finding.cause]).toEqual([
      "provider-capacity",
      "provider-timeout",
    ]);
  });
});

describe("an attempt the host asked to answer before it finished reading", () => {
  it("indexes the ask's trigger and names it as a limitation of the finding in why", () => {
    // The Omni run's first attempt was refused; mark that the host had asked it
    // to conclude before its deadline.
    const records = nimFixtureRecords();
    const omni = records.find(
      (candidate) => (candidate as { id?: string }).id === "nim-omni-content",
    ) as { steps: Array<{ inference?: { attempts: Array<Record<string, unknown>> } }> };
    const attempt = omni.steps
      .flatMap((step) => step.inference?.attempts ?? [])
      .find((candidate) => candidate.outcome !== "succeeded")!;
    attempt.concludeNow = { trigger: "attempt-deadline", turn: 4 };
    const projection = projectRunIndexRows(omni as never, {
      origin: "import",
      snapshotId: "snapshot-omni",
      indexedAt: "2026-09-30T17:00:00.000Z",
      recordSha256: "a".repeat(64),
      fieldMaxChars: 512,
    });
    if (!projection.ok) throw new Error(`fixture record refused: ${projection.reason}`);
    const asked = projection.rows.filter((row) => row.concludeNow !== null);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ rowKind: "attempt", concludeNow: "attempt-deadline" });
    // Every other row, and a stored row from another kind, reads null.
    expect(decodeRunIndexRow({ ...asked[0]!, rowKind: "step" })?.concludeNow ?? null).toBeNull();
    expect(classifyAttemptRow(asked[0]!, COMMANDS).limitations).toContain("answer-asked-early");
    const unasked = projection.rows.find(
      (row) => row.rowKind === "attempt" && row.concludeNow === null && row.outcome !== "succeeded",
    );
    if (unasked) {
      expect(classifyAttemptRow(unasked, COMMANDS).limitations).not.toContain("answer-asked-early");
    }
    const diagnosis = diagnoseRun(projection.rows, {
      location: LOCATION,
      source: "record",
      population: null,
      lookbackRuns: 20,
    });
    const finding = diagnosis.findings.find((candidate) =>
      candidate.limitations.includes("answer-asked-early"),
    );
    expect(finding).toBeDefined();
    const rendered = formatRunDiagnosisLines(diagnosis, { location: LOCATION }).join("\n");
    expect(rendered).toContain(
      finding!.role === "terminal"
        ? "Limitation: answer-asked-early: The host withdrew the tools and asked this attempt for its answer before the model finished reading"
        : "The host had asked it to answer before it finished reading (answer-asked-early).",
    );
  });

  it("refuses a malformed concludeNow by name instead of indexing it", () => {
    const records = nimFixtureRecords();
    const omni = records.find(
      (candidate) => (candidate as { id?: string }).id === "nim-omni-content",
    ) as { steps: Array<{ inference?: { attempts: Array<Record<string, unknown>> } }> };
    const attempt = omni.steps
      .flatMap((step) => step.inference?.attempts ?? [])
      .find((candidate) => candidate.outcome !== "succeeded")!;
    attempt.concludeNow = { trigger: "not-a-trigger", turn: 4 };
    const projection = projectRunIndexRows(omni as never, {
      origin: "import",
      snapshotId: "snapshot-omni-malformed",
      indexedAt: "2026-09-30T17:00:00.000Z",
      recordSha256: "a".repeat(64),
      fieldMaxChars: 512,
    });
    if (!projection.ok) throw new Error(`fixture record refused: ${projection.reason}`);
    const rows = projection.rows.filter((row) => row.omittedFields.includes("concludeNow"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rowKind: "attempt", concludeNow: null });
  });
});
