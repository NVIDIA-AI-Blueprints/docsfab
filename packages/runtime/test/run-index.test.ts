// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { classifyInferenceAttempt } from "../src/operator/failure-classification.js";
import { readRunRetryDispositions } from "../src/operator/retry-disposition.js";
import type { InferenceAttemptEvidence, RunRecord } from "../src/records/contracts.js";
import {
  attemptClassifierDigest,
  attemptClassifierSha256,
  classifierEntryFile,
  classifierSourceDigest,
  classifierSourceFiles,
  retryRuleEntryFile,
  type AttemptClassifier,
} from "../src/records/run-index-classifier.js";
import {
  decodeRunIndexRow,
  docsfabBuildRevision,
  projectRunIndexRows,
  RUN_INDEX_PROJECTION_REVISION,
  type RunIndexRowV1,
  type RunIndexSnapshotContext,
} from "../src/records/run-index.js";
import { queryRunIndex, type RunIndexQuery } from "../src/records/run-index-query.js";
import { OPERATIONAL_LIMIT_NAMES } from "../src/config/limit-stop.js";
import { LIMIT_DEFINITION_BY_NAME } from "../src/config/limits.generated.js";

const MODEL = { provider: "fixture-provider", model: "fixture/model-a" };

function context(overrides: Partial<RunIndexSnapshotContext> = {}): RunIndexSnapshotContext {
  return {
    origin: "import",
    snapshotId: "snapshot-1",
    indexedAt: "2026-09-23T12:00:00.000Z",
    recordSha256: "a".repeat(64),
    fieldMaxChars: 512,
    ...overrides,
  };
}

function attempt(
  number: number,
  outcome: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    attempt: number,
    outcome,
    retryable: outcome !== "succeeded",
    durationMs: 10,
    model: MODEL,
    ...extra,
  };
}

function record(id: string, createdAt: string, steps: unknown[]): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id,
    workflow: "restructure-documentation",
    status: "failed",
    createdAt,
    repository: { sourcePath: "/fixture/repository", revision: "b".repeat(40) },
    qualityPack: { manifestSha256: "c".repeat(64) },
    steps,
  };
}

function rowsOf(value: unknown, overrides: Partial<RunIndexSnapshotContext> = {}): RunIndexRowV1[] {
  const projection = projectRunIndexRows(value, context(overrides));
  if (!projection.ok) throw new Error(`fixture record refused: ${projection.reason}`);
  return [...projection.rows];
}

/**
 * `classifyInferenceFailure`'s coded-rejection block and its cancellation
 * check. The rejection block comes after the output-limit check; moving it up
 * to just after the cancellation check makes the rejection code win over an
 * output-limit stop.
 */
const REJECTION_CHECK_START = "  if (input.rejectionCode !== undefined) {\n";
const BLOCK_END = "\n  }\n";
const CANCELLED_CHECK = '  if (input.cancelled) return runFailure("workflow-cancelled");\n';

const where = (entries: [string, string[]][]): RunIndexQuery["where"] =>
  new Map(entries) as RunIndexQuery["where"];

describe("run index row projection", () => {
  it("omits source proposal receipts without validated CREATE and attempt context", () => {
    const reason = "The cited path is required to verify this technical claim.";
    const receipt = {
      schemaVersion: 1,
      kind: "docsfab-source-proposal-admission",
      attempt: 1,
      path: "src/extra.ts",
      reason,
      status: "admitted",
    };
    for (const candidate of [
      record("run-wrong-workflow", "2026-10-09T09:00:00.000Z", [
        { id: "derive-source-obligations", sourceProposalAdmissions: [receipt] },
      ]),
      {
        ...record("run-wrong-step", "2026-10-09T09:00:00.000Z", [
          { id: "verify-technical-accuracy", sourceProposalAdmissions: [receipt] },
        ]),
        workflow: "create-documentation",
      },
    ]) {
      const row = rowsOf(candidate)[0]!;
      expect(row.sourceProposalOutcomes).toBeNull();
      expect(row.omittedFields).toContain("sourceProposalOutcomes");
    }
  });

  it("omits the whole source proposal projection when any receipt is invalid or too large", () => {
    const reason = "The cited path is required to verify this technical claim.";
    const receipt = {
      schemaVersion: 1,
      kind: "docsfab-source-proposal-admission",
      attempt: 1,
      path: "src/extra.ts",
      reason,
      status: "admitted",
    };
    const malformed = rowsOf(
      record("run-invalid-proposal", "2026-10-09T09:00:00.000Z", [
        {
          id: "derive-source-obligations",
          sourceProposalAdmissions: [receipt, { ...receipt, refusalCode: "freeform" }],
        },
      ]),
    );
    expect(malformed[0]?.sourceProposalOutcomes).toBeNull();
    expect(malformed[0]?.omittedFields).toContain("sourceProposalOutcomes");
    const oversized = rowsOf(
      record("run-large-proposal", "2026-10-09T09:00:00.000Z", [
        { id: "derive-source-obligations", sourceProposalAdmissions: [receipt] },
      ]),
      { fieldMaxChars: 32 },
    );
    expect(oversized[0]?.sourceProposalOutcomes).toBeNull();
    expect(oversized[0]?.omittedFields).toContain("sourceProposalOutcomes");
  });

  it("marks malformed current-revision outcome JSON as omitted when decoding an index row", () => {
    const row = rowsOf(record("run-malformed-outcomes", "2026-10-09T09:00:00.000Z", []))[0]!;
    const decoded = decodeRunIndexRow({
      ...row,
      sourceProposalOutcomes: "not-json",
      omittedFields: [],
    });
    expect(decoded?.sourceProposalOutcomes).toBeNull();
    expect(decoded?.omittedFields).toContain("sourceProposalOutcomes");
  });
  it("projects readiness disposition and closed per-criterion reason codes for runs query", () => {
    const value = {
      ...record("run-readiness", "2026-10-09T09:00:00.000Z", [
        { id: "assess-readiness", status: "succeeded", skill: "assess-documentation-readiness" },
      ]),
      workflow: "readiness",
      status: "succeeded",
      workflowOutcome: {
        disposition: "inconclusive",
        findings: [
          {
            id: "finding:readiness:source-completeness",
            kind: "evidence-limitation",
            severity: "warning",
            code: "readiness-source-completeness-model-assessed-unassessed",
            evidenceIds: ["step:assess-readiness"],
          },
        ],
      },
    };
    const rows = rowsOf(value);
    expect(rows[0]).toMatchObject({
      rowKind: "run",
      readinessDisposition: "inconclusive",
      readinessReasonCodes:
        '[{"criterionId":"source-completeness","code":"model-assessed-unassessed"}]',
    });
    expect(rows[1]).toMatchObject({
      rowKind: "step",
      readinessDisposition: null,
      readinessReasonCodes: null,
    });
    const queried = queryRunIndex(rows, {
      where: new Map([
        ["rowKind", ["run"]],
        ["readinessDisposition", ["inconclusive"]],
      ]),
      groupBy: ["readinessReasonCodes"],
    });
    expect(queried.groups[0]?.key).toEqual({
      readinessReasonCodes:
        '[{"criterionId":"source-completeness","code":"model-assessed-unassessed"}]',
    });
    const current = decodeRunIndexRow(JSON.parse(JSON.stringify(rows[0])));
    expect(current).toMatchObject({
      readinessDisposition: "inconclusive",
      readinessReasonCodes:
        '[{"criterionId":"source-completeness","code":"model-assessed-unassessed"}]',
    });
    expect(decodeRunIndexRow({ ...rows[0]!, projectionRevision: 17 })).toMatchObject({
      projectionRevision: 17,
      readinessDisposition: "inconclusive",
      readinessReasonCodes:
        '[{"criterionId":"source-completeness","code":"model-assessed-unassessed"}]',
    });
    const rejected = decodeRunIndexRow({
      ...rows[0],
      readinessReasonCodes: '[{"criterionId":"source-completeness","code":"model-prose-canary"}]',
    });
    expect(rejected).toMatchObject({
      readinessDisposition: "inconclusive",
      readinessReasonCodes: null,
    });
    const {
      readinessDisposition: _disposition,
      readinessReasonCodes: _reasons,
      ...legacy
    } = rows[0]!;
    expect(decodeRunIndexRow({ ...legacy, projectionRevision: 16 })).toMatchObject({
      readinessDisposition: null,
      readinessReasonCodes: null,
    });
  });

  it("emits one row per recorded attempt carrying the inner rejection code and location", () => {
    const rows = rowsOf(
      record("run-a", "2026-09-23T09:00:00.000Z", [
        {
          id: "verify-technical-accuracy",
          status: "failed",
          skill: "verify-technical-accuracy",
          inference: {
            attempts: [
              attempt(1, "malformed-response", {
                rejection: { code: "inventory-fact-locators", location: "$.factInventory" },
                conditionRetryability: "eligible",
                retryDecision: "retried",
                turns: [{ rawStopReason: "length" }, { decision: "stop" }],
                modelTelemetry: {
                  schemaVersion: 1,
                  finishReason: "length",
                  outputTokens: 4096,
                  outputAllowance: 4096,
                  providerLatencyMs: 900,
                },
              }),
              attempt(2, "malformed-response"),
            ],
          },
        },
        { id: "check-links", status: "failed", skill: "check-links" },
        { id: "review-documentation", status: "pending", skill: "review-documentation" },
      ]),
    );
    // One run row, two attempt rows, one step row; the pending step never ran.
    expect(rows.map((row) => row.rowKind)).toEqual(["run", "attempt", "attempt", "step"]);
    expect(rows.every((row) => row.snapshotRows === 4)).toBe(true);
    expect(rows[0]).toMatchObject({
      rowKind: "run",
      stepId: null,
      stepIndex: null,
      attempt: null,
      outcome: "failed",
      runStatus: "failed",
    });
    expect(rows[1]).toMatchObject({
      rowKind: "attempt",
      runId: "run-a",
      stepId: "verify-technical-accuracy",
      attempt: 1,
      finalAttempt: false,
      outcome: "malformed-response",
      // The normalized finish reason `length` is a cut at the allowance.
      failureClass: "bound",
      failureLayer: "inference",
      rejectionSource: "inference-attempt",
      rejectionCode: "inventory-fact-locators",
      rejectionLocation: "$.factInventory",
      retryDecision: "retried",
      provider: "fixture-provider",
      model: "fixture/model-a",
      finishReason: "length",
      outputTokens: 4096,
      outputAllowance: 4096,
      providerLatencyMs: 900,
      repositoryRevision: "b".repeat(40),
      qualityPackManifestSha256: "c".repeat(64),
      omittedFields: [],
    });
    // An attempt without a coded reason stays unavailable; nothing is inferred.
    expect(rows[2]).toMatchObject({
      attempt: 2,
      finalAttempt: true,
      failureClass: "contract-shape",
      failureLayer: "inference",
      rejectionSource: null,
      rejectionCode: null,
      rejectionLocation: null,
      finishReason: null,
      providerLatencyMs: null,
    });
    // A step that ran without inference evidence gets one step row. It
    // recorded no `failure`, so it has no class: none is derived.
    expect(rows[3]).toMatchObject({
      rowKind: "step",
      stepId: "check-links",
      attempt: null,
      outcome: "failed",
      failureClass: null,
      failureLayer: null,
    });
  });

  it("gives a run that stopped before any step exactly one run row", () => {
    const rows = rowsOf({ ...record("preflight-stop", "2026-09-23T09:00:00.000Z", []) });
    expect(rows).toEqual([
      expect.objectContaining({
        rowKind: "run",
        runId: "preflight-stop",
        runStatus: "failed",
        outcome: "failed",
        snapshotRows: 1,
      }),
    ]);
  });

  it("stores an over-long or control-character value as unavailable and names the field", () => {
    const rows = rowsOf(
      record("run-long", "2026-09-23T09:00:00.000Z", [
        {
          id: "step",
          status: "failed",
          inference: {
            attempts: [
              attempt(1, "malformed-response", {
                rejection: { code: "x".repeat(65), location: "$.a\u0007" },
              }),
            ],
          },
        },
      ]),
      { fieldMaxChars: 64 },
    );
    expect(rows[1]).toMatchObject({ rejectionCode: null, rejectionLocation: null });
    expect(rows[1]!.omittedFields).toEqual(["rejectionCode", "rejectionLocation"]);
  });

  it("refuses values that are not schema-version 2 run records", () => {
    expect(projectRunIndexRows({ schemaVersion: 1, id: "old", steps: [] }, context())).toEqual({
      ok: false,
      reason: "unsupported-schema",
    });
    expect(
      projectRunIndexRows({ schemaVersion: 2, id: "../escape", steps: [] }, context()),
    ).toEqual({ ok: false, reason: "unsafe-run-id" });
    expect(projectRunIndexRows([], context())).toEqual({ ok: false, reason: "not-a-run-record" });
  });
});

/**
 * Rejection evidence on run records, projected as a `quality-validation`
 * rejection source on step rows and a reply parse code on attempt rows.
 */
describe("run index rows for !1079's rejection evidence (#1230)", () => {
  const QUALITY = {
    validator: "evaluation",
    code: "layer-confidence-exceeds-dimensions",
    location: "$.layers.trustworthy_information.confidence",
    issueCount: 1,
  };
  const shape = (parse: Record<string, unknown>) => ({
    schemaVersion: 1,
    replyChars: 120,
    parse,
    undeclaredKeys: 0,
    paths: [],
  });

  it("puts a quality validation rejection on a step row beside its succeeded attempt", () => {
    const rows = rowsOf(
      record("run-quality", "2026-09-23T09:00:00.000Z", [
        {
          id: "evaluate-document-quality",
          status: "failed",
          inference: { attempts: [attempt(1, "succeeded")] },
          qualityValidationRejection: QUALITY,
        },
        { id: "lint-documentation", status: "failed", qualityValidationRejection: QUALITY },
        { id: "check-links", status: "failed", skill: "check-links" },
      ]),
    );
    expect(rows.map((row) => row.rowKind)).toEqual(["run", "attempt", "step", "step", "step"]);
    // The attempt itself succeeded; the refusal belongs to the step.
    expect(rows[1]).toMatchObject({
      rowKind: "attempt",
      stepId: "evaluate-document-quality",
      outcome: "succeeded",
      rejectionSource: null,
      rejectionCode: null,
    });
    expect(rows[2]).toMatchObject({
      rowKind: "step",
      stepId: "evaluate-document-quality",
      attempt: null,
      outcome: "failed",
      failureClass: null,
      rejectionSource: "quality-validation",
      rejectionCode: QUALITY.code,
      rejectionLocation: QUALITY.location,
      rejectedReplyParseCode: null,
      omittedFields: [],
    });
    // A step without attempts carries it on its only row.
    expect(rows[3]).toMatchObject({
      stepId: "lint-documentation",
      rejectionSource: "quality-validation",
      rejectionCode: QUALITY.code,
    });
    expect(rows[4]).toMatchObject({ stepId: "check-links", rejectionSource: null });
    expect(rows.every((row) => row.projectionRevision === RUN_INDEX_PROJECTION_REVISION)).toBe(
      true,
    );
    // The default attempt population is unchanged by the new step row.
    expect(queryRunIndex(rows, { where: new Map(), groupBy: ["outcome"] }).groups).toEqual([
      { key: { outcome: "succeeded" }, rows: 1, runs: 1, share: 1 },
    ]);
    expect(
      queryRunIndex(rows, {
        where: where([
          ["rejectionSource", ["quality-validation"]],
          ["rowKind", ["step"]],
        ]),
        groupBy: ["stepId", "rejectionCode"],
      }).groups.map((group) => group.key),
    ).toEqual([
      { stepId: "evaluate-document-quality", rejectionCode: QUALITY.code },
      { stepId: "lint-documentation", rejectionCode: QUALITY.code },
    ]);
  });

  it("refuses an over-long quality rejection code by name instead of copying it", () => {
    const rows = rowsOf(
      record("run-quality-long", "2026-09-23T09:00:00.000Z", [
        {
          id: "evaluate-document-quality",
          status: "failed",
          qualityValidationRejection: { ...QUALITY, code: "x".repeat(65) },
        },
      ]),
      { fieldMaxChars: 64 },
    );
    expect(rows[1]).toMatchObject({
      rejectionSource: "quality-validation",
      rejectionCode: null,
      rejectionLocation: QUALITY.location,
      omittedFields: ["rejectionCode"],
    });
  });

  it("copies each attempt's reply parse outcome in the parser's closed vocabulary", () => {
    const rows = rowsOf(
      record("run-parse", "2026-09-23T09:00:00.000Z", [
        {
          id: "provisional-technical-verification",
          status: "failed",
          inference: {
            attempts: [
              attempt(1, "malformed-response", {
                rejection: { code: "invalid-shape", location: "$response" },
                rejectedReplyShape: { ...shape({ status: "parsed" }), root: "object" },
              }),
              attempt(2, "malformed-response", {
                rejectedReplyShape: shape({
                  status: "failed",
                  code: "malformed-json",
                  detail: "unexpected-end",
                  offset: 119,
                }),
              }),
              attempt(3, "malformed-response", {
                rejectedReplyShape: shape({ status: "failed", code: "duplicate-key" }),
              }),
              attempt(4, "malformed-response", {
                rejectedReplyShape: shape({ status: "failed", code: "CANARY reply prose" }),
              }),
              attempt(5, "timeout"),
              // A known code beside a forged syntax detail.
              attempt(6, "malformed-response", {
                rejectedReplyShape: shape({
                  status: "failed",
                  code: "malformed-json",
                  detail: "CANARY forged detail",
                }),
              }),
            ],
          },
        },
      ]),
    );
    expect(rows.slice(1).map((row) => row.rejectedReplyParseCode)).toEqual([
      "parsed",
      "json-unexpected-end",
      "json-duplicate-key",
      null,
      null,
      null,
    ]);
    // A forged parse code or syntax detail is refused and named, not copied.
    expect(rows[4]!.omittedFields).toEqual(["rejectedReplyParseCode"]);
    expect(rows[5]!.omittedFields).toEqual([]);
    expect(rows[6]!.omittedFields).toEqual(["rejectedReplyParseCode"]);
    expect(JSON.stringify(rows)).not.toContain("CANARY");
    expect(
      queryRunIndex(rows, { where: new Map(), groupBy: ["rejectedReplyParseCode"] }).groups.map(
        (group) => [group.key.rejectedReplyParseCode, group.rows],
      ),
    ).toEqual([
      [null, 3],
      ["json-duplicate-key", 1],
      ["json-unexpected-end", 1],
      ["parsed", 1],
    ]);
  });

  it("reads a row an earlier projection wrote as revision 1 with the new fields null", () => {
    const [current] = rowsOf(record("run-old", "2026-09-23T09:00:00.000Z", []));
    const { projectionRevision: _revision, rejectedReplyParseCode: _code, ...older } = current!;
    const decoded = decodeRunIndexRow(JSON.parse(JSON.stringify(older)));
    expect(decoded).toMatchObject({ projectionRevision: 1, rejectedReplyParseCode: null });
    expect(decodeRunIndexRow(JSON.parse(JSON.stringify(current)))).toEqual(current);
    expect(
      queryRunIndex([decoded!], {
        where: where([["rowKind", ["run"]]]),
        groupBy: ["rejectedReplyParseCode"],
      }).groups,
    ).toEqual([{ key: { rejectedReplyParseCode: null }, rows: 1, runs: 1, share: 1 }]);
  });
});

/**
 * Per-attempt model telemetry, failure class, and failure layer.
 */
describe("run index rows for model telemetry and failure classes (#1236)", () => {
  const telemetry = (extra: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    finishReason: "stop",
    outputTokens: 735,
    outputAllowance: 128000,
    providerLatencyMs: 11073,
    ...extra,
  });
  const failed = (failureClass: string, layer: string, code: string) => ({
    class: failureClass,
    layer,
    code,
  });

  function telemetryRun(): Record<string, unknown> {
    return {
      ...record("run-telemetry", "2026-09-23T09:00:00.000Z", [
        {
          id: "provisional-technical-verification",
          status: "succeeded",
          inference: {
            attempts: [
              attempt(1, "malformed-response", { modelTelemetry: telemetry() }),
              attempt(2, "succeeded", { modelTelemetry: telemetry({ outputTokens: 752 }) }),
            ],
          },
        },
        {
          id: "evaluate-document-quality",
          status: "failed",
          failure: failed("unknown", "inference", "provider-terminal"),
          inference: {
            attempts: [
              attempt(1, "throttled", {
                modelTelemetry: telemetry({
                  finishReason: "error",
                  outputTokens: undefined,
                  providerError: { class: "rate-limit", httpStatus: 429, retryAfterMs: 2000 },
                }),
              }),
              attempt(2, "provider-terminal", {
                // A turn-level stop token is not copied; the column is the telemetry's.
                turns: [{ rawStopReason: "max_tokens" }],
                modelTelemetry: telemetry({
                  finishReason: "error",
                  outputTokens: undefined,
                  providerLatencyMs: 364012,
                  providerError: { class: "network" },
                }),
              }),
            ],
          },
        },
        {
          id: "lint-documentation",
          status: "failed",
          failure: failed("model-content", "workflow", "technical-trace-incomplete"),
        },
      ]),
      failure: failed("unknown", "inference", "provider-terminal"),
    };
  }

  it("copies each attempt's telemetry and groups by finish reason and provider error class", () => {
    const rows = rowsOf(telemetryRun());
    expect(rows.map((row) => row.rowKind)).toEqual([
      "run",
      "attempt",
      "attempt",
      "attempt",
      "attempt",
      "step",
    ]);
    expect(rows[1]).toMatchObject({
      finishReason: "stop",
      providerErrorClass: null,
      httpStatus: null,
      outputTokens: 735,
      outputAllowance: 128000,
      providerLatencyMs: 11073,
      omittedFields: [],
    });
    expect(rows[3]).toMatchObject({
      finishReason: "error",
      providerErrorClass: "rate-limit",
      httpStatus: 429,
      outputTokens: null,
      outputAllowance: 128000,
    });
    expect(rows[4]).toMatchObject({
      finishReason: "error",
      providerErrorClass: "network",
      httpStatus: null,
      providerLatencyMs: 364012,
      omittedFields: [],
    });
    // Run and step rows carry no attempt telemetry.
    for (const row of [rows[0]!, rows[5]!]) {
      expect(row).toMatchObject({
        finishReason: null,
        providerErrorClass: null,
        httpStatus: null,
        outputTokens: null,
        outputAllowance: null,
        providerLatencyMs: null,
      });
    }
    const grouped = queryRunIndex(rows, {
      where: new Map(),
      groupBy: ["finishReason", "providerErrorClass"],
    });
    expect(grouped.groups.map((group) => [group.key, group.rows])).toEqual([
      [{ finishReason: "stop", providerErrorClass: null }, 2],
      [{ finishReason: "error", providerErrorClass: "network" }, 1],
      [{ finishReason: "error", providerErrorClass: "rate-limit" }, 1],
    ]);
    expect(
      queryRunIndex(rows, {
        where: where([["httpStatus", ["429"]]]),
        groupBy: ["stepId", "attempt"],
      }).groups.map((group) => group.key),
    ).toEqual([{ stepId: "evaluate-document-quality", attempt: 1 }]);
  });

  it("takes run and step classes from the recorded failure and attempt classes from the attempt classifier", () => {
    const run = telemetryRun();
    const rows = rowsOf(run);
    expect(rows[0]).toMatchObject({
      rowKind: "run",
      failureClass: "unknown",
      failureLayer: "inference",
    });
    expect(rows[5]).toMatchObject({
      rowKind: "step",
      stepId: "lint-documentation",
      failureClass: "model-content",
      failureLayer: "workflow",
    });
    // Each attempt row reads exactly what the one attempt classifier reads.
    const steps = run.steps as { inference?: { attempts: InferenceAttemptEvidence[] } }[];
    const attempts = steps.flatMap((step) => step.inference?.attempts ?? []);
    expect(rows.filter((row) => row.rowKind === "attempt")).toHaveLength(attempts.length);
    rows
      .filter((row) => row.rowKind === "attempt")
      .forEach((row, index) => {
        const expected = classifyInferenceAttempt(attempts[index]);
        expect([row.failureClass, row.failureLayer]).toEqual([
          expected?.class ?? null,
          expected?.layer ?? null,
        ]);
      });
    expect(rows[1]).toMatchObject({ failureClass: "contract-shape", failureLayer: "inference" });
    expect(rows[2]).toMatchObject({ failureClass: null, failureLayer: null });
    expect(
      queryRunIndex(rows, {
        where: where([["rowKind", ["run", "step"]]]),
        groupBy: ["rowKind", "failureClass", "failureLayer"],
      }).groups.map((group) => group.key),
    ).toEqual([
      { rowKind: "run", failureClass: "unknown", failureLayer: "inference" },
      { rowKind: "step", failureClass: "model-content", failureLayer: "workflow" },
    ]);
  });

  it("derives no class for a record without failure and refuses a forged one by name", () => {
    const rows = rowsOf({
      ...record("run-forged", "2026-09-23T09:00:00.000Z", [
        { id: "check-links", status: "failed" },
        {
          id: "lint-documentation",
          status: "failed",
          failure: failed("CANARY class", "workflow", "technical-trace-incomplete"),
        },
        {
          id: "review-documentation",
          status: "failed",
          failure: { ...failed("model-content", "workflow", "x"), note: "CANARY extra key" },
        },
      ]),
    });
    expect(rows[0]).toMatchObject({ failureClass: null, failureLayer: null, omittedFields: [] });
    expect(rows[1]).toMatchObject({ failureClass: null, failureLayer: null, omittedFields: [] });
    for (const row of [rows[2]!, rows[3]!]) {
      expect(row).toMatchObject({ failureClass: null, failureLayer: null });
      expect(row.omittedFields).toEqual(["failureClass", "failureLayer", "failureCode"]);
    }
    expect(JSON.stringify(rows)).not.toContain("CANARY");
  });

  it("refuses telemetry the shared validator rejects, naming every telemetry column", () => {
    const rows = rowsOf(
      record("run-forged-telemetry", "2026-09-23T09:00:00.000Z", [
        {
          id: "verify-technical-accuracy",
          status: "failed",
          inference: {
            attempts: [
              attempt(1, "malformed-response", {
                modelTelemetry: telemetry({ finishReason: "CANARY provider token" }),
              }),
              // A provider error cannot end a succeeded attempt.
              attempt(2, "succeeded", {
                modelTelemetry: telemetry({ providerError: { class: "network" } }),
              }),
              attempt(3, "timeout", { modelTelemetry: telemetry({ providerLatencyMs: -1 }) }),
            ],
          },
        },
      ]),
    );
    const columns = [
      "finishReason",
      "providerErrorClass",
      "httpStatus",
      "outputTokens",
      "outputAllowance",
      "providerLatencyMs",
    ];
    for (const row of rows.slice(1)) {
      expect(row.omittedFields).toEqual(columns);
      for (const column of columns) expect(row[column as keyof RunIndexRowV1]).toBeNull();
    }
    expect(JSON.stringify(rows)).not.toContain("CANARY");
  });

  it("reads failureClass and finishReason from a row an earlier revision wrote as null", () => {
    const [runRow, attemptRow] = rowsOf(telemetryRun());
    // Revision 2 held the attempt outcome and the raw provider token in these
    // columns. A raw token can spell a normalized value (OpenAI's `length`)
    // while its siblings do not (Anthropic's `max_tokens`), so every one reads
    // as unavailable rather than a biased few surviving.
    const revisionTwo = (row: RunIndexRowV1) => {
      const {
        failureLayer: _layer,
        providerErrorClass: _class,
        httpStatus: _status,
        outputTokens: _tokens,
        outputAllowance: _allowance,
        providerLatencyMs: _latency,
        ...older
      } = row;
      return JSON.parse(
        JSON.stringify({
          ...older,
          projectionRevision: 2,
          failureClass: "malformed-response",
          finishReason: "length",
        }),
      ) as unknown;
    };
    for (const row of [runRow!, attemptRow!]) {
      expect(decodeRunIndexRow(revisionTwo(row))).toMatchObject({
        projectionRevision: 2,
        failureClass: null,
        failureLayer: null,
        finishReason: null,
        providerErrorClass: null,
        httpStatus: null,
        outputTokens: null,
        outputAllowance: null,
        providerLatencyMs: null,
      });
      expect(decodeRunIndexRow(JSON.parse(JSON.stringify(row)))).toEqual(row);
    }
  });
});

/**
 * Attempt classes are the attempt classifier's reading, so each attempt row
 * names that classifier by a digest of its behavior.
 */
describe("run index attempt classifier identity (#1236)", () => {
  const classify: AttemptClassifier = classifyInferenceAttempt;
  const telemetryOf = (attempt: InferenceAttemptEvidence | undefined) =>
    (attempt as { modelTelemetry?: { providerError?: { class?: string } } } | undefined)
      ?.modelTelemetry;
  const lastStop = (attempt: InferenceAttemptEvidence | undefined) =>
    (attempt as { turns?: { rawStopReason?: string }[] } | undefined)?.turns?.at(-1)?.rawStopReason;

  const entry = classifierEntryFile();
  const inferenceClassifier = resolve(
    dirname(entry),
    "failure-classification",
    `inference-classification${extname(entry)}`,
  );
  const readUtf8 = (file: string) => readFileSync(file, "utf8");
  const sourceDigestWith = (edit: (source: string) => string, file = entry) => {
    const original = readUtf8(file);
    const edited = edit(original);
    // The edit must apply, or the test would prove nothing.
    expect(edited).not.toBe(original);
    return classifierSourceDigest(entry, (path) => (path === file ? edited : readUtf8(path)));
  };

  it("names this DocsFab's classifier by its source and its behavior, once", () => {
    const expected = createHash("sha256")
      .update(`source=${classifierSourceDigest(entry, readUtf8)}\n`)
      .update(`retry-rule-source=${classifierSourceDigest(retryRuleEntryFile(), readUtf8)}\n`)
      .update(`behavior=${attemptClassifierDigest(classify)}\n`)
      .digest("hex");
    expect(attemptClassifierSha256()).toMatch(/^[0-9a-f]{64}$/u);
    expect(attemptClassifierSha256()).toBe(expected);
  });

  it("hashes the classifier module and the local modules it value-imports", () => {
    const root = dirname(dirname(entry));
    const files = classifierSourceFiles(entry, readUtf8).map((file) => relative(root, file));
    expect(files).toEqual(
      expect.arrayContaining([
        `operator/failure-classification${extname(entry)}`,
        `operator/failure-class${extname(entry)}`,
        `operator/situation-catalog${extname(entry)}`,
        `config/inference-rejection-limits${extname(entry)}`,
        `records/composition-execution-error${extname(entry)}`,
      ]),
    );
    // The classifier loads only the error leaf, not the aggregate's runtime graph.
    expect(files).not.toContain(`records/composition-execution${extname(entry)}`);
    // Authored quality binding validation reaches inference evidence and its
    // value-imported record vocabularies; the classifier identity covers them.
    expect(files).toContain(`records/contracts${extname(entry)}`);
  });

  /** Move the output-limit check after the coded-rejection check, so the code wins. */
  const swapPrecedence = (source: string): string => {
    const start = source.indexOf(REJECTION_CHECK_START);
    const end = start < 0 ? -1 : source.indexOf(BLOCK_END, start);
    const anchor = source.indexOf(CANCELLED_CHECK);
    if (start < 0 || end < 0 || anchor < 0 || anchor > start) return source;
    const block = source.slice(start, end + BLOCK_END.length);
    const insertAt = anchor + CANCELLED_CHECK.length;
    return `${source.slice(0, insertAt)}${block}${source.slice(insertAt, start)}${source.slice(start + block.length)}`;
  };
  const readFirstTurn = (source: string): string =>
    source.replace("attempt.turns.at(-1)", "attempt.turns.at(0)");

  it.each([
    ["the rejection code winning over an output-limit stop (precedence swap)", swapPrecedence],
    ["reading the first turn instead of the last", readFirstTurn],
  ])("changes the source digest for a logic edit: %s", (_label, edit) => {
    expect(sourceDigestWith(edit, inferenceClassifier)).not.toBe(
      classifierSourceDigest(entry, readUtf8),
    );
  });

  it("resolves each .js specifier in a mixed .ts and .js import graph to the file that exists", () => {
    const tree = mkdtempSync(join(tmpdir(), "docsfab-classifier-graph-"));
    try {
      const write = (path: string, text: string) => {
        mkdirSync(dirname(join(tree, path)), { recursive: true });
        writeFileSync(join(tree, path), text);
      };
      // A checkout: `.ts` sources imported as `.js`, a plain `.js` module
      // (with a `.d.ts`), a `.ts` source beside a checked-in `.js` twin, and a
      // type-only import of a module that does not exist.
      write(
        "src/operator/failure-classification.ts",
        [
          'import { a } from "./a.js";',
          'import { core } from "../security/core.js";',
          'import { twin } from "./twin.js";',
          'import type { Only } from "./type-only.js";',
          "",
        ].join("\n"),
      );
      write("src/operator/a.ts", "export const a = 1;\n");
      write(
        "src/security/core.js",
        'import { helper } from "./helper.js";\nexport const core = helper;\n',
      );
      write("src/security/core.d.ts", "export declare const core: number;\n");
      write("src/security/helper.js", "export const helper = 1;\n");
      write("src/operator/twin.ts", "export const twin = 1;\n");
      write("src/operator/twin.js", "export const twin = 2;\n");
      // The package: everything is `.js`.
      write(
        "dist/operator/failure-classification.js",
        'import { a } from "./a.js";\nimport { core } from "../security/core.js";\n',
      );
      write("dist/operator/a.js", "export const a = 1;\n");
      write("dist/security/core.js", "export const core = 1;\n");
      const read = (file: string) => readFileSync(file, "utf8");
      const relativeFiles = (root: string) =>
        classifierSourceFiles(
          join(tree, root, "operator/failure-classification" + (root === "src" ? ".ts" : ".js")),
          read,
        ).map((file) => relative(join(tree, root), file));
      expect(relativeFiles("src")).toEqual([
        "operator/a.ts",
        "operator/failure-classification.ts",
        "operator/twin.ts",
        "security/core.js",
        "security/helper.js",
      ]);
      expect(relativeFiles("dist")).toEqual([
        "operator/a.js",
        "operator/failure-classification.js",
        "security/core.js",
      ]);
      // A module the classifier imports but that is missing refuses by name.
      write("src/operator/a.ts", 'import { gone } from "./gone.js";\nexport const a = gone;\n');
      expect(() => relativeFiles("src")).toThrow(
        /cannot find attempt classifier module \.\/gone\.js/u,
      );
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it("changes the source digest for an edit to an imported classification module", () => {
    const vocabulary = resolve(dirname(entry), `failure-class${extname(entry)}`);
    expect(
      sourceDigestWith((source) => source.replace('"flake",', '"flake-renamed",'), vocabulary),
    ).not.toBe(classifierSourceDigest(entry, readUtf8));
  });

  it.each([
    [
      "a category's class, as the #1186 follow-up's provider-terminal split",
      ((attempt) => {
        const failure = classify(attempt);
        return failure?.code === "provider-terminal"
          ? { ...failure, class: "infrastructure" as const }
          : failure;
      }) satisfies AttemptClassifier,
    ],
    [
      "one rejection table entry",
      ((attempt) => {
        const failure = classify(attempt);
        return failure?.code === "inventory-dimension-facts"
          ? { ...failure, class: "contract-shape" as const }
          : failure;
      }) satisfies AttemptClassifier,
    ],
    [
      "logic that starts reading the provider error class",
      ((attempt) => {
        const failure = classify(attempt);
        return failure && telemetryOf(attempt)?.providerError?.class === "network"
          ? { ...failure, class: "infrastructure" as const }
          : failure;
      }) satisfies AttemptClassifier,
    ],
    [
      "logic that treats another provider stop token as an output limit",
      ((attempt) => {
        const failure = classify(attempt);
        return failure && lastStop(attempt) === "stop_sequence"
          ? { ...failure, class: "bound" as const }
          : failure;
      }) satisfies AttemptClassifier,
    ],
    [
      "a layer",
      ((attempt) => {
        const failure = classify(attempt);
        return failure?.code === "timeout" ? { ...failure, layer: "host" as const } : failure;
      }) satisfies AttemptClassifier,
    ],
  ])("changes the digest when a class changes: %s", (_label, changed) => {
    expect(attemptClassifierDigest(changed)).not.toBe(attemptClassifierDigest(classify));
  });

  it("changes the digest when only a catalogued code changes, because rows store the code", () => {
    const renamed: AttemptClassifier = (attempt) => {
      const failure = classify(attempt);
      return failure ? { ...failure, code: `${failure.code}-renamed` } : failure;
    };
    expect(attemptClassifierDigest(renamed)).not.toBe(attemptClassifierDigest(classify));
  });

  it("stamps attempt rows only and reads another classifier's attempt class as null", () => {
    const rows = rowsOf({
      ...record("run-classifier", "2026-09-23T09:00:00.000Z", [
        {
          id: "evaluate-document-quality",
          status: "failed",
          failure: { class: "unknown", layer: "inference", code: "provider-terminal" },
          inference: { attempts: [attempt(1, "provider-terminal")] },
        },
        {
          id: "lint-documentation",
          status: "failed",
          failure: { class: "model-content", layer: "workflow", code: "x" },
        },
      ]),
      failure: { class: "unknown", layer: "inference", code: "provider-terminal" },
    });
    expect(rows.map((row) => [row.rowKind, row.attemptClassifierSha256])).toEqual([
      ["run", null],
      ["attempt", attemptClassifierSha256()],
      ["step", null],
    ]);
    const older = (row: RunIndexRowV1) =>
      decodeRunIndexRow(
        JSON.parse(JSON.stringify({ ...row, attemptClassifierSha256: "0".repeat(64) })),
      );
    expect(older(rows[1]!)).toMatchObject({
      rowKind: "attempt",
      attemptClassifierSha256: "0".repeat(64),
      failureClass: null,
      failureLayer: null,
      outcome: "provider-terminal",
    });
    // Recorded run and step classes do not depend on the attempt classifier.
    expect(older(rows[0]!)).toMatchObject({ failureClass: "unknown", failureLayer: "inference" });
    expect(older(rows[2]!)).toMatchObject({
      failureClass: "model-content",
      failureLayer: "workflow",
    });
    expect(decodeRunIndexRow(JSON.parse(JSON.stringify(rows[1])))).toMatchObject({
      failureClass: "unknown",
      failureLayer: "inference",
    });
  });
});

describe("run index query semantics", () => {
  const verify = (attempts: unknown[]) => ({
    id: "verify-technical-accuracy",
    status: "failed",
    inference: { attempts },
  });
  const rows = [
    ...rowsOf(
      record("run-1", "2026-09-22T08:00:00.000Z", [
        verify([
          attempt(1, "malformed-response", {
            rejection: { code: "inventory-fact-locators", location: "$.factInventory" },
          }),
        ]),
      ]),
      { snapshotId: "s1" },
    ),
    ...rowsOf(
      record("run-2", "2026-09-23T08:00:00.000Z", [
        verify([
          attempt(1, "malformed-response", {
            rejection: { code: "inventory-fact-locators", location: "$.factInventory" },
          }),
          attempt(2, "timeout"),
          attempt(3, "succeeded"),
        ]),
      ]),
      { snapshotId: "s2" },
    ),
    ...rowsOf(
      record("run-3", "2026-09-23T09:00:00.000Z", [
        {
          id: "derive-source-obligations",
          status: "succeeded",
          inference: {
            attempts: [
              attempt(1, "malformed-response", {
                rejection: { code: "inconsistent-status", location: "$.dimensions[].reason" },
              }),
              attempt(2, "succeeded", { model: { provider: "p", model: "fixture/model-b" } }),
            ],
          },
        },
      ]),
      { snapshotId: "s3" },
    ),
  ];

  it("groups by outcome over the newest snapshots with shares of the population", () => {
    const result = queryRunIndex(rows, { where: new Map(), groupBy: ["outcome"] });
    expect(result.population).toEqual({ rows: 6, runs: 3, rowsWithOmittedFields: 0 });
    expect(result.groups).toEqual([
      { key: { outcome: "malformed-response" }, rows: 3, runs: 3, share: 0.5 },
      { key: { outcome: "succeeded" }, rows: 2, runs: 2, share: 2 / 6 },
      { key: { outcome: "timeout" }, rows: 1, runs: 1, share: 1 / 6 },
    ]);
  });

  it("answers the rate of one rejection code at one step for one model since a date", () => {
    const result = queryRunIndex(rows, {
      where: where([
        ["stepId", ["verify-technical-accuracy"]],
        ["model", ["fixture/model-a"]],
      ]),
      sinceMs: Date.parse("2026-09-23T00:00:00.000Z"),
      groupBy: ["rejectionCode"],
    });
    // Only run-2 is on or after the date: three attempts, one with the code.
    expect(result.population).toMatchObject({ rows: 3, runs: 1 });
    expect(result.groups).toEqual([
      { key: { rejectionCode: null }, rows: 2, runs: 1, share: 2 / 3 },
      { key: { rejectionCode: "inventory-fact-locators" }, rows: 1, runs: 1, share: 1 / 3 },
    ]);
  });

  it("ORs values of one field, ANDs fields, and matches unavailable to null", () => {
    const result = queryRunIndex(rows, {
      where: where([
        ["outcome", ["timeout", "succeeded"]],
        ["rejectionCode", ["unavailable"]],
        ["runId", ["run-2", "run-3"]],
      ]),
      groupBy: ["runId", "attempt"],
    });
    expect(result.groups.map((group) => group.key)).toEqual([
      { runId: "run-2", attempt: 2 },
      { runId: "run-2", attempt: 3 },
      { runId: "run-3", attempt: 2 },
    ]);
  });

  it("counts only the newest snapshot of a re-indexed run", () => {
    const newer = rowsOf(
      record("run-1", "2026-09-22T08:00:00.000Z", [verify([attempt(1, "succeeded")])]),
      { snapshotId: "s1-again" },
    );
    const result = queryRunIndex([...rows, ...newer], {
      where: where([["runId", ["run-1"]]]),
      groupBy: ["failureClass"],
    });
    // The older snapshot's run row and attempt row are both superseded.
    expect(result.supersededRows).toBe(2);
    expect(result.groups).toEqual([{ key: { failureClass: null }, rows: 1, runs: 1, share: 1 }]);
  });

  it("uses an exclusive until bound and reports an empty population without dividing by zero", () => {
    const result = queryRunIndex(rows, {
      where: new Map(),
      untilMs: Date.parse("2026-09-22T08:00:00.000Z"),
      groupBy: [],
    });
    expect(result.population).toMatchObject({ rows: 0, runs: 0 });
    expect(result.groups).toEqual([]);
  });
});

describe("run index query denominator", () => {
  const stepB = (status: string, attempts: unknown[] = []) => ({
    id: "step-b",
    status,
    ...(attempts.length > 0 ? { inference: { attempts } } : {}),
  });
  const stepA = (status: string) => ({
    id: "step-a",
    status,
    inference: { attempts: [attempt(1, status === "failed" ? "timeout" : "succeeded")] },
  });
  // Five runs fail at step A and leave step B pending; five reach B and pass.
  const rows = Array.from({ length: 10 }, (_, index) =>
    rowsOf(
      {
        ...record(`run-${String(index)}`, "2026-09-23T09:00:00.000Z", [
          stepA(index < 5 ? "failed" : "succeeded"),
          index < 5 ? stepB("pending") : stepB("succeeded", [attempt(1, "succeeded")]),
        ]),
        status: index < 5 ? "failed" : "succeeded",
      },
      { snapshotId: `snapshot-${String(index)}` },
    ),
  ).flat();

  it("counts only attempts by default, so a step that never ran does not dilute its rate", () => {
    const result = queryRunIndex(rows, {
      where: where([["stepId", ["step-b"]]]),
      groupBy: ["outcome"],
    });
    expect(result.rowKindDefaulted).toBe(true);
    expect(result.appliedWhere.get("rowKind")).toEqual(["attempt"]);
    expect(result.population).toMatchObject({ rows: 5, runs: 5 });
    expect(result.groups).toEqual([{ key: { outcome: "succeeded" }, rows: 5, runs: 5, share: 1 }]);
  });

  it("counts runs by status only when run rows are asked for", () => {
    const result = queryRunIndex(rows, {
      where: where([["rowKind", ["run"]]]),
      groupBy: ["runStatus"],
    });
    expect(result.rowKindDefaulted).toBe(false);
    expect(result.groups).toEqual([
      { key: { runStatus: "failed" }, rows: 5, runs: 5, share: 0.5 },
      { key: { runStatus: "succeeded" }, rows: 5, runs: 5, share: 0.5 },
    ]);
  });

  it("drops a snapshot with missing rows and falls back to the run's previous complete one", () => {
    const older = rowsOf(record("cut", "2026-09-23T09:00:00.000Z", [stepA("failed")]), {
      snapshotId: "older",
    });
    const newer = rowsOf(
      record("cut", "2026-09-23T09:00:00.000Z", [stepA("failed"), stepA("succeeded")]),
      { snapshotId: "newer" },
    );
    // An interrupted append kept only the first two of the newer snapshot's three rows.
    const result = queryRunIndex([...older, ...newer.slice(0, 2)], {
      where: new Map(),
      groupBy: ["snapshotId" as never],
    });
    expect(result.incompleteSnapshots).toBe(1);
    expect(result.population.rows).toBe(1);
    expect(result.groups[0]!.key).toEqual({ snapshotId: "older" });
  });
});

describe("run index verifier disagreement count (#1439)", () => {
  function compared(provisionalStepId: string, rows: number): Record<string, unknown> {
    return {
      schemaVersion: 1,
      kind: "docsfab-verifier-disagreement",
      provisionalStepId,
      status: "compared",
      rows: Array.from({ length: rows }, (_, index) => ({
        kind: "canonical-issue",
        canonicalIssueId: `TECH-${index + 1}`,
        category: "completeness",
      })),
    };
  }

  const UNAVAILABLE = {
    schemaVersion: 1,
    kind: "docsfab-verifier-disagreement",
    provisionalStepId: "provisional-technical-verification",
    status: "unavailable",
    reason: "provisional-summary-undecodable",
  };

  function technicalRecord(id: string, first: unknown, revised: unknown): Record<string, unknown> {
    const step = (stepId: string, field: unknown) => ({
      id: stepId,
      status: "succeeded",
      inference: { attempts: [attempt(1, "succeeded")] },
      ...(field === undefined ? {} : { verifierDisagreement: field }),
    });
    return record(id, "2026-09-25T09:00:00.000Z", [
      step("provisional-technical-verification", undefined),
      step("verify-technical-accuracy", first),
      step("provisional-revised-technical-verification", undefined),
      step("verify-revised-technical-accuracy", revised),
    ]);
  }

  function runRow(value: Record<string, unknown>): RunIndexRowV1 {
    const row = rowsOf(value).find((candidate) => candidate.rowKind === "run");
    if (!row) throw new Error("fixture projected no run row");
    return row;
  }

  it("sums compared pairs on the run row and leaves every other row null", () => {
    const rows = rowsOf(
      technicalRecord(
        "run-disagree",
        compared("provisional-technical-verification", 8),
        compared("provisional-revised-technical-verification", 1),
      ),
    );
    expect(rows.map((row) => [row.rowKind, row.stepId, row.verifierDisagreementCount])).toEqual([
      ["run", null, 9],
      ["attempt", "provisional-technical-verification", null],
      ["attempt", "verify-technical-accuracy", null],
      ["attempt", "provisional-revised-technical-verification", null],
      ["attempt", "verify-revised-technical-accuracy", null],
    ]);
    expect(rows[0]!.omittedFields).toEqual([]);
  });

  it("reads compared agreement as 0 and an uncompared run as null", () => {
    const agree = runRow(
      technicalRecord("run-agree", compared("provisional-technical-verification", 0), undefined),
    );
    expect(agree.verifierDisagreementCount).toBe(0);
    // Adjacent: a pair whose comparison was unavailable is not agreement.
    const unavailable = runRow(technicalRecord("run-unavailable", UNAVAILABLE, undefined));
    expect(unavailable.verifierDisagreementCount).toBeNull();
    expect(unavailable.omittedFields).toEqual([]);
    // A workflow without the pair, or a record written before the field.
    const none = runRow(technicalRecord("run-none", undefined, undefined));
    expect(none.verifierDisagreementCount).toBeNull();
    // Unavailable beside compared is not a partial sum: that pair's count is
    // unknown, so the run's is too, with or without compared rows beside it.
    for (const rows of [1, 0]) {
      const mixed = runRow(
        technicalRecord(
          `run-mixed-${rows}`,
          UNAVAILABLE,
          compared("provisional-revised-technical-verification", rows),
        ),
      );
      expect(mixed.verifierDisagreementCount).toBeNull();
      expect(mixed.omittedFields).toEqual([]);
    }
    // Adjacent: both pairs compared sums both, zero rows included.
    const both = runRow(
      technicalRecord(
        "run-both",
        compared("provisional-technical-verification", 0),
        compared("provisional-revised-technical-verification", 1),
      ),
    );
    expect(both.verifierDisagreementCount).toBe(1);
  });

  it("refuses a malformed field by name and never groups the run as agreement", () => {
    // A malformed field beside a compared pair with zero rows: the partial
    // sum would be 0, which reads as agreement.
    const forged = technicalRecord(
      "run-forged",
      { ...compared("provisional-technical-verification", 2), status: "agreed" },
      compared("provisional-revised-technical-verification", 0),
    );
    const row = runRow(forged);
    expect(row.verifierDisagreementCount).toBeNull();
    expect(row.omittedFields).toEqual(["verifierDisagreementCount"]);
    expect(
      queryRunIndex(
        rowsOf(forged).map(
          (candidate) => decodeRunIndexRow(JSON.parse(JSON.stringify(candidate)))!,
        ),
        {
          where: where([["rowKind", ["run"]]]),
          groupBy: ["verifierDisagreementCount"],
        },
      ).groups,
    ).toEqual([{ key: { verifierDisagreementCount: null }, rows: 1, runs: 1, share: 1 }]);
    // The same refusal beside a pair that disagrees is not a partial count.
    const beside = runRow(
      technicalRecord("run-forged-beside", compared("provisional-technical-verification", 1), {
        ...compared("provisional-revised-technical-verification", 0),
        rows: "none",
      }),
    );
    expect(beside.verifierDisagreementCount).toBeNull();
    expect(beside.omittedFields).toEqual(["verifierDisagreementCount"]);
  });

  it("round-trips the count through a stored line and reads a revision-4 row as null", () => {
    const current = runRow(
      technicalRecord("run-stored", compared("provisional-technical-verification", 3), undefined),
    );
    expect(current.projectionRevision).toBe(RUN_INDEX_PROJECTION_REVISION);
    const stored = decodeRunIndexRow(JSON.parse(JSON.stringify(current)));
    expect(stored).toEqual(current);
    expect(stored!.verifierDisagreementCount).toBe(3);

    const { verifierDisagreementCount: _count, ...fields } = current;
    const older = decodeRunIndexRow(
      JSON.parse(JSON.stringify({ ...fields, projectionRevision: 4 })),
    );
    expect(older).toBeDefined();
    expect(older!.projectionRevision).toBe(4);
    expect(older!.verifierDisagreementCount).toBeNull();
    expect(Object.hasOwn(older!, "verifierDisagreementCount")).toBe(true);

    // A query reads whole snapshots, so pass every row the projection wrote.
    const snapshot = rowsOf(
      technicalRecord("run-stored", compared("provisional-technical-verification", 3), undefined),
    ).map((row) => decodeRunIndexRow(JSON.parse(JSON.stringify(row)))!);
    expect(
      queryRunIndex(snapshot, {
        where: where([["rowKind", ["run"]]]),
        groupBy: ["verifierDisagreementCount"],
      }).groups,
    ).toEqual([{ key: { verifierDisagreementCount: 3 }, rows: 1, runs: 1, share: 1 }]);
  });
});

describe("run index run-row model and DocsFab revision (#1688)", () => {
  const profile = (apiFormat: string, digit: string) => ({ apiFormat, sha256: digit.repeat(64) });
  const modelA = {
    provider: "nvidia-api-catalog",
    model: "nvidia/model-a",
    profile: profile("openai-completions", "1"),
  };
  const modelB = {
    provider: "openai-api",
    model: "openai/model-b",
    profile: profile("openai-responses", "2"),
  };
  const withModels = (id: string, models: unknown) => ({
    ...record(id, "2026-09-30T09:00:00.000Z", []),
    models,
  });
  const runRowOf = (value: unknown, overrides: Partial<RunIndexSnapshotContext> = {}) =>
    rowsOf(value, overrides).find((row) => row.rowKind === "run")!;

  it("copies the run's one recorded model onto the run row", () => {
    expect(runRowOf(withModels("run-one-model", [modelA]))).toMatchObject({
      provider: "nvidia-api-catalog",
      model: "nvidia/model-a",
      apiFormat: "openai-completions",
      modelProfileSha256: "1".repeat(64),
      omittedFields: [],
    });
    expect(RUN_INDEX_PROJECTION_REVISION).toBeGreaterThanOrEqual(6);
  });

  it("joins a mixed run's distinct values in sorted order and knows a column only when every model has it", () => {
    expect(runRowOf(withModels("run-mixed", [modelB, modelA, { ...modelA }]))).toMatchObject({
      provider: "nvidia-api-catalog+openai-api",
      model: "nvidia/model-a+openai/model-b",
      apiFormat: "openai-completions+openai-responses",
      modelProfileSha256: `${"1".repeat(64)}+${"2".repeat(64)}`,
    });
    const { profile: _profile, ...bareB } = modelB;
    expect(runRowOf(withModels("run-partial", [modelA, bareB]))).toMatchObject({
      provider: "nvidia-api-catalog+openai-api",
      model: "nvidia/model-a+openai/model-b",
      apiFormat: null,
      modelProfileSha256: null,
      omittedFields: [],
    });
  });

  it("reads a run without recorded models as unavailable and refuses a malformed list by name", () => {
    for (const models of [undefined, []]) {
      expect(runRowOf(withModels("run-no-model", models))).toMatchObject({
        provider: null,
        model: null,
        omittedFields: [],
      });
    }
    for (const models of ["nvidia/model-a", [modelA, "nvidia/model-b"]]) {
      expect(runRowOf(withModels("run-bad-models", models))).toMatchObject({
        provider: null,
        model: null,
        apiFormat: null,
        modelProfileSha256: null,
        omittedFields: ["provider", "model", "apiFormat", "modelProfileSha256"],
      });
    }
    // A join over the field bound is refused whole, never cut.
    const long = { ...modelB, model: `openai/${"m".repeat(600)}` };
    expect(runRowOf(withModels("run-long", [modelA, long]))).toMatchObject({
      model: null,
      omittedFields: ["model"],
    });
    // Step and attempt rows keep their own model.
    const rows = rowsOf({
      ...withModels("run-steps", [modelA, modelB]),
      steps: [
        {
          id: "audit-documentation",
          status: "failed",
          inference: { attempts: [attempt(1, "timeout", { model: modelB })] },
        },
      ],
    });
    expect(rows.find((row) => row.rowKind === "attempt")).toMatchObject({
      model: "openai/model-b",
    });
  });

  it("stamps a build revision, marks a dirty build, and reads an unstamped or malformed identity as null", () => {
    const commit = "a".repeat(40);
    expect(docsfabBuildRevision({ schemaVersion: 1, commit, dirty: false })).toBe(commit);
    expect(docsfabBuildRevision({ schemaVersion: 1, commit, dirty: true })).toBe(`${commit}-dirty`);
    for (const identity of [
      { schemaVersion: 1, commit: null, dirty: null },
      { schemaVersion: 1, commit: "abc123", dirty: false },
      { schemaVersion: 1, commit, dirty: null },
      undefined,
    ]) {
      expect(docsfabBuildRevision(identity)).toBeNull();
    }
  });

  it("groups run rows by model and DocsFab revision", () => {
    const rows = [
      ...rowsOf(withModels("run-a", [modelA]), {
        snapshotId: "a",
        docsfabRevision: "c".repeat(40),
      }),
      ...rowsOf(withModels("run-b", [modelA]), {
        snapshotId: "b",
        docsfabRevision: "c".repeat(40),
      }),
      ...rowsOf(withModels("run-c", [modelB]), {
        snapshotId: "c",
        docsfabRevision: "d".repeat(40),
      }),
    ].map((row) => decodeRunIndexRow(JSON.parse(JSON.stringify(row)))!);
    expect(
      queryRunIndex(rows, {
        where: where([["rowKind", ["run"]]]),
        groupBy: ["model", "docsfabRevision"],
      }).groups,
    ).toEqual([
      {
        key: { model: "nvidia/model-a", docsfabRevision: "c".repeat(40) },
        rows: 2,
        runs: 2,
        share: 2 / 3,
      },
      {
        key: { model: "openai/model-b", docsfabRevision: "d".repeat(40) },
        rows: 1,
        runs: 1,
        share: 1 / 3,
      },
    ]);
  });
});

describe("run index run ends and retry decision rules (#1738)", () => {
  const failure = (failureClass: string, layer: string, code: string) => ({
    class: failureClass,
    layer,
    code,
  });
  const runRow = (rows: readonly RunIndexRowV1[]) => rows.find((row) => row.rowKind === "run")!;
  const stepRows = (rows: readonly RunIndexRowV1[]) => rows.filter((row) => row.rowKind === "step");

  it("distinguishes an exhausted reading ceiling from a record-only ceiling", () => {
    const hardToolCallCode =
      LIMIT_DEFINITION_BY_NAME[OPERATIONAL_LIMIT_NAMES.compositionMaxToolCallsPerStep]!.refusal;
    const indexedSource = (reading: number, records: number) => {
      const lease = {
        schemaVersion: 1,
        kind: "docsfab-pi-execution-lease-evidence",
        phase: "terminal",
        terminalReason: "hard-tool-call-ceiling",
        providerTurns: 4,
        toolCalls: {
          requested: reading + records,
          executed: reading + records,
          succeeded: reading + records,
          failed: 0,
          denied: 0,
          governanceBlocked: 0,
        },
        toolCallsByScope: { reading, answerRecord: records },
        answerRecordCallsAdmitted: records,
        toolCallCeilings: { reading: 8, answerRecord: 2 },
        chargeableAttemptCeiling: 10,
      };
      const rows = rowsOf({
        ...record("run-scoped-ceiling", "2026-10-09T09:00:00.000Z", [
          {
            id: "evaluate-document-quality",
            status: "failed",
            skill: "evaluate-document-quality",
            failure: failure("infrastructure", "workflow", hardToolCallCode),
            inference: {
              attempts: [
                attempt(1, "succeeded", {
                  executionLease: lease,
                  turns: [
                    { toolCalls: reading, maxToolCalls: 8, providerTurns: 4, maxProviderTurns: 16 },
                  ],
                }),
              ],
            },
          },
        ]),
        failure: failure("infrastructure", "workflow", hardToolCallCode),
      });
      return stepRows(rows)[0]?.executionCeilingSource;
    };

    expect(indexedSource(8, 1)).toBe("operator-override");
    expect(indexedSource(1, 2)).toBe("codes-mismatch");
  });

  it("names the step and code a quality refusal ended the run with, on one step row", () => {
    const rows = rowsOf({
      ...record("run-quality", "2026-10-01T09:00:00.000Z", [
        {
          id: "review-documentation",
          status: "succeeded",
          inference: { attempts: [] },
        },
        {
          id: "evaluate-document-quality",
          status: "failed",
          failure: failure("model-content", "workflow", "candidate-target-outside-scope"),
          qualityValidationRejection: {
            code: "candidate-target-outside-scope",
            location: "$.evaluation.target.paths",
          },
          inference: { attempts: [attempt(1, "succeeded")] },
        },
      ]),
      failure: failure("model-content", "workflow", "candidate-target-outside-scope"),
    });
    expect(runRow(rows)).toMatchObject({
      terminalStepId: "evaluate-document-quality",
      failureClass: "model-content",
      failureCode: "candidate-target-outside-scope",
    });
    const refused = stepRows(rows).filter((row) => row.stepId === "evaluate-document-quality");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      outcome: "failed",
      rejectionSource: "quality-validation",
      failureCode: "candidate-target-outside-scope",
    });
  });

  it("gives a step that failed after its final attempt succeeded its own step row", () => {
    const rows = rowsOf({
      ...record("run-workflow-layer", "2026-10-01T09:00:00.000Z", [
        {
          id: "audit-documentation",
          status: "failed",
          failure: failure("unknown", "workflow", "uncoded-error"),
          inference: { attempts: [attempt(1, "succeeded")] },
        },
      ]),
      failure: failure("unknown", "workflow", "uncoded-error"),
    });
    expect(rows.map((row) => row.rowKind)).toEqual(["run", "attempt", "step"]);
    expect(stepRows(rows)[0]).toMatchObject({
      stepId: "audit-documentation",
      outcome: "failed",
      rejectionSource: null,
      failureClass: "unknown",
      failureLayer: "workflow",
      failureCode: "uncoded-error",
    });
    expect(runRow(rows)).toMatchObject({
      terminalStepId: "audit-documentation",
      failureCode: "uncoded-error",
    });
  });

  it("names a step waiting for input, and no step for a failure after every step", () => {
    const waiting = rowsOf({
      ...record("run-waiting", "2026-10-01T09:00:00.000Z", [
        {
          id: "plan-documentation",
          status: "needs-input",
          inference: { attempts: [attempt(1, "succeeded")] },
        },
      ]),
      status: "needs-input",
    });
    expect(runRow(waiting)).toMatchObject({
      terminalStepId: "plan-documentation",
      failureCode: null,
    });
    expect(stepRows(waiting)[0]).toMatchObject({ outcome: "needs-input" });

    const afterSteps = rowsOf({
      ...record("run-finalization", "2026-10-01T09:00:00.000Z", [
        {
          id: "write-documentation",
          status: "succeeded",
          inference: { attempts: [attempt(1, "succeeded")] },
        },
      ]),
      failure: failure("unknown", "workflow", "uncoded-error"),
    });
    expect(runRow(afterSteps)).toMatchObject({
      terminalStepId: null,
      failureCode: "uncoded-error",
    });
    expect(stepRows(afterSteps)).toEqual([]);
  });

  it("names the first of several ended steps, and none on a run that succeeded", () => {
    const ended = rowsOf(
      record("run-two-failed", "2026-10-01T09:00:00.000Z", [
        { id: "audit-documentation", status: "succeeded" },
        { id: "derive-source-obligations", status: "failed" },
        { id: "review-documentation", status: "failed" },
      ]),
    );
    expect(runRow(ended).terminalStepId).toBe("derive-source-obligations");
    const succeeded = rowsOf({
      ...record("run-succeeded", "2026-10-01T09:00:00.000Z", [
        { id: "derive-source-obligations", status: "failed" },
      ]),
      status: "succeeded",
    });
    expect(runRow(succeeded)).toMatchObject({
      terminalStepId: null,
      failureCode: null,
    });
  });

  it("adds no step row when the step's final attempt failed, which its attempt row explains", () => {
    const rows = rowsOf({
      ...record("run-attempt-failed", "2026-10-01T09:00:00.000Z", [
        {
          id: "plan-documentation",
          status: "failed",
          failure: failure("contract-shape", "inference", "invalid-json"),
          inference: {
            attempts: [
              attempt(1, "malformed-response", {
                rejection: { code: "invalid-json", location: "$" },
              }),
            ],
          },
        },
      ]),
      failure: failure("contract-shape", "inference", "invalid-json"),
    });
    expect(rows.map((row) => row.rowKind)).toEqual(["run", "attempt"]);
    expect(rows[1]).toMatchObject({
      failureClass: "contract-shape",
      failureCode: "invalid-json",
    });
  });

  const execution = (
    attempts: Record<string, unknown>[],
    overrides: Record<string, unknown> = {},
  ) => ({
    configuredMaxRetries: 3,
    effectiveMaxRetries: 3,
    baseDelayMs: 500,
    maxDelayMs: 20_000,
    retryableCategories: ["malformed-response", "timeout"],
    replay: "read-only",
    attempts,
    ...overrides,
  });
  const decided = (outcome: string, retryDecision: string, extra: Record<string, unknown> = {}) =>
    attempt(1, outcome, {
      conditionRetryability: outcome === "succeeded" ? "not-applicable" : "eligible",
      retryDecision,
      retryScheduled: retryDecision === "retried",
      ...extra,
    });

  it.each([
    [
      "the write-step rule",
      decided("malformed-response", "declined"),
      { replay: "disabled-write-step" },
      "declined-write-step",
    ],
    [
      "a host refusal",
      decided("malformed-response", "declined", { retryable: false }),
      {},
      "declined-host-refusal",
    ],
    [
      "a decline no recorded field explains",
      decided("timeout", "declined", { retryable: true }),
      {},
      "declined-unexplained",
    ],
    ["a scheduled retry", decided("malformed-response", "retried"), {}, "retried"],
    ["an exhausted allowance", decided("malformed-response", "exhausted"), {}, "exhausted"],
  ])("carries %s as the rule runs show reads", (_label, decidedAttempt, overrides, rule) => {
    const run = {
      ...record("run-rule", "2026-10-01T09:00:00.000Z", [
        {
          id: "derive-source-obligations",
          status: "failed",
          inference: execution([decidedAttempt], overrides),
        },
      ]),
    };
    const row = rowsOf(run).find((candidate) => candidate.rowKind === "attempt")!;
    expect(row.retryDecisionRule).toBe(rule);
    expect(row.retryDecisionRule).toBe(
      readRunRetryDispositions(run as unknown as RunRecord)[0]!.decisionToken,
    );
  });

  it("stores an unreadable decision as null, not as the query's unavailable token", () => {
    const row = rowsOf(
      record("run-no-pair", "2026-10-01T09:00:00.000Z", [
        {
          id: "derive-source-obligations",
          status: "failed",
          inference: execution([attempt(1, "malformed-response")]),
        },
      ]),
    ).find((candidate) => candidate.rowKind === "attempt")!;
    expect(row.retryDecisionRule).toBeNull();
    expect(JSON.parse(JSON.stringify(row))).toMatchObject({
      retryDecisionRule: null,
    });
  });

  it("reads another classifier's attempt code and rule as null, and an earlier row's new fields as null", () => {
    const rows = rowsOf({
      ...record("run-stale", "2026-10-01T09:00:00.000Z", [
        {
          id: "derive-source-obligations",
          status: "failed",
          failure: failure("unknown", "inference", "timeout"),
          inference: execution([decided("timeout", "declined", { retryable: true })]),
        },
      ]),
      failure: failure("unknown", "inference", "timeout"),
    });
    const stored = (row: RunIndexRowV1, overrides: Record<string, unknown>) =>
      decodeRunIndexRow({
        ...(JSON.parse(JSON.stringify(row)) as object),
        ...overrides,
      })!;
    const attemptRow = rows.find((row) => row.rowKind === "attempt")!;
    expect(stored(attemptRow, {})).toMatchObject({
      failureCode: "timeout",
      retryDecisionRule: "declined-unexplained",
    });
    expect(stored(attemptRow, { attemptClassifierSha256: "0".repeat(64) })).toMatchObject({
      failureCode: null,
      retryDecisionRule: null,
    });
    // Recorded run causes do not depend on the attempt classifier.
    expect(stored(runRow(rows), { attemptClassifierSha256: "0".repeat(64) })).toMatchObject({
      failureCode: "timeout",
      terminalStepId: "derive-source-obligations",
    });
    const newFields = [
      "failureCode",
      "terminalStepId",
      "retryDecisionRule",
      "attemptOutputTokens",
      "continuations",
      "firstFinishReason",
      "answerOutputTokens",
    ] as const;
    for (const row of rows) {
      const earlier = JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
      for (const field of newFields) delete earlier[field];
      const decoded = decodeRunIndexRow({ ...earlier, projectionRevision: 6 })!;
      for (const field of newFields) expect(decoded[field]).toBeNull();
    }
  });

  it.each([9, 10, 11, 12])(
    "reads a revision %i attempt row without rejection-subject fields as null, so runs import re-projects it",
    (revision) => {
      const [row] = rowsOf(
        record("run-subject", "2026-10-01T09:00:00.000Z", [
          {
            id: "derive-source-obligations",
            status: "failed",
            inference: execution([
              attempt(1, "malformed-response", {
                retryable: false,
                rejection: {
                  code: "unauthorized-source",
                  location: "$.dimensions[].sourceLocators[]",
                },
                rejectionSubject: { kind: "source-path", path: "docs/guide.md" },
              }),
            ]),
          },
        ]),
      ).filter((candidate) => candidate.rowKind === "attempt");
      expect(row).toMatchObject({ rejectedSourcePath: "docs/guide.md" });
      const subjectFields = [
        "rejectedSourcePath",
        "declaredChangedPaths",
        "observedChangedPaths",
        "rejectionSubjectWithheld",
      ] as const;
      const earlier = JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
      for (const field of subjectFields) delete earlier[field];
      const decoded = decodeRunIndexRow({ ...earlier, projectionRevision: revision })!;
      for (const field of subjectFields) expect(decoded[field]).toBeNull();
      // runs import re-projects every stored snapshot below the current revision.
      expect(decoded.projectionRevision).toBeLessThan(RUN_INDEX_PROJECTION_REVISION);
    },
  );
});
