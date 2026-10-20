// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { RunRecord } from "../src/records/contracts.js";
import type {
  WorkflowOutcomeCandidateV1,
  WorkflowOutcomeProjector,
} from "../src/workflow-contracts/contracts.js";
import {
  WorkflowOutcomeError,
  createWorkflowOutcome,
  decodeWorkflowOutcome,
  defaultInconclusiveWorkflowOutcome,
  EXPECTED_WITHHELD_TOOL_LIMITATION,
  interactiveWorkflowOutcomePolicy,
  recordNotReadyToolMisses,
  releaseGateWorkflowOutcomePolicy,
  TOOL_MISSES_RECORDED_LIMITATION,
  workflowOutcomeArtifactEvidence,
  workflowOutcomeExitCode,
  workflowOutcomeSearchEvidence,
  workflowOutcomeState,
  workflowOutcomeStepEvidence,
} from "../src/workflow-contracts/outcome.js";
import { renderWorkflowOutcome } from "../src/operator/run-summary.js";
import { authorizeSecurityScan } from "../src/security/scan-override.js";
import { resolveSecurityScanEffectiveDisposition } from "../src/security/scan-disposition.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import { explainProductDisposition } from "../src/operator/cli-format.js";

const SECURITY_SCAN_POLICY = {
  authorizeSecurityScan,
  resolveSecurityScanEffectiveDisposition,
} as const;

describe("workflow product outcome", () => {
  it("records successful execution with an independent not-ready product result", () => {
    const record = succeededRecord();
    const outcome = createWorkflowOutcome(notReady(record), record);
    record.workflowOutcome = outcome;

    expect(record.status).toBe("succeeded");
    expect(workflowOutcomeState(record)).toEqual({ state: "current", outcome });
    expect(renderWorkflowOutcome(record)).toEqual([
      "Product disposition: not-ready",
      "Product disposition meaning: Execution succeeded, but documented product gaps remain.",
      "Product findings: public-docs-gap",
      "Product limitations: none",
      "Product open decisions: none",
      `Product outcome evidence: ${outcome.evidence.map((evidence) => evidence.id).join(",")}`,
    ]);
    expect(workflowOutcomeExitCode(record, interactiveWorkflowOutcomePolicy())).toBe(0);
    expect(workflowOutcomeExitCode(record, releaseGateWorkflowOutcomePolicy())).toBe(2);
  });

  it("keeps operator-visible disposition glossary byte-identical", () => {
    const record = succeededRecord();
    expect(renderWorkflowOutcome(record)).toEqual([
      "Product disposition: legacy-no-product-disposition",
      "Product disposition meaning: This run predates structured product disposition; inspect the run record.",
    ]);
    expect(explainProductDisposition("legacy-no-product-disposition")).toBe(
      "This run predates structured product disposition; inspect the run record.",
    );
    expect(explainProductDisposition("ready")).toBe(
      "The workflow's product criteria are satisfied.",
    );
    expect(explainProductDisposition("not-ready")).toBe(
      "Execution succeeded, but documented product gaps remain.",
    );
    expect(explainProductDisposition("inconclusive")).toBe(
      "Evidence was insufficient for a definitive product verdict.",
    );
    expect(explainProductDisposition("blocked")).toBe(
      "A dependency or policy gate prevents completing the product outcome.",
    );
    expect(explainProductDisposition("needs-input")).toBe(
      "Governed external input is required before the product outcome can finalize.",
    );
  });

  it("creates an honest default inconclusive result rather than inventing readiness", () => {
    const record = succeededRecord();
    record.workflowOutcome = createWorkflowOutcome(
      defaultInconclusiveWorkflowOutcome(record),
      record,
    );
    expect(record.workflowOutcome.disposition).toBe("inconclusive");
    expect(record.workflowOutcome.limitations).toEqual(["structured-product-evidence-unavailable"]);
    expect(record.workflowOutcome.findings[0]?.kind).toBe("evidence-limitation");
  });

  it("supports ready and dependency-blocked as distinct typed dispositions", () => {
    const record = succeededRecord();
    const evidence = workflowOutcomeStepEvidence(record, "assess-readiness");
    const ready = createWorkflowOutcome(
      {
        disposition: "ready",
        findings: [],
        evidence: [evidence],
        limitations: [],
        openDecisions: [],
        producedArtifacts: [],
      },
      record,
    );
    expect(ready.disposition).toBe("ready");

    const blocked = createWorkflowOutcome(
      {
        disposition: "blocked",
        findings: [
          {
            id: "finding:approval-blocked",
            kind: "blocked-dependency",
            severity: "blocking",
            code: "approval-required",
            evidenceIds: [evidence.id],
          },
        ],
        evidence: [evidence],
        limitations: [],
        openDecisions: [
          {
            id: "decision:security-approval",
            kind: "policy-approval",
            evidenceIds: [evidence.id],
          },
        ],
        producedArtifacts: [],
      },
      record,
    );
    expect(blocked.disposition).toBe("blocked");
  });

  it("keeps historical execution-only records readable as an explicit legacy state", () => {
    const record = succeededRecord();
    expect(workflowOutcomeState(record)).toEqual({
      state: "legacy-no-product-disposition",
    });
    expect(workflowOutcomeExitCode(record, interactiveWorkflowOutcomePolicy())).toBe(0);
    expect(workflowOutcomeExitCode(record, releaseGateWorkflowOutcomePolicy())).toBe(2);
  });

  it("uses supplied strict evidence decoders when projecting the exit code", () => {
    const record = succeededRecord();
    record.workflowOutcome = createWorkflowOutcome(notReady(record), record);
    record.workflowBranchCoverage = {} as NonNullable<RunRecord["workflowBranchCoverage"]>;
    let decoded = 0;

    expect(() =>
      workflowOutcomeExitCode(record, interactiveWorkflowOutcomePolicy(), {
        decodeWorkflowBranchCoverage() {
          decoded += 1;
          throw new Error("test decoder rejection");
        },
      }),
    ).toThrow(WorkflowOutcomeError);
    expect(decoded).toBe(1);
  });

  it("binds needs-input to an exact governed input and admitted evidence", () => {
    const record = succeededRecord();
    const evidence = workflowOutcomeStepEvidence(record, "assess-readiness");
    const outcome = createWorkflowOutcome(
      {
        disposition: "needs-input",
        findings: [
          {
            id: "finding:release-rubric-required",
            kind: "missing-governed-input",
            severity: "blocking",
            code: "release-rubric-required",
            inputId: "input:release-rubric-v1",
            evidenceIds: [evidence.id],
          },
        ],
        evidence: [evidence],
        limitations: [],
        openDecisions: [
          {
            id: "decision:release-rubric",
            kind: "governed-input",
            inputId: "input:release-rubric-v1",
            evidenceIds: [evidence.id],
          },
        ],
        producedArtifacts: [],
      },
      record,
    );
    expect(outcome.openDecisions[0]?.inputId).toBe("input:release-rubric-v1");
  });

  it("rejects unrelated or host-path governed input bindings", () => {
    const record = succeededRecord();
    const evidence = workflowOutcomeStepEvidence(record, "assess-readiness");
    const candidate: WorkflowOutcomeCandidateV1 = {
      disposition: "needs-input",
      findings: [
        {
          id: "finding:owner-required",
          kind: "missing-governed-input",
          severity: "blocking",
          code: "owner-required",
          inputId: "input:owner",
          evidenceIds: [evidence.id],
        },
        {
          id: "finding:rubric-required",
          kind: "missing-governed-input",
          severity: "blocking",
          code: "rubric-required",
          inputId: "input:rubric",
          evidenceIds: [evidence.id],
        },
      ],
      evidence: [evidence],
      limitations: [],
      openDecisions: [
        {
          id: "decision:rubric",
          kind: "governed-input",
          inputId: "input:rubric",
          evidenceIds: [evidence.id],
        },
      ],
      producedArtifacts: [],
    };
    expect(() => createWorkflowOutcome(candidate, record)).toThrow(WorkflowOutcomeError);
    candidate.findings = [candidate.findings[0]!];
    for (const unsafeInputId of [
      "input:/Users/maintainer/private",
      "input:C:/Users/maintainer/private",
      "input:C:\\Users\\maintainer\\private",
      "input:https://example.test/private",
    ]) {
      candidate.openDecisions[0]!.inputId = unsafeInputId;
      candidate.findings[0]!.inputId = unsafeInputId;
      expect(() => createWorkflowOutcome(candidate, record)).toThrow(WorkflowOutcomeError);
    }
  });

  it("requires hard-ceiling search evidence to produce blocked", () => {
    const record = succeededRecord();
    record.steps[0]!.searchEvidence = {
      schemaVersion: 1,
      kind: "docsfab-workflow-search-evidence",
      planId: "release-readiness",
      planVersion: "1.0.0",
      searches: [
        {
          targetId: "public-guide",
          bounded: {
            evidenceSha256: "b".repeat(64),
            target: { repository: { revision: record.repository.revision } },
            confidence: { disposition: "stopped-hard-ceiling" },
          },
          progress: { target: { repository: { revision: record.repository.revision } } },
        },
      ],
      evidenceSha256: "c".repeat(64),
    } as unknown as NonNullable<RunRecord["steps"][number]["searchEvidence"]>;
    const search = workflowOutcomeSearchEvidence(record, "assess-readiness", "public-guide");
    const candidate: WorkflowOutcomeCandidateV1 = {
      disposition: "inconclusive",
      findings: [
        {
          id: "finding:search-limit",
          kind: "evidence-limitation",
          severity: "blocking",
          code: "search-limit",
          evidenceIds: [search.id],
        },
      ],
      evidence: [search],
      limitations: ["search-limit"],
      openDecisions: [],
      producedArtifacts: [],
    };
    expect(() => createWorkflowOutcome(candidate, record)).toThrowError(
      new WorkflowOutcomeError("contradictory-outcome"),
    );
    candidate.disposition = "blocked";
    candidate.findings = [
      {
        id: "finding:search-blocked",
        kind: "blocked-dependency",
        severity: "blocking",
        code: "search-hard-ceiling",
        evidenceIds: [search.id],
      },
    ];
    candidate.limitations = [];
    candidate.openDecisions = [
      {
        id: "decision:search-budget",
        kind: "dependency",
        evidenceIds: [search.id],
      },
    ];
    expect(createWorkflowOutcome(candidate, record).disposition).toBe("blocked");
  });

  it("binds product findings to exact search and roadmap artifact evidence", () => {
    const record = succeededRecord();
    record.steps[0]!.searchEvidence = {
      schemaVersion: 1,
      kind: "docsfab-workflow-search-evidence",
      planId: "release-readiness",
      planVersion: "1.0.0",
      searches: [
        {
          targetId: "public-guide",
          bounded: {
            evidenceSha256: "b".repeat(64),
            target: { repository: { revision: record.repository.revision } },
            confidence: { disposition: "not-found-after-bounded-search" },
          },
          progress: { target: { repository: { revision: record.repository.revision } } },
        },
      ],
      evidenceSha256: "c".repeat(64),
    } as unknown as NonNullable<RunRecord["steps"][number]["searchEvidence"]>;
    const roadmap = {
      kind: "roadmap-ledger" as const,
      schemaVersion: 1 as const,
      digest: "d".repeat(64),
      repositoryRevision: record.repository.revision,
      repositoryContentDigest: "e".repeat(64),
    };
    record.artifacts = [{ role: "output", stepId: "assess-readiness", reference: roadmap }];
    record.steps[0]!.artifacts = structuredClone(record.artifacts);
    const search = workflowOutcomeSearchEvidence(record, "assess-readiness", "public-guide");
    const artifact = workflowOutcomeArtifactEvidence(record, record.artifacts[0]!);
    const outcome = createWorkflowOutcome(
      {
        disposition: "not-ready",
        findings: [
          {
            id: "finding:roadmap-gap",
            kind: "roadmap-gap",
            severity: "blocking",
            code: "public-guide-missing",
            evidenceIds: [search.id, artifact.id],
          },
        ],
        evidence: [artifact, search],
        limitations: [],
        openDecisions: [],
        producedArtifacts: [roadmap],
      },
      record,
    );
    record.workflowOutcome = outcome;

    expect(decodeWorkflowOutcome(outcome, record)).toEqual(outcome);
    const changedRecord = structuredClone(record);
    changedRecord.steps[0]!.searchEvidence!.searches[0]!.bounded.evidenceSha256 = "f".repeat(64);
    expect(() => decodeWorkflowOutcome(outcome, changedRecord)).toThrow(WorkflowOutcomeError);
    const incompleteRecord = structuredClone(record);
    incompleteRecord.steps[0]!.searchEvidence!.searches[0]!.bounded.confidence.disposition =
      "search-incomplete";
    expect(() => decodeWorkflowOutcome(outcome, incompleteRecord)).toThrow(WorkflowOutcomeError);
    const wrongRevision = structuredClone(record);
    wrongRevision.steps[0]!.searchEvidence!.searches[0]!.bounded.target.repository.revision =
      "f".repeat(40);
    expect(() => decodeWorkflowOutcome(outcome, wrongRevision)).toThrow(WorkflowOutcomeError);
    const unboundArtifact = structuredClone(record);
    unboundArtifact.artifacts = [];
    expect(() => decodeWorkflowOutcome(outcome, unboundArtifact)).toThrow(WorkflowOutcomeError);
  });

  it("rejects execution failures masquerading as product not-ready", () => {
    const record = succeededRecord();
    record.status = "failed";
    expect(() => createWorkflowOutcome(notReady(record), record)).toThrowError(
      new WorkflowOutcomeError("execution-product-mismatch"),
    );
  });

  it("seals not-ready when expected withheld tools are recorded as a limitation", () => {
    const record = succeededRecord();
    const tools = {
      totalCalls: 9,
      failedCalls: 1,
      byTool: [{ name: "read", calls: 9, failures: 1 }],
      failureCategories: [
        { category: "denied-path" as const, count: 1 },
        { category: "governance-stop" as const, count: 1 },
      ],
    };
    record.tools = structuredClone(tools);
    record.steps[0]!.tools = structuredClone(tools);
    const outcome = createWorkflowOutcome(notReadyWithExpectedWithheld(record), record);
    expect(outcome.kind).toBe("docsfab-workflow-outcome");
    expect(outcome.disposition).toBe("not-ready");
    expect(outcome.limitations).toEqual([EXPECTED_WITHHELD_TOOL_LIMITATION]);
  });

  it("records a read-only step's refused read on not-ready and keeps a write step's material", () => {
    const record = succeededRecord();
    const tools = {
      totalCalls: 1,
      failedCalls: 1,
      byTool: [{ name: "read", calls: 1, failures: 1 }],
      failureCategories: [{ category: "denied-path" as const, count: 1 }],
    };
    record.tools = structuredClone(tools);
    record.steps[0]!.tools = structuredClone(tools);
    // Hidden, the refused read fails admission; recorded, it is a limitation.
    expect(outcomeRejection(() => createWorkflowOutcome(notReady(record), record))).toEqual({
      code: "execution-product-mismatch",
      location: "$.limitations",
    });
    expect(
      createWorkflowOutcome(recordNotReadyToolMisses(notReady(record), record), record).limitations,
    ).toEqual([TOOL_MISSES_RECORDED_LIMITATION]);

    const write = structuredClone(record);
    write.steps[0]!.mode = "write";
    expect(
      outcomeRejection(() =>
        createWorkflowOutcome(recordNotReadyToolMisses(notReady(write), write), write),
      ),
    ).toEqual({ code: "execution-product-mismatch", location: "$.findings" });
  });

  // An uncorrected malformed tool call is a model miss: not-ready must record it
  // as `tool-misses-recorded`, and a withheld-tool limitation does not stand in.
  it.each([
    { name: "without", candidate: notReady },
    { name: "with", candidate: notReadyWithExpectedWithheld },
  ])(
    "requires malformed-arguments on not-ready to be recorded $name a withheld-tool limitation",
    ({ candidate }) => {
      const record = succeededRecord();
      const tools = {
        totalCalls: 1,
        failedCalls: 1,
        byTool: [{ name: "read", calls: 1, failures: 1 }],
        failureCategories: [{ category: "malformed-arguments" as const, count: 1 }],
      };
      record.tools = structuredClone(tools);
      record.steps[0]!.tools = structuredClone(tools);
      expect(outcomeRejection(() => createWorkflowOutcome(candidate(record), record))).toEqual({
        code: "execution-product-mismatch",
        location: "$.limitations",
      });
      const recorded = createWorkflowOutcome(
        recordNotReadyToolMisses(candidate(record), record),
        record,
      );
      expect(recorded.limitations).toContain(TOOL_MISSES_RECORDED_LIMITATION);
    },
  );

  // A malformed call the model corrected with a later successful call to the
  // same tool says nothing against execution, on not-ready or ready.
  it.each([
    { name: "not-ready", candidate: notReady },
    {
      name: "ready",
      candidate: (record: RunRecord) => ({
        ...notReady(record),
        disposition: "ready" as const,
        findings: [],
      }),
    },
  ])("admits a corrected malformed call on $name", ({ candidate }) => {
    const record = succeededRecord();
    const tools = {
      totalCalls: 2,
      failedCalls: 1,
      byTool: [{ name: "edit", calls: 2, failures: 1 }],
      failureCategories: [{ category: "malformed-arguments-corrected" as const, count: 1 }],
    };
    record.tools = structuredClone(tools);
    record.steps[0]!.tools = structuredClone(tools);
    expect(() => createWorkflowOutcome(candidate(record), record)).not.toThrow();

    // The same call left uncorrected stays material to ready, and not-ready
    // must record it.
    const uncorrected = succeededRecord();
    const material = {
      ...tools,
      failureCategories: [{ category: "malformed-arguments" as const, count: 1 }],
    };
    uncorrected.tools = structuredClone(material);
    uncorrected.steps[0]!.tools = structuredClone(material);
    expect(
      outcomeRejection(() => createWorkflowOutcome(candidate(uncorrected), uncorrected)),
    ).toEqual({
      code: "execution-product-mismatch",
      location: candidate(uncorrected).disposition === "ready" ? "$.disposition" : "$.limitations",
    });
  });

  it("does not let a withheld-tool limitation license tool defects on not-ready", () => {
    const record = succeededRecord();
    const tools = {
      totalCalls: 1,
      failedCalls: 1,
      byTool: [{ name: "read", calls: 1, failures: 1 }],
      failureCategories: [{ category: "tool-defect" as const, count: 1 }],
    };
    record.tools = structuredClone(tools);
    record.steps[0]!.tools = structuredClone(tools);
    // On the read-only step the defect needs the tool-misses label; the
    // withheld-tool limitation does not stand in for it.
    expect(
      outcomeRejection(() => createWorkflowOutcome(notReadyWithExpectedWithheld(record), record)),
    ).toEqual({ code: "execution-product-mismatch", location: "$.limitations" });

    // On a write step the defect stays material beside the limitation.
    const write = structuredClone(record);
    write.steps[0]!.mode = "write";
    expect(
      outcomeRejection(() =>
        createWorkflowOutcome(
          recordNotReadyToolMisses(notReadyWithExpectedWithheld(write), write),
          write,
        ),
      ),
    ).toEqual({ code: "execution-product-mismatch", location: "$.findings" });
  });

  it("refuses a write step's tool defect on not-ready, labeled or not", () => {
    const record = succeededRecord();
    const tools = {
      totalCalls: 1,
      failedCalls: 1,
      byTool: [{ name: "edit", calls: 1, failures: 1 }],
      failureCategories: [{ category: "tool-defect" as const, count: 1 }],
    };
    record.tools = structuredClone(tools);
    record.steps[0]!.tools = structuredClone(tools);
    record.steps[0]!.mode = "write";
    for (const candidate of [
      notReady(record),
      recordNotReadyToolMisses(notReady(record), record),
    ]) {
      expect(outcomeRejection(() => createWorkflowOutcome(candidate, record))).toEqual({
        code: "execution-product-mismatch",
        location: "$.findings",
      });
    }
  });

  it("keeps a read-only step's governance stop material on not-ready", () => {
    const record = succeededRecord();
    // One read that failed inside the host, which the label admits, and one
    // call the tool-call limit stopped before it ran.
    const tools = {
      totalCalls: 1,
      failedCalls: 1,
      byTool: [{ name: "read", calls: 1, failures: 1 }],
      failureCategories: [
        { category: "governance-stop" as const, count: 1 },
        { category: "tool-defect" as const, count: 1 },
      ],
    };
    record.tools = structuredClone(tools);
    record.steps[0]!.tools = structuredClone(tools);
    expect(record.steps[0]!.mode).toBe("read-only");
    expect(
      outcomeRejection(() =>
        createWorkflowOutcome(recordNotReadyToolMisses(notReady(record), record), record),
      ),
    ).toEqual({ code: "execution-product-mismatch", location: "$.findings" });

    // Positive control: without the stop, the labeled defect is admitted.
    const unstopped = structuredClone(record);
    for (const summary of [unstopped.tools, unstopped.steps[0]!.tools!]) {
      summary.failureCategories = [{ category: "tool-defect", count: 1 }];
    }
    expect(
      createWorkflowOutcome(recordNotReadyToolMisses(notReady(unstopped), unstopped), unstopped)
        .limitations,
    ).toEqual([TOOL_MISSES_RECORDED_LIMITATION]);
  });

  it.each([
    [
      "failed step",
      (record: RunRecord) => {
        record.steps[0]!.status = "failed";
      },
    ],
    [
      "blocked scanner",
      (record: RunRecord) => {
        record.securityScanEffectiveDisposition = { status: "blocked" };
      },
    ],
    [
      "provider failure",
      (record: RunRecord) => {
        record.steps[0]!.inference = {
          policy: {} as never,
          attempts: [{ outcome: "provider-terminal" } as never],
        } as never;
      },
    ],
  ] as const)("rejects %s as not-ready", (_name, mutate) => {
    const record = succeededRecord();
    const candidate = notReady(record);
    mutate(record);
    expect(() => createWorkflowOutcome(candidate, record)).toThrowError(
      new WorkflowOutcomeError("execution-product-mismatch"),
    );
  });

  it.each([
    ["missing categories", undefined],
    ["undercounted categories", [{ category: "expected-missing-probe", count: 1 }]],
  ] as const)("rejects failed tool calls with %s", (_name, failureCategories) => {
    const record = succeededRecord();
    const tools = {
      totalCalls: 2,
      failedCalls: 2,
      byTool: [{ name: "read", calls: 2, failures: 2 }],
      ...(failureCategories === undefined
        ? {}
        : {
            failureCategories: failureCategories.map((entry) => ({ ...entry })),
          }),
    };
    record.tools = structuredClone(tools);
    record.steps[0]!.tools = structuredClone(tools);
    expect(() => createWorkflowOutcome(notReady(record), record)).toThrowError(
      new WorkflowOutcomeError("execution-product-mismatch"),
    );
  });

  it("keeps governance stops out of executed tool-failure reconciliation", () => {
    const record = succeededRecord();
    const tools = {
      totalCalls: 3,
      failedCalls: 1,
      byTool: [{ name: "read", calls: 3, failures: 1 }],
      failureCategories: [
        { category: "denied-path" as const, count: 1 },
        { category: "governance-stop" as const, count: 2 },
      ],
    };
    record.tools = structuredClone(tools);
    record.steps[0]!.tools = structuredClone(tools);

    expect(
      createWorkflowOutcome(defaultInconclusiveWorkflowOutcome(record), record).disposition,
    ).toBe("inconclusive");

    const mismatched = structuredClone(record);
    mismatched.tools.failureCategories = [
      { category: "denied-path", count: 2 },
      { category: "governance-stop", count: 1 },
    ];
    mismatched.steps[0]!.tools!.failureCategories = structuredClone(
      mismatched.tools.failureCategories,
    );
    expect(() =>
      createWorkflowOutcome(defaultInconclusiveWorkflowOutcome(mismatched), mismatched),
    ).toThrowError(new WorkflowOutcomeError("execution-product-mismatch"));
  });

  it("allows fully reconciled expected missing probes but rejects attempt-only defects", () => {
    const record = succeededRecord();
    const expected = {
      totalCalls: 1,
      failedCalls: 1,
      byTool: [{ name: "read", calls: 1, failures: 1 }],
      failureCategories: [{ category: "expected-missing-probe" as const, count: 1 }],
    };
    record.tools = structuredClone(expected);
    record.steps[0]!.tools = structuredClone(expected);
    expect(createWorkflowOutcome(notReady(record), record).disposition).toBe("not-ready");

    record.steps[0]!.inference = {
      configuredMaxRetries: 0,
      effectiveMaxRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryableCategories: [],
      replay: "read-only",
      attempts: [
        {
          attempt: 1,
          outcome: "succeeded",
          retryable: false,
          retryScheduled: false,
          durationMs: 1,
          tools: {
            totalCalls: 1,
            failedCalls: 1,
            byTool: [{ name: "read", calls: 1, failures: 1 }],
            failureCategories: [{ category: "tool-defect", count: 1 }],
          },
        },
      ],
    };
    expect(() => createWorkflowOutcome(notReady(record), record)).toThrowError(
      new WorkflowOutcomeError("execution-product-mismatch"),
    );
  });

  it("rejects cross-level run, step, and attempt tool-summary mismatches", () => {
    const record = succeededRecord();
    record.tools = {
      totalCalls: 1,
      failedCalls: 1,
      byTool: [{ name: "read", calls: 1, failures: 1 }],
      failureCategories: [{ category: "expected-missing-probe", count: 1 }],
    };
    record.steps[0]!.tools = {
      totalCalls: 0,
      failedCalls: 0,
      byTool: [],
      failureCategories: [],
    };
    expect(() => createWorkflowOutcome(notReady(record), record)).toThrowError(
      new WorkflowOutcomeError("execution-product-mismatch"),
    );

    record.tools = structuredClone(record.steps[0]!.tools);
    record.steps[0]!.inference = {
      configuredMaxRetries: 0,
      effectiveMaxRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryableCategories: [],
      replay: "read-only",
      attempts: [
        {
          attempt: 1,
          outcome: "succeeded",
          retryable: false,
          retryScheduled: false,
          durationMs: 1,
          tools: {
            totalCalls: 1,
            failedCalls: 1,
            byTool: [{ name: "read", calls: 1, failures: 1 }],
            failureCategories: [{ category: "expected-missing-probe", count: 1 }],
          },
        },
      ],
    };
    expect(() => createWorkflowOutcome(notReady(record), record)).toThrowError(
      new WorkflowOutcomeError("execution-product-mismatch"),
    );
  });

  it("reconstructs raw scanner authority before admitting a product result", () => {
    const record = succeededRecord();
    record.securityScan = {
      ruleSet: "docsfab-v1",
      status: "blocked",
      scannedFiles: 1,
      binaryFiles: 0,
      findings: [{ path: "README.md", ruleId: "credential.generic" }],
    };
    expect(() =>
      createWorkflowOutcome(notReady(record), record, SECURITY_SCAN_POLICY),
    ).toThrowError(new WorkflowOutcomeError("execution-product-mismatch"));

    record.securityScan.status = "failed";
    record.securityScan.findings = [];
    record.securityScanEffectiveDisposition = { status: "passed" };
    expect(() =>
      createWorkflowOutcome(notReady(record), record, SECURITY_SCAN_POLICY),
    ).toThrowError(new WorkflowOutcomeError("execution-product-mismatch"));

    record.securityScan.status = "passed";
    record.securityScanEffectiveDisposition = { status: "passed" };
    expect(createWorkflowOutcome(notReady(record), record, SECURITY_SCAN_POLICY).disposition).toBe(
      "not-ready",
    );
  });

  it("fails closed when non-advisory scanner policy callbacks are omitted", () => {
    const forged = succeededRecord();
    forged.securityScan = {
      ruleSet: "docsfab-v1",
      status: "blocked",
      scannedFiles: 1,
      binaryFiles: 0,
      findings: [{ path: "README.md", ruleId: "credential.generic" }],
    };
    forged.securityScanAuthorization = {
      status: "authorized",
      overrides: [
        {
          ruleId: "credential.generic",
          revision: "b".repeat(40),
          reason: "approved",
          expiresAt: "2099-01-01T00:00:00.000Z",
          decision: "authorized",
          findingCount: 1,
        },
      ],
    };
    forged.securityScanEffectiveDisposition = { status: "authorized" };
    expect(() => createWorkflowOutcome(notReady(forged), forged)).toThrowError(
      new WorkflowOutcomeError("execution-product-mismatch"),
    );

    const passed = succeededRecord();
    passed.securityScan = {
      ruleSet: "docsfab-v1",
      status: "passed",
      scannedFiles: 1,
      binaryFiles: 0,
      findings: [],
    };
    passed.securityScanEffectiveDisposition = { status: "passed" };
    expect(createWorkflowOutcome(notReady(passed), passed, SECURITY_SCAN_POLICY).disposition).toBe(
      "not-ready",
    );

    const advisory = succeededRecord();
    advisory.securityScan = {} as NonNullable<RunRecord["securityScan"]>;
    advisory.securityScanEffectiveDisposition = { status: "advisory" };
    expect(createWorkflowOutcome(notReady(advisory), advisory).disposition).toBe("not-ready");
  });

  it("rejects a terminal provider attempt followed by fabricated success", () => {
    const record = succeededRecord();
    const emptyTools = { totalCalls: 0, failedCalls: 0, byTool: [] };
    record.steps[0]!.tools = structuredClone(emptyTools);
    record.steps[0]!.inference = {
      configuredMaxRetries: 1,
      effectiveMaxRetries: 1,
      baseDelayMs: 1,
      maxDelayMs: 1,
      retryableCategories: ["provider-transient"],
      replay: "read-only",
      attempts: [
        {
          attempt: 1,
          outcome: "provider-terminal",
          retryable: true,
          retryScheduled: true,
          durationMs: 1,
          backoffMs: 1,
          tools: structuredClone(emptyTools),
        },
        {
          attempt: 2,
          outcome: "succeeded",
          retryable: false,
          retryScheduled: false,
          durationMs: 1,
          tools: structuredClone(emptyTools),
        },
      ],
    };
    expect(() => createWorkflowOutcome(notReady(record), record)).toThrowError(
      new WorkflowOutcomeError("execution-product-mismatch"),
    );
  });

  /**
   * The product validator accepts an attempt carrying the condition/decision
   * pair and checks it against this record's own effective policy rather than
   * taking it on trust. A record carrying neither stays valid.
   */
  it("accepts the #480 condition/decision pair and rejects a copied or guessed one", () => {
    const emptyTools = { totalCalls: 0, failedCalls: 0, byTool: [] };
    const build = () => {
      const record = succeededRecord();
      record.steps[0]!.tools = structuredClone(emptyTools);
      record.steps[0]!.inference = {
        configuredMaxRetries: 1,
        effectiveMaxRetries: 1,
        baseDelayMs: 1,
        maxDelayMs: 1,
        retryableCategories: ["timeout"],
        replay: "read-only",
        attempts: [
          {
            attempt: 1,
            outcome: "timeout",
            retryable: true,
            retryScheduled: true,
            conditionRetryability: "eligible",
            retryDecision: "retried",
            durationMs: 1,
            backoffMs: 1,
            tools: structuredClone(emptyTools),
          },
          {
            attempt: 2,
            outcome: "succeeded",
            retryable: false,
            retryScheduled: false,
            conditionRetryability: "not-applicable",
            retryDecision: "not-applicable",
            durationMs: 1,
            tools: structuredClone(emptyTools),
          },
        ],
      };
      return record;
    };

    expect(createWorkflowOutcome(notReady(build()), build()).disposition).toBe("not-ready");

    // A record with neither field stays valid.
    const historical = build();
    for (const attempt of historical.steps[0]!.inference!.attempts) {
      delete attempt.conditionRetryability;
      delete attempt.retryDecision;
    }
    expect(createWorkflowOutcome(notReady(historical), historical).disposition).toBe("not-ready");

    const rejected = (
      mutate: (record: ReturnType<typeof build>) => void,
    ): ReturnType<typeof expect> => {
      const candidate = build();
      mutate(candidate);
      return expect(() => createWorkflowOutcome(notReady(candidate), candidate));
    };
    // An eligible condition claimed terminal.
    rejected((record) => {
      record.steps[0]!.inference!.attempts[0]!.conditionRetryability = "not-eligible";
    }).toThrowError(new WorkflowOutcomeError("execution-product-mismatch"));
    // The decision copied into the retryability field.
    rejected((record) => {
      record.steps[0]!.inference!.attempts[0]!.conditionRetryability = "retried" as never;
    }).toThrowError(new WorkflowOutcomeError("execution-product-mismatch"));
    // A decision that contradicts the retry this record shows was scheduled.
    rejected((record) => {
      record.steps[0]!.inference!.attempts[0]!.retryDecision = "declined";
    }).toThrowError(new WorkflowOutcomeError("execution-product-mismatch"));
    // Half a pair leaves a reader guessing the other half. Both directions:
    // the derivation cross-check below only runs when the retryability half is
    // present, so a decision standing alone is caught by the pairing rule and
    // by nothing else.
    rejected((record) => {
      delete record.steps[0]!.inference!.attempts[0]!.retryDecision;
    }).toThrowError(new WorkflowOutcomeError("execution-product-mismatch"));
    rejected((record) => {
      delete record.steps[0]!.inference!.attempts[0]!.conditionRetryability;
    }).toThrowError(new WorkflowOutcomeError("execution-product-mismatch"));
  });

  /**
   * A record that applied condition budgets names the retry rule of every
   * attempt (#1733); the product validator re-derives each rule with the
   * shared decider rather than taking it on trust.
   */
  it("accepts the recorded retry rule and rejects a swapped, missing, or misfiled one", () => {
    const emptyTools = { totalCalls: 0, failedCalls: 0, byTool: [] };
    const build = () => {
      const record = succeededRecord();
      record.steps[0]!.tools = structuredClone(emptyTools);
      record.steps[0]!.inference = {
        configuredMaxRetries: 1,
        effectiveMaxRetries: 1,
        baseDelayMs: 1,
        maxDelayMs: 1,
        retryableCategories: ["timeout"],
        replay: "read-only",
        conditionRetry: { maxTimeoutRetries: 1, maxCutAnswerRetries: 0 },
        attempts: [
          {
            attempt: 1,
            outcome: "timeout",
            retryable: true,
            retryScheduled: true,
            conditionRetryability: "eligible",
            retryDecision: "retried",
            retryRule: "retried-attempt-deadline",
            condition: "attempt-deadline",
            durationMs: 1,
            backoffMs: 1,
            tools: structuredClone(emptyTools),
          },
          {
            attempt: 2,
            outcome: "succeeded",
            retryable: false,
            retryScheduled: false,
            conditionRetryability: "not-applicable",
            retryDecision: "not-applicable",
            retryRule: "not-applicable",
            durationMs: 1,
            tools: structuredClone(emptyTools),
          },
        ],
      };
      return record;
    };

    expect(createWorkflowOutcome(notReady(build()), build()).disposition).toBe("not-ready");

    const rejected = (
      mutate: (record: ReturnType<typeof build>) => void,
    ): ReturnType<typeof expect> => {
      const candidate = build();
      mutate(candidate);
      return expect(() => createWorkflowOutcome(notReady(candidate), candidate));
    };
    // A rule the decider would not have chosen for this attempt.
    rejected((record) => {
      record.steps[0]!.inference!.attempts[0]!.retryRule = "retried-provider-timeout";
    }).toThrowError(new WorkflowOutcomeError("execution-product-mismatch"));
    // A rule missing on a record that applied condition budgets.
    rejected((record) => {
      delete record.steps[0]!.inference!.attempts[0]!.retryRule;
    }).toThrowError(new WorkflowOutcomeError("execution-product-mismatch"));
    // A timeout that does not say which timer fired.
    rejected((record) => {
      delete record.steps[0]!.inference!.attempts[0]!.condition;
    }).toThrowError(new WorkflowOutcomeError("execution-product-mismatch"));
    // Condition budgets above the count they are a subset of.
    rejected((record) => {
      record.steps[0]!.inference!.conditionRetry = { maxTimeoutRetries: 2, maxCutAnswerRetries: 0 };
    }).toThrowError(new WorkflowOutcomeError("execution-product-mismatch"));
    // An answer size on an attempt that admitted no answer.
    rejected((record) => {
      record.steps[0]!.inference!.attempts[0]!.answerBytes = 42;
    }).toThrowError(new WorkflowOutcomeError("execution-product-mismatch"));
    // A spent timeout budget cannot schedule a retry.
    rejected((record) => {
      record.steps[0]!.inference!.conditionRetry = { maxTimeoutRetries: 0, maxCutAnswerRetries: 0 };
    }).toThrowError(new WorkflowOutcomeError("execution-product-mismatch"));
  });

  it("binds attempts to the enclosing retry policy and exact backoff", () => {
    const record = succeededRecord();
    const emptyTools = { totalCalls: 0, failedCalls: 0, byTool: [] };
    record.steps[0]!.tools = structuredClone(emptyTools);
    record.steps[0]!.inference = {
      configuredMaxRetries: 0,
      effectiveMaxRetries: 0,
      baseDelayMs: 1,
      maxDelayMs: 1,
      retryableCategories: ["timeout"],
      replay: "read-only",
      attempts: [
        {
          attempt: 1,
          outcome: "timeout",
          retryable: true,
          retryScheduled: true,
          durationMs: 1,
          backoffMs: 1,
          tools: structuredClone(emptyTools),
        },
        {
          attempt: 2,
          outcome: "succeeded",
          retryable: false,
          retryScheduled: false,
          durationMs: 1,
          tools: structuredClone(emptyTools),
        },
      ],
    };
    expect(() => createWorkflowOutcome(notReady(record), record)).toThrowError(
      new WorkflowOutcomeError("execution-product-mismatch"),
    );

    record.steps[0]!.inference.configuredMaxRetries = 1;
    record.steps[0]!.inference.effectiveMaxRetries = 1;
    record.steps[0]!.inference.retryableCategories = [];
    expect(() => createWorkflowOutcome(notReady(record), record)).toThrowError(
      new WorkflowOutcomeError("execution-product-mismatch"),
    );

    record.steps[0]!.inference.retryableCategories = ["timeout"];
    record.steps[0]!.inference.attempts[0]!.backoffMs = 999;
    expect(() => createWorkflowOutcome(notReady(record), record)).toThrowError(
      new WorkflowOutcomeError("execution-product-mismatch"),
    );

    record.steps[0]!.inference.attempts[0]!.backoffMs = 1;
    expect(createWorkflowOutcome(notReady(record), record).disposition).toBe("not-ready");

    // A recorded Retry-After lengthens the exact wait, up to maxDelayMs.
    record.steps[0]!.inference.maxDelayMs = 5;
    record.steps[0]!.inference.attempts[0]!.modelTelemetry = {
      schemaVersion: 1,
      finishReason: "error",
      providerLatencyMs: 1,
      providerError: { class: "timeout", httpStatus: 504, retryAfterMs: 3 },
    };
    record.steps[0]!.inference.attempts[0]!.backoffMs = 3;
    expect(createWorkflowOutcome(notReady(record), record).disposition).toBe("not-ready");
    record.steps[0]!.inference.attempts[0]!.backoffMs = 2;
    expect(() => createWorkflowOutcome(notReady(record), record)).toThrowError(
      new WorkflowOutcomeError("execution-product-mismatch"),
    );

    // A Retry-After recorded without the status it came with justifies
    // no longer wait; only the plain exponential one reads.
    record.steps[0]!.inference.attempts[0]!.modelTelemetry = {
      schemaVersion: 1,
      finishReason: "error",
      providerLatencyMs: 1,
      providerError: { class: "timeout", retryAfterMs: 3 },
    };
    record.steps[0]!.inference.attempts[0]!.backoffMs = 3;
    expect(() => createWorkflowOutcome(notReady(record), record)).toThrowError(
      new WorkflowOutcomeError("execution-product-mismatch"),
    );
    record.steps[0]!.inference.attempts[0]!.backoffMs = 1;
    expect(createWorkflowOutcome(notReady(record), record).disposition).toBe("not-ready");
  });

  it.each([
    [
      "ready with a finding",
      (candidate: WorkflowOutcomeCandidateV1) => {
        candidate.disposition = "ready";
      },
    ],
    [
      "not-ready without a blocking product gap",
      (candidate: WorkflowOutcomeCandidateV1) => {
        candidate.findings[0]!.severity = "warning";
      },
    ],
    [
      "needs-input without a governed input",
      (candidate: WorkflowOutcomeCandidateV1) => {
        candidate.disposition = "needs-input";
      },
    ],
    [
      "inconclusive without admitted limitations",
      (candidate: WorkflowOutcomeCandidateV1) => {
        candidate.disposition = "inconclusive";
      },
    ],
    [
      "blocked without a dependency decision",
      (candidate: WorkflowOutcomeCandidateV1) => {
        candidate.disposition = "blocked";
      },
    ],
    [
      "orphaned finding evidence",
      (candidate: WorkflowOutcomeCandidateV1) => {
        candidate.findings[0]!.evidenceIds = ["step:missing"];
      },
    ],
    [
      "roadmap gap without an admitted roadmap ledger",
      (candidate: WorkflowOutcomeCandidateV1) => {
        candidate.findings[0]!.kind = "roadmap-gap";
      },
    ],
    [
      "limitation without a typed limitation finding",
      (candidate: WorkflowOutcomeCandidateV1) => {
        candidate.limitations = ["unbound-limitation"];
      },
    ],
    [
      "substituted step digest",
      (candidate: WorkflowOutcomeCandidateV1) => {
        const evidence = candidate.evidence[0];
        if (!evidence || evidence.kind === "artifact") {
          throw new Error("Expected mutable step or search evidence.");
        }
        evidence.sha256 = "0".repeat(64);
      },
    ],
  ] as const)("rejects %s", (_name, mutate) => {
    const record = succeededRecord();
    const candidate = notReady(record);
    mutate(candidate);
    expect(() => createWorkflowOutcome(candidate, record)).toThrow(WorkflowOutcomeError);
  });

  it("rejects unknown, hidden, sparse, accessor, and proxy persisted shapes", () => {
    const record = succeededRecord();
    const outcome = createWorkflowOutcome(notReady(record), record);
    const candidates: unknown[] = [];

    candidates.push({ ...outcome, extra: true });
    const hidden = { ...structuredClone(outcome) };
    Object.defineProperty(hidden, "hidden", { enumerable: false, value: true });
    candidates.push(hidden);
    const sparse = structuredClone(outcome);
    sparse.findings.length = 2;
    candidates.push(sparse);
    const accessor = structuredClone(outcome) as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, "disposition", { enumerable: true, get: () => "not-ready" });
    candidates.push(accessor);
    candidates.push(new Proxy(structuredClone(outcome), {}));
    const symbol = structuredClone(outcome) as unknown as Record<PropertyKey, unknown>;
    symbol[Symbol("hidden")] = true;
    candidates.push(symbol);
    candidates.push({ ...outcome, schemaVersion: -0 });
    for (const candidate of candidates) {
      expect(() => decodeWorkflowOutcome(candidate, record)).toThrow(WorkflowOutcomeError);
    }
  });

  it("rejects a self-rehashed contradictory report", () => {
    const record = succeededRecord();
    const candidate = createWorkflowOutcome(notReady(record), record);
    const tampered = structuredClone(candidate);
    tampered.disposition = "ready";
    const { outcomeSha256: _old, ...body } = tampered;
    tampered.outcomeSha256 = canonicalDigest(body);
    expect(() => decodeWorkflowOutcome(tampered, record)).toThrowError(
      new WorkflowOutcomeError("contradictory-outcome"),
    );
  });

  it("exposes a harness-neutral projector seam", async () => {
    const record = succeededRecord();
    const projector: WorkflowOutcomeProjector = {
      project: async (frozen) => {
        return notReady(frozen as RunRecord);
      },
    };
    record.workflowOutcome = createWorkflowOutcome(await projector.project(record), record);
    expect(record.workflowOutcome.disposition).toBe("not-ready");
  });
});

function succeededRecord(): RunRecord {
  return {
    schemaVersion: 2,
    id: "run:outcome-fixture",
    workflow: "readiness",
    repository: {
      sourcePath: "/private/source",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-08-05T00:00:00.000Z",
    startedAt: "2026-08-05T00:00:00.000Z",
    completedAt: "2026-08-05T00:00:01.000Z",
    durationMs: 1_000,
    models: [],
    skills: [],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      turns: 0,
    },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [
      {
        id: "assess-readiness",
        title: "Assess repository readiness",
        kind: "inference",
        skill: "doc-context-analyzer",
        mode: "read-only",
        status: "succeeded",
        startedAt: "2026-08-05T00:00:00.000Z",
        completedAt: "2026-08-05T00:00:01.000Z",
        durationMs: 1_000,
        summary: "Typed product evidence fixture.",
      },
    ],
  };
}

function notReady(record: RunRecord): WorkflowOutcomeCandidateV1 {
  const evidence = workflowOutcomeStepEvidence(record, "assess-readiness");
  return {
    disposition: "not-ready",
    findings: [
      {
        id: "finding:public-docs-gap",
        kind: "product-gap",
        severity: "blocking",
        code: "public-docs-gap",
        evidenceIds: [evidence.id],
      },
    ],
    evidence: [evidence],
    limitations: [],
    openDecisions: [],
    producedArtifacts: [],
  };
}

/** The code and rule location of the outcome refusal `run` throws. */
function outcomeRejection(run: () => unknown): { code: string; location: string } {
  try {
    run();
  } catch (error) {
    if (error instanceof WorkflowOutcomeError) {
      return { code: error.code, location: error.location };
    }
    throw error;
  }
  throw new Error("Expected a workflow outcome refusal.");
}

function notReadyWithExpectedWithheld(record: RunRecord): WorkflowOutcomeCandidateV1 {
  const candidate = notReady(record);
  const evidenceId = candidate.evidence[0]!.id;
  candidate.limitations = [EXPECTED_WITHHELD_TOOL_LIMITATION];
  candidate.findings.push({
    id: "finding:expected-withheld-tool",
    kind: "evidence-limitation",
    severity: "warning",
    code: EXPECTED_WITHHELD_TOOL_LIMITATION,
    evidenceIds: [evidenceId],
  });
  return candidate;
}
