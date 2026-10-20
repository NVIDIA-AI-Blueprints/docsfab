// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { InferenceStepError } from "../src/execution/contracts.js";
import {
  buildRunHumanNextCommand,
  formatRunFailureDiagnosticLines,
} from "../src/operator/run-summary.js";
import type { RunRecord } from "../src/records/contracts.js";
import { isTechnicalAdmissionStop } from "../src/workflow-execution/runner-schedule.js";
import {
  parseTechnicalResponse,
  projectTechnicalReviewFailure,
  wrapTechnicalReviewFailure,
} from "../src/workflow-execution/review-response.js";

const RUN_ID = "59f40817-4e61-4cdd-9f3d-6f9930db95ee";
const SECRET = "nvapi-abcdefghijklmnopqrstuvwxyz012345";
const PRIVATE_PATH = "/Users/alice/private.md";
const MODEL_PROSE = "I'll perform a fresh technical review of the inventory.";

function failedTechnicalRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  const message = "Technical correction response rejected: invalid-fact-inventory.";
  return {
    schemaVersion: 2,
    id: RUN_ID,
    workflow: "review-documentation",
    repository: {
      sourcePath: "/tmp/example",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "failed",
    createdAt: "2026-09-22T12:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 27209, output: 1472, cacheRead: 0, cacheWrite: 0, total: 28681, turns: 1 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    error: message,
    steps: [
      {
        id: "verify-technical-accuracy",
        title: "Verify technical accuracy",
        kind: "evaluate",
        skill: "verify-technical-accuracy",
        mode: "read-only",
        status: "failed",
        error: message,
        inference: {
          configuredMaxRetries: 3,
          effectiveMaxRetries: 3,
          baseDelayMs: 0,
          maxDelayMs: 0,
          retryableCategories: ["malformed-response"],
          replay: "read-only",
          attempts: [
            {
              attempt: 1,
              outcome: "malformed-response",
              retryable: false,
              retryScheduled: false,
              durationMs: 1000,
              rejection: {
                code: "inventory-fact-finding-link",
                location: "$.factInventory",
              },
            },
          ],
        },
      },
    ],
    ...overrides,
  };
}

describe("step failure citation (#1113)", () => {
  it("names the run, failing step, coded rejection, and inspect command", () => {
    const lines = formatRunFailureDiagnosticLines(failedTechnicalRecord());
    expect(lines).toContain(`Run ${RUN_ID} failed at step verify-technical-accuracy.`);
    expect(lines).toContain("Rejected by inventory-fact-finding-link at $.factInventory.");
    expect(lines.join("\n")).not.toContain(SECRET);
    expect(lines.join("\n")).not.toContain(PRIVATE_PATH);
    expect(lines.join("\n")).not.toContain(MODEL_PROSE);
    expect(JSON.stringify(lines).length).toBeLessThan(2_000);
  });

  it("does not restate the failure as the NEXT command", () => {
    const record = failedTechnicalRecord();
    const next = buildRunHumanNextCommand({
      record,
      recordPath: "/private/state/run.json",
      exitCode: 1,
      repositoryPath: "/tmp/example",
    });
    expect(next?.command).toBe(`docsfab runs show ${RUN_ID} --state-dir /private/state --json`);
    expect(
      next?.reason.startsWith("Technical correction response rejected: invalid-fact-inventory."),
    ).toBe(true);
    expect(next?.reason).not.toContain("inventory-fact-finding-link");
    expect(next?.reason).toContain("not admitted as evidence");
    expect(next?.reason).not.toContain(MODEL_PROSE);
  });
});

describe("parse-failure budget (#1102)", () => {
  it("states allowance, observed tokens, and finish reason on a near-ceiling parse failure", () => {
    let error: unknown;
    try {
      parseTechnicalResponse("{not-json", "review", {
        outputAllowance: 4096,
        outputTokens: 3579,
        finishReason: "length",
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(InferenceStepError);
    expect(error).toMatchObject({
      category: "malformed-response",
      retryable: true,
      rejection: { code: "json-unexpected-token", location: "$response" },
    });
    expect((error as Error).message).toBe(
      "Technical review response rejected: invalid-json. Strict JSON: malformed-json; response format: object-like. Output allowance 4096; observed output tokens 3579; finish reason length.",
    );
    expect((error as Error).message).not.toContain(SECRET);
    expect((error as Error).message).not.toContain("{not-json");
    expect(projectTechnicalReviewFailure(error).retryable).toBe(true);
  });

  it("copies request usage onto a wrapped parse failure without changing retryability", () => {
    let parsed: unknown;
    try {
      parseTechnicalResponse('{"ok":', "correction");
    } catch (caught) {
      parsed = caught;
    }
    const original = projectTechnicalReviewFailure(parsed);
    const wrapped = wrapTechnicalReviewFailure(parsed, {
      usage: {
        input: 1200,
        output: 3684,
        cacheRead: 0,
        cacheWrite: 0,
        total: 4884,
        turns: 1,
      },
      turns: [
        {
          requestedOutputTokens: 4096,
          effectiveMaxOutputTokens: 4096,
          decision: "proceed",
          rawStopReason: "length",
        } as never,
      ],
    });
    expect(wrapped.retryable).toBe(original.retryable);
    expect(wrapped.category).toBe("malformed-response");
    expect(wrapped.rejection).toEqual({ code: "json-unexpected-end", location: "$response" });
    expect(wrapped.message).toContain("Output allowance 4096");
    expect(wrapped.message).toContain("observed output tokens 3684");
    expect(wrapped.message).toContain("finish reason length");
    expect(wrapped.message).not.toContain('{"ok":');
    expect(wrapped.message).not.toContain(SECRET);
    expect(JSON.stringify(wrapped)).not.toContain(MODEL_PROSE);
    expect(isTechnicalAdmissionStop(wrapped)).toBe(true);
  });

  it("names the provider finish reason through formatRunFailureDiagnosticLines", () => {
    const record = failedTechnicalRecord();
    const attempt = record.steps[0]!.inference!.attempts[0]!;
    attempt.usage = {
      input: 1200,
      output: 3579,
      cacheRead: 0,
      cacheWrite: 0,
      total: 4779,
      turns: 1,
    };
    attempt.turns = [
      {
        requestedOutputTokens: 4096,
        effectiveMaxOutputTokens: 4096,
        decision: "proceed",
        rawStopReason: "length",
      } as never,
    ];
    const lines = formatRunFailureDiagnosticLines(record);
    expect(lines).toContain(
      "Output allowance 4096; observed output tokens 3579; finish reason length.",
    );
    expect(lines.join("\n")).not.toContain(SECRET);
    expect(lines.join("\n")).not.toContain(PRIVATE_PATH);
    expect(lines.join("\n")).not.toContain(MODEL_PROSE);
  });

  it("does not treat credential-shaped finish reasons as provider tokens", () => {
    let error: unknown;
    try {
      parseTechnicalResponse("[", "review", {
        outputAllowance: 4096,
        outputTokens: 12,
        finishReason: SECRET,
      });
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).toContain("finish reason absent");
    expect((error as Error).message).not.toContain(SECRET);
  });

  it("does not copy credential-shaped turn finish reasons into the live wrapper or inspect lines", () => {
    let parsed: unknown;
    try {
      parseTechnicalResponse('{"ok":', "correction");
    } catch (caught) {
      parsed = caught;
    }
    const wrapped = wrapTechnicalReviewFailure(parsed, {
      usage: {
        input: 1200,
        output: 12,
        cacheRead: 0,
        cacheWrite: 0,
        total: 1212,
        turns: 1,
      },
      turns: [
        {
          requestedOutputTokens: 4096,
          effectiveMaxOutputTokens: 4096,
          decision: "proceed",
          rawStopReason: SECRET,
        } as never,
      ],
    });
    expect(wrapped.message).toContain("finish reason absent");
    expect(wrapped.message).not.toContain(SECRET);
    const record = failedTechnicalRecord({ error: wrapped.message });
    const attempt = record.steps[0]!.inference!.attempts[0]!;
    attempt.usage = {
      input: 1200,
      output: 12,
      cacheRead: 0,
      cacheWrite: 0,
      total: 1212,
      turns: 1,
    };
    attempt.turns = [
      {
        requestedOutputTokens: 4096,
        effectiveMaxOutputTokens: 4096,
        decision: "proceed",
        rawStopReason: SECRET,
      } as never,
    ];
    record.steps[0]!.error = "Technical correction response rejected: invalid-json.";
    const lines = formatRunFailureDiagnosticLines(record);
    expect(lines.join("\n")).toContain("finish reason absent");
    expect(lines.join("\n")).not.toContain(SECRET);
  });
});
