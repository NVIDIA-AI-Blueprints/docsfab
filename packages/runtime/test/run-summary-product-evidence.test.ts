// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { RunRecord } from "../src/records/contracts.js";
import {
  formatProductOutcomeLines,
  renderWorkflowOutcome,
} from "../src/operator/run-summary/product.js";
import {
  createWorkflowOutcome,
  workflowOutcomeStepEvidence,
} from "../src/workflow-contracts/outcome.js";

function productEvidenceRecord(input: {
  findings: Array<{ id: string; kind: "product-gap" | "evidence-limitation"; code: string }>;
  limitations: string[];
  openDecisions: string[];
  workflow?: RunRecord["workflow"];
}): RunRecord {
  const record: RunRecord = {
    schemaVersion: 2,
    id: "product-evidence-run",
    workflow: input.workflow ?? "update-documentation",
    repository: {
      sourcePath: "/repo",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-10-15T12:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [
      {
        id: "write-documentation",
        title: "Write documentation",
        kind: "inference",
        skill: "write-documentation",
        mode: "write",
        status: "succeeded",
        summary: "Completed the planned documentation update.",
      },
    ],
  };
  const evidence = workflowOutcomeStepEvidence(record, "write-documentation");
  record.workflowOutcome = createWorkflowOutcome(
    {
      disposition: "not-ready",
      findings: [
        {
          id: "finding:product-gap",
          kind: "product-gap",
          severity: "blocking",
          code: "product-gap.example",
          evidenceIds: [evidence.id],
        },
        ...input.findings.map((finding) => ({
          ...finding,
          severity: "warning" as const,
          evidenceIds: [evidence.id],
        })),
      ],
      evidence: [evidence],
      limitations: input.limitations,
      openDecisions: input.openDecisions.map((id) => ({
        id,
        kind: "dependency",
        evidenceIds: [evidence.id],
      })),
      producedArtifacts: [],
    },
    record,
  );
  return record;
}

describe("run summary product evidence presentation", () => {
  it("collapses wholly shared categories from typed outcome evidence before formatting", () => {
    const record = productEvidenceRecord({
      findings: [{ id: "finding:shared", kind: "evidence-limitation", code: "shared-evidence" }],
      limitations: ["shared-evidence"],
      openDecisions: ["shared-evidence"],
    });

    const productLines = formatProductOutcomeLines(record);
    expect(productLines).toContain("Product disposition: not-ready");
    expect(
      productLines.some(
        (line) => line.startsWith("Product findings: ") && line.includes("shared-evidence"),
      ),
    ).toBe(true);
    expect(
      productLines.some((line) =>
        /^Product outcome evidence: step:write-documentation$/u.test(line),
      ),
    ).toBe(true);
    expect(productLines.some((line) => line.startsWith("Product limitations:"))).toBe(false);
    expect(productLines.some((line) => line.startsWith("Product open decisions:"))).toBe(false);

    // The public raw renderer remains a faithful view of the sealed outcome.
    const rawLines = renderWorkflowOutcome(record);
    expect(
      rawLines.some(
        (line) => line.startsWith("Product findings: ") && line.includes("shared-evidence"),
      ),
    ).toBe(true);
    expect(rawLines.some((line) => line.startsWith("Product limitations:"))).toBe(true);
    expect(rawLines.some((line) => line.startsWith("Product open decisions:"))).toBe(true);
  });

  it("keeps partially overlapping decision evidence, and keeps audit wording independent", () => {
    const findings = [
      { id: "finding:shared", kind: "evidence-limitation" as const, code: "shared-evidence" },
      { id: "finding:other", kind: "evidence-limitation" as const, code: "other-evidence" },
    ];
    const normal = productEvidenceRecord({
      findings,
      limitations: ["shared-evidence", "other-evidence"],
      openDecisions: ["shared-evidence", "other-decision"],
    });
    const normalLines = formatProductOutcomeLines(normal);
    // Contract validation requires each limitation to have a corresponding
    // evidence-limitation finding, so this category is wholly shared and can
    // be elided from the product summary.
    expect(normalLines.some((line) => line.startsWith("Product limitations:"))).toBe(false);
    expect(
      normalLines.some(
        (line) =>
          line.startsWith("Product open decisions:") &&
          line.includes("other-decision") &&
          line.includes("shared-evidence"),
      ),
    ).toBe(true);

    const audit = productEvidenceRecord({
      workflow: "review-documentation",
      findings,
      limitations: ["shared-evidence", "other-evidence"],
      openDecisions: ["shared-evidence", "other-decision"],
    });
    const auditLines = formatProductOutcomeLines(audit);
    expect(auditLines.some((line) => line.startsWith("Finding: shared-evidence"))).toBe(true);
    expect(
      auditLines.some(
        (line) =>
          line.startsWith("Product limitations:") &&
          line.includes("other-evidence") &&
          line.includes("shared-evidence"),
      ),
    ).toBe(true);
    expect(
      auditLines.some(
        (line) =>
          line.startsWith("Product open decisions:") &&
          line.includes("other-decision") &&
          line.includes("shared-evidence"),
      ),
    ).toBe(true);
    expect(auditLines.some((line) => line.startsWith("Product findings:"))).toBe(false);
  });
});
