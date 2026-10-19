// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { collectCellEvidence } from "../scripts/model-matrix/evidence.mjs";
import { renderReport, taskScore } from "../scripts/model-matrix/report.mjs";

const cell = {
  model: "example/model",
  workflow: "write",
  task: "task-a",
  fixture: "corpus-a",
  rep: 1,
  providerId: "nvidia-api-catalog",
  baseUrl: "https://api.example/catalog",
  status: "failed",
};

describe("model matrix cell evidence", () => {
  it("distinguishes structured provider failures by exact route", () => {
    const evidence = collectCellEvidence({
      cell,
      record: {
        status: "failed",
        failures: [
          {
            scope: "step",
            code: "provider-request-failed",
            providerErrorClass: "rate-limit",
            httpStatus: 429,
          },
        ],
        steps: [{ id: "draft", status: "failed", failureCode: "provider-request-failed" }],
      },
    });
    expect(evidence.classification).toBe("provider_error");
    expect(evidence.route.provider).toBe("API Catalog");
    expect(evidence.failure.code).toBe("provider-request-failed");
  });

  it("classifies output contract and output limit separately", () => {
    const contract = collectCellEvidence({
      cell,
      record: {
        status: "failed",
        failures: [{ code: "output-contract-invalid", rejectionCode: "schema-mismatch" }],
        steps: [{ id: "draft", status: "failed", failureCode: "output-contract-invalid" }],
      },
    });
    const limit = collectCellEvidence({
      cell,
      record: {
        status: "failed",
        failures: [{ code: "output-limit-reached" }],
        steps: [{ id: "draft", status: "failed", failureCode: "output-limit-reached" }],
      },
    });
    expect(contract.classification).toBe("integration_output_contract");
    expect(limit.classification).toBe("output_limit");
  });

  it("keeps generic timeout ambiguous and summarizes attempted and missing steps", () => {
    const evidence = collectCellEvidence({
      cell,
      record: {
        status: "failed",
        failures: [{ code: "timeout" }],
        steps: [
          {
            id: "draft",
            status: "succeeded",
            attempts: [
              { status: "failed", failureCode: "timeout", durationMs: 120 },
              { status: "succeeded", durationMs: 40 },
            ],
          },
        ],
      },
      plannedCell: { ...cell, plannedSteps: ["draft", "review"] },
    });
    expect(evidence.classification).toBe("unknown");
    expect(evidence.steps[0].attempts).toHaveLength(2);
    expect(evidence.counts).toEqual({ succeeded: 1, failed: 0, unattempted: 1, running: 0 });
  });

  it("extracts statuses, retry telemetry, and output limits from the captured run-record shape", () => {
    const record = {
      status: "failed",
      durationMs: 421090,
      usage: { input: 1200, output: 480, total: 1680 },
      failure: { code: "output-limit-reached", class: "bound", layer: "inference" },
      steps: [
        { id: "audit-documentation", status: "succeeded", durationMs: 42000 },
        {
          id: "evaluate-document-quality",
          status: "failed",
          durationMs: 90000,
          failure: { code: "output-limit-reached", class: "bound", layer: "inference" },
          inference: {
            effectiveMaxRetries: 2,
            attempts: [
              {
                attempt: 1,
                outcome: "provider-transient",
                retryable: true,
                retryScheduled: true,
                durationMs: 1500,
                modelTelemetry: { providerError: { class: "server" } },
              },
              {
                attempt: 2,
                outcome: "output-limit-reached",
                retryable: false,
                retryScheduled: false,
                durationMs: 2500,
              },
            ],
          },
        },
        { id: "finalize", status: "pending" },
      ],
    };
    const evidence = collectCellEvidence({
      cell: { ...cell, providerId: "nvidia-api-catalog" },
      record,
    });
    expect(evidence.classification).toBe("output_limit");
    expect(evidence.counts).toEqual({ succeeded: 1, failed: 1, unattempted: 1, running: 0 });
    expect(evidence.steps[1].attempts[0]).toMatchObject({
      status: "provider-transient",
      providerErrorClass: "server",
      retryScheduled: true,
      durationMs: 1500,
    });
    expect(evidence.retries).toHaveLength(2);
    expect(evidence.elapsedMs).toBe(421090);
    expect(evidence.usage.totalTokens).toBe(1680);
    expect(evidence.failure).toMatchObject({
      code: "output-limit-reached",
      class: "bound",
      layer: "inference",
    });
  });

  it("uses recorded provider telemetry to distinguish provider errors from generic timeouts", () => {
    const provider = collectCellEvidence({
      cell: {
        ...cell,
        providerId: "nvidia-inference-api",
        baseUrl: "https://example.test/v1?api_key=redacted",
      },
      record: {
        status: "failed",
        failure: { code: "timeout", class: "unknown", layer: "inference" },
        steps: [
          {
            id: "draft",
            status: "failed",
            inference: {
              attempts: [
                {
                  outcome: "provider-transient",
                  retryScheduled: true,
                  durationMs: 800,
                  modelTelemetry: { providerError: { class: "server" } },
                },
              ],
            },
          },
        ],
      },
    });
    const ambiguous = collectCellEvidence({
      cell,
      record: {
        status: "failed",
        failure: { code: "timeout", class: "unknown", layer: "inference" },
        steps: [{ id: "draft", status: "failed" }],
      },
    });
    expect(provider.classification).toBe("provider_error");
    expect(provider.route).toMatchObject({
      provider: "Inference Hub",
      route: "https://example.test/v1",
    });
    expect(JSON.stringify(provider)).not.toContain("api_key");
    expect(ambiguous.classification).toBe("unknown");
  });

  it("keeps a terminal timeout ambiguous after an earlier provider retry", () => {
    const evidence = collectCellEvidence({
      cell: { ...cell, providerId: "nvidia-api-catalog" },
      record: {
        status: "failed",
        failure: { code: "timeout", class: "unknown", layer: "inference" },
        steps: [
          {
            id: "audit-documentation",
            status: "failed",
            failure: { code: "timeout", class: "unknown", layer: "inference" },
            inference: {
              attempts: [
                {
                  outcome: "provider-transient",
                  retryScheduled: true,
                  durationMs: 90000,
                  modelTelemetry: { providerError: { class: "server" } },
                },
                { outcome: "timeout", retryScheduled: false, durationMs: 300000 },
              ],
            },
          },
        ],
      },
    });
    expect(evidence.classification).toBe("unknown");
    expect(evidence.failure).toMatchObject({ code: "timeout", stepId: "audit-documentation" });
    expect(evidence.retries.map((attempt) => attempt.status)).toEqual([
      "provider-transient",
      "timeout",
    ]);
    expect(evidence.nextAction).toContain("terminal timeout remains ambiguous");
  });

  it("does not label a recovered provider retry as the cause of a successful run", () => {
    const evidence = collectCellEvidence({
      cell: { ...cell, status: "succeeded" },
      record: {
        status: "succeeded",
        steps: [
          {
            id: "draft",
            status: "succeeded",
            inference: {
              attempts: [
                {
                  outcome: "provider-transient",
                  retryScheduled: true,
                  durationMs: 100,
                  modelTelemetry: { providerError: { class: "server" } },
                },
                { outcome: "succeeded", retryScheduled: false, durationMs: 200 },
              ],
            },
          },
        ],
      },
    });
    expect(evidence.classification).toBe("completed");
    expect(evidence.retries).toHaveLength(1);
  });

  it("extracts structured coverage and effective profile/composition limits without copying summaries", () => {
    const reportSummary = JSON.stringify({
      coverage: [{ path: "docs/a.md", status: "unverified" }],
      factInventory: { dimensions: [{ dimension_id: "grounding", status: "unverified" }] },
    });
    const evidence = collectCellEvidence({
      cell,
      record: {
        status: "succeeded",
        models: [{ profile: { effectiveMaxOutputTokens: 8192, effectiveContextWindow: 32768 } }],
        compositionExecution: {
          compositionId: "sample-composition",
          deployment: { routeId: "nvidia-api-catalog" },
          limits: { maxToolCalls: 6 },
        },
        steps: [{ id: "verify", status: "succeeded", summary: reportSummary }],
      },
    });
    expect(evidence.classification).toBe("insufficient_evidence");
    expect(evidence.coverage.unverifiedDimensions).toBeGreaterThan(0);
    expect(evidence.effectiveLimits).toMatchObject({
      effectiveMaxOutputTokens: 8192,
      effectiveContextWindow: 32768,
      maxToolCalls: 6,
    });
    expect(evidence.composition.compositionId).toBe("sample-composition");
    expect(evidence.route).toMatchObject({
      provider: "API Catalog",
      route: "https://api.example/catalog",
    });
    expect(JSON.stringify(evidence)).not.toContain("docs/a.md");
  });

  it("preserves the CLI quality projection separately from a scalar or judge score", () => {
    const evidence = collectCellEvidence({
      cell: { ...cell, status: "succeeded" },
      record: { status: "succeeded", steps: [{ id: "review", status: "succeeded" }] },
      runResult: {
        quality: {
          schemaVersion: 1,
          kind: "quality-report-projection",
          decision: "insufficient-evidence",
          confidence: 0.6,
          rubric: {
            status: "available",
            total: 0,
            threshold: 70,
            decision: "fail",
            confidence: 0.4,
          },
          hardGateFailures: [],
          limitations: ["coverage incomplete"],
        },
      },
    });
    expect(evidence.classification).toBe("insufficient_evidence");
    expect(evidence.quality).toMatchObject({
      present: true,
      score: 0,
      decision: "insufficient-evidence",
      confidence: 0.6,
    });
  });

  it("reports insufficient coverage despite all execution steps succeeding", () => {
    const evidence = collectCellEvidence({
      cell: { ...cell, status: "succeeded" },
      record: {
        status: "succeeded",
        quality: { overall_decision: "insufficient-evidence", unverifiedDimensions: 2 },
        steps: [{ id: "draft", status: "succeeded" }],
      },
    });
    expect(evidence.classification).toBe("insufficient_evidence");
  });

  it("keeps pending planned cells distinct from missing artifacts and preserves score semantics", () => {
    const report = renderReport({
      title: "partial",
      results: [],
      judged: [],
      probe: [],
      manifest: { plannedCells: [cell] },
    });
    expect(report).toContain("pending");
    const missing = collectCellEvidence({
      cell: { ...cell, status: "succeeded" },
      record: null,
      recordPath: "/evidence/run.json",
    });
    expect(missing.classification).toBe("unknown");
    expect(missing.evidencePaths.record).toBe("/evidence/run.json");
    expect(taskScore({ ...cell, status: "succeeded", judge: { status: "scored", total: 8 } })).toBe(
      8,
    );
    const withEvidencePath = renderReport({
      title: "evidence links",
      results: [{ ...cell, recordPath: "/tmp/run evidence.json", status: "failed" }],
      judged: [],
      probe: [],
    });
    expect(withEvidencePath).toContain("[record](</tmp/run%20evidence.json>)");
    expect(withEvidencePath).toContain("log —");
    expect(withEvidencePath).toContain("r1");
  });

  it("does not treat a zero score as absent and keeps route labels explicit", () => {
    const evidence = collectCellEvidence({
      cell: { ...cell, providerId: "nvidia-inference-api", baseUrl: "https://api.example/v1" },
      record: {
        status: "succeeded",
        quality: { total: 0 },
        steps: [{ id: "draft", status: "succeeded" }],
      },
    });
    expect(evidence.route.provider).toBe("Inference Hub");
    expect(evidence.quality).toMatchObject({ present: true, score: 0 });
  });
});
