// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { RunRecord, SkillEvidence, ToolActivitySummary } from "../src/records/contracts.js";
import {
  AUDIT_TOOL_EVIDENCE_LIMITATION,
  AuditWorkflowOutcomeError,
  AuditWorkflowOutcomeProjector,
} from "../src/maturity/audit-outcome-projector.js";
import {
  createWorkflowOutcome,
  defaultInconclusiveWorkflowOutcome,
  EXPECTED_WITHHELD_TOOL_LIMITATION,
  workflowOutcomeState,
} from "../src/workflow-contracts/outcome.js";
import { applyWorkflowOutcome } from "../src/workflow-execution/runner-evidence.js";
import { workflowOutcomePersistenceError } from "../src/workflow-execution/runner-schedule.js";

describe("AuditWorkflowOutcomeProjector", () => {
  const projector = new AuditWorkflowOutcomeProjector();

  it("projects not-ready from a succeeded audit step with admitted search evidence", async () => {
    const record = succeededAuditRecord("not-found-after-bounded-search");
    const candidate = await projector.project(record);
    const outcome = createWorkflowOutcome(candidate, record);

    expect(outcome.disposition).toBe("not-ready");
    expect(outcome.findings).toEqual([
      expect.objectContaining({
        kind: "product-gap",
        severity: "blocking",
        code: "audit-documentation-gap",
        evidenceIds: ["search:audit-documentation:documentation-audit-rubric"],
      }),
    ]);
    expect(outcome.evidence).toEqual([
      expect.objectContaining({
        kind: "search",
        stepId: "audit-documentation",
        targetId: "documentation-audit-rubric",
      }),
    ]);
    expect(outcome.limitations).toEqual([]);
  });

  it("never infers ready from a successful model call or found search alone", async () => {
    const record = succeededAuditRecord("found");
    record.steps[0]!.summary = "Audit complete; documentation is ready.";
    const candidate = await projector.project(record);
    const outcome = createWorkflowOutcome(candidate, record);

    expect(outcome.disposition).toBe("not-ready");
    expect(outcome.findings[0]?.kind).toBe("product-gap");
    expect(outcome.disposition).not.toBe("ready");
  });

  it("treats the blocked-rubric shape from ac0e85b5 as an evidence limitation", async () => {
    const record = rubricAuditRecord(false);
    const outcome = createWorkflowOutcome(await projector.project(record), record);

    expect(outcome.disposition).toBe("inconclusive");
    expect(outcome.findings).toEqual([
      expect.objectContaining({ kind: "evidence-limitation", severity: "warning" }),
    ]);
    expect(outcome.findings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "product-gap" })]),
    );
    expect(outcome.evidence).toEqual([
      expect.objectContaining({ kind: "step", stepId: "audit-documentation" }),
    ]);
  });

  it("keeps a probe-sufficient rubric match as a confirmed product gap", async () => {
    const record = rubricAuditRecord(true);
    const outcome = createWorkflowOutcome(await projector.project(record), record);

    expect(outcome.disposition).toBe("not-ready");
    expect(outcome.findings).toEqual([
      expect.objectContaining({ kind: "product-gap", code: "audit-documentation-gap" }),
    ]);
  });

  it("seals not-ready with a withheld-tool limitation when read-only policy withholds python/git", async () => {
    const record = withheldPythonGitAuditRecord();
    const candidate = await projector.project(record);
    const outcome = createWorkflowOutcome(candidate, record);

    expect(outcome.kind).toBe("docsfab-workflow-outcome");
    expect(outcome.disposition).toBe("not-ready");
    expect(outcome.limitations).toEqual([EXPECTED_WITHHELD_TOOL_LIMITATION]);
    expect(outcome.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "product-gap", code: "audit-documentation-gap" }),
        expect.objectContaining({
          kind: "evidence-limitation",
          code: EXPECTED_WITHHELD_TOOL_LIMITATION,
          severity: "warning",
        }),
      ]),
    );
  });

  it("persists workflowOutcome for succeeded audit with withheld python/git", async () => {
    const record = withheldPythonGitAuditRecord();
    await applyWorkflowOutcome({ outcomeProjector: projector, record });

    expect(record.status).toBe("succeeded");
    expect(record.error).toBeUndefined();
    expect(record.workflowOutcome).toBeDefined();
    expect(record.workflowOutcome?.kind).toBe("docsfab-workflow-outcome");
    expect(workflowOutcomeState(record)).toEqual({
      state: "current",
      outcome: record.workflowOutcome,
    });
    expect(record.workflowOutcome?.disposition).toBe("not-ready");
    expect(record.workflowOutcome?.limitations).toEqual([EXPECTED_WITHHELD_TOOL_LIMITATION]);
  });

  it("does not license a read failure merely because the same step withholds Bash", async () => {
    const record = withheldPythonGitAuditRecord();
    attachToolSummary(record, unexpectedDeniedPathTools());
    const outcome = createWorkflowOutcome(await projector.project(record), record);

    expect(outcome.disposition).toBe("inconclusive");
    expect(outcome.limitations).toEqual([AUDIT_TOOL_EVIDENCE_LIMITATION]);
    expect(outcome.evidence).toEqual([
      expect.objectContaining({ kind: "step", stepId: "audit-documentation" }),
    ]);
  });

  it("binds a mixed-step limitation only to the step with the unlicensed failed tool", async () => {
    const record = mixedWithheldAndMaterialAuditRecord();
    const outcome = createWorkflowOutcome(await projector.project(record), record);

    expect(outcome.disposition).toBe("inconclusive");
    expect(outcome.findings).toEqual([
      expect.objectContaining({
        code: AUDIT_TOOL_EVIDENCE_LIMITATION,
        evidenceIds: ["step:lint-documentation"],
      }),
    ]);
    expect(outcome.evidence).toEqual([
      expect.objectContaining({ kind: "step", stepId: "lint-documentation" }),
    ]);
  });

  // An uncorrected malformed tool call is material tool evidence, like a denied
  // path; withholding Bash does not license it.
  it.each([
    { name: "on its own", record: () => succeededAuditRecord("found") },
    { name: "beside withheld Bash", record: () => withheldPythonGitAuditRecord() },
  ])(
    "projects a malformed-arguments read $name as bound inconclusive tool evidence",
    async ({ record: build }) => {
      const record = build();
      attachToolSummary(record, {
        totalCalls: 9,
        failedCalls: 1,
        byTool: [{ name: "read", calls: 9, failures: 1 }],
        failureCategories: [{ category: "malformed-arguments", count: 1 }],
      });
      await applyWorkflowOutcome({ outcomeProjector: projector, record });

      expect(record.status).toBe("succeeded");
      expect(record.workflowOutcome?.disposition).toBe("inconclusive");
      expect(record.workflowOutcome?.limitations).toEqual([AUDIT_TOOL_EVIDENCE_LIMITATION]);
    },
  );

  it("does not count a corrected malformed call as tool evidence", async () => {
    const record = succeededAuditRecord("found");
    attachToolSummary(record, {
      totalCalls: 9,
      failedCalls: 1,
      byTool: [{ name: "read", calls: 9, failures: 1 }],
      failureCategories: [{ category: "malformed-arguments-corrected", count: 1 }],
    });
    await applyWorkflowOutcome({ outcomeProjector: projector, record });

    expect(record.status).toBe("succeeded");
    expect(record.workflowOutcome?.limitations).not.toContain(AUDIT_TOOL_EVIDENCE_LIMITATION);
  });

  // A non-material failure on another step leaves the withheld-Bash licence
  // in force: every non-material category takes the same path through both
  // the material check and the licence check.
  it.each(["expected-missing-probe", "malformed-arguments-corrected"] as const)(
    "keeps a licensed withheld-Bash denial licensed beside a %s read on another step",
    async (category) => {
      const record = mixedWithheldAndMaterialAuditRecord();
      const lint = record.steps.find((step) => step.id === "lint-documentation")!;
      lint.tools!.failureCategories = [{ category, count: 1 }];
      record.tools.failureCategories = [
        { category: "denied-path", count: 1 },
        { category, count: 1 },
      ].sort((left, right) => left.category.localeCompare(right.category));
      await applyWorkflowOutcome({ outcomeProjector: projector, record });

      expect(record.status, record.error).toBe("succeeded");
      expect(record.workflowOutcome?.disposition).toBe("not-ready");
      expect(record.workflowOutcome?.limitations).toEqual([EXPECTED_WITHHELD_TOOL_LIMITATION]);
    },
  );

  it("projects an unexpected denied-path as bound inconclusive tool evidence", async () => {
    const record = succeededAuditRecord("found");
    attachToolSummary(record, unexpectedDeniedPathTools());
    await applyWorkflowOutcome({ outcomeProjector: projector, record });

    expect(record.status).toBe("succeeded");
    expect(record.error).toBeUndefined();
    expect(record.workflowOutcome?.disposition).toBe("inconclusive");
    expect(record.workflowOutcome?.limitations).toEqual([AUDIT_TOOL_EVIDENCE_LIMITATION]);
    expect(record.workflowOutcome?.evidence).toEqual([
      expect.objectContaining({ kind: "step", stepId: "audit-documentation" }),
    ]);
  });

  it("binds retained tool-defect accounting to the affected non-terminal step", async () => {
    const record = retainedToolDefectAuditRecord();
    const candidate = await projector.project(record);
    const outcome = createWorkflowOutcome(candidate, record);

    expect(outcome.disposition).toBe("inconclusive");
    expect(outcome.limitations).toEqual([AUDIT_TOOL_EVIDENCE_LIMITATION]);
    expect(outcome.findings).toEqual([
      expect.objectContaining({
        kind: "evidence-limitation",
        severity: "warning",
        code: AUDIT_TOOL_EVIDENCE_LIMITATION,
        evidenceIds: ["step:lint-documentation"],
      }),
    ]);
    expect(outcome.evidence).toEqual([
      expect.objectContaining({ kind: "step", stepId: "lint-documentation" }),
    ]);
  });

  it("does not treat expected missing probes as material tool limitations", async () => {
    const record = succeededAuditRecord("found");
    attachToolSummary(record, {
      totalCalls: 1,
      failedCalls: 1,
      byTool: [{ name: "read", calls: 1, failures: 1 }],
      failureCategories: [{ category: "expected-missing-probe", count: 1 }],
    });
    const outcome = createWorkflowOutcome(await projector.project(record), record);

    expect(outcome.disposition).toBe("not-ready");
    expect(outcome.limitations).toEqual([]);
  });

  it.each([
    ["search-incomplete", "inconclusive", "audit-search-incomplete"],
    ["search-blocked", "blocked", "audit-search-blocked"],
    ["stopped-hard-ceiling", "blocked", "audit-search-blocked"],
  ] as const)(
    "preserves %s precedence while retaining tool evidence",
    async (searchDisposition, disposition, searchCode) => {
      const record = succeededAuditRecord(searchDisposition);
      attachToolSummary(record, toolDefectTools());
      const outcome = createWorkflowOutcome(await projector.project(record), record);

      expect(outcome.disposition).toBe(disposition);
      expect(outcome.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: searchCode }),
          expect.objectContaining({ code: AUDIT_TOOL_EVIDENCE_LIMITATION }),
        ]),
      );
      expect(outcome.limitations).toContain(AUDIT_TOOL_EVIDENCE_LIMITATION);
    },
  );

  it("still fails strict sealing when aggregate tool accounting is corrupt", async () => {
    const record = succeededAuditRecord("found");
    record.tools = toolDefectTools();
    await applyWorkflowOutcome({ outcomeProjector: projector, record });

    expect(record.status).toBe("failed");
    expect(record.workflowOutcome).toBeUndefined();
    expect(workflowOutcomeState(record)).toEqual({ state: "legacy-no-product-disposition" });
    expect(record.error).toBe(workflowOutcomePersistenceError);
  });

  it("stays honestly inconclusive when evidence is only the default limitation", async () => {
    const record = succeededAuditRecord();
    const candidate = await projector.project(record);
    const expected = defaultInconclusiveWorkflowOutcome(record);

    expect(candidate).toEqual(expected);
    expect(createWorkflowOutcome(candidate, record).disposition).toBe("inconclusive");
    expect(candidate.limitations).toEqual(["structured-product-evidence-unavailable"]);
    expect(candidate.findings[0]?.kind).toBe("evidence-limitation");
  });

  it("projects inconclusive from admitted incomplete search evidence", async () => {
    const record = succeededAuditRecord("search-incomplete");
    const candidate = await projector.project(record);
    const outcome = createWorkflowOutcome(candidate, record);

    expect(outcome.disposition).toBe("inconclusive");
    expect(outcome.findings[0]).toEqual(
      expect.objectContaining({
        kind: "evidence-limitation",
        code: "audit-search-incomplete",
      }),
    );
    expect(outcome.limitations).toEqual(["audit-search-incomplete"]);
  });

  it("fail-closes when the projector is applied to an unknown workflow", async () => {
    const record = succeededAuditRecord("found");
    record.workflow = "readiness";
    record.steps[0]!.id = "assess-readiness";
    await expect(projector.project(record)).rejects.toEqual(
      new AuditWorkflowOutcomeError("invalid-workflow"),
    );
  });

  it("wires the projector for audit in the shared application dependencies", () => {
    const source = readFileSync(resolve("src/application/dependencies.ts"), "utf8");
    expect(source).toContain('request.workflow === "review-documentation"');
    expect(source).toContain("new AuditWorkflowOutcomeProjector()");
  });
});

function succeededAuditRecord(
  searchDisposition?:
    | "found"
    | "not-found-after-bounded-search"
    | "search-incomplete"
    | "search-blocked"
    | "stopped-hard-ceiling",
): RunRecord {
  const record: RunRecord = {
    schemaVersion: 2,
    id: "run:audit-outcome-fixture",
    workflow: "review-documentation",
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
        id: "audit-documentation",
        title: "Audit documentation",
        kind: "inference",
        skill: "audit-documentation",
        mode: "read-only",
        status: "succeeded",
        startedAt: "2026-08-05T00:00:00.000Z",
        completedAt: "2026-08-05T00:00:01.000Z",
        durationMs: 1_000,
        summary: "Typed product evidence fixture.",
      },
    ],
  };
  if (searchDisposition) {
    record.steps[0]!.searchEvidence = {
      schemaVersion: 1,
      kind: "docsfab-workflow-search-evidence",
      planId: "documentation-audit-discovery",
      planVersion: "1.0.0",
      searches: [
        {
          targetId: "documentation-audit-rubric",
          bounded: {
            evidenceSha256: "b".repeat(64),
            target: { repository: { revision: record.repository.revision } },
            confidence: { disposition: searchDisposition },
          },
          progress: { target: { repository: { revision: record.repository.revision } } },
        },
      ],
      evidenceSha256: "c".repeat(64),
    } as unknown as NonNullable<RunRecord["steps"][number]["searchEvidence"]>;
  }
  return record;
}

function rubricAuditRecord(sufficient: boolean): RunRecord {
  const record = succeededAuditRecord("found");
  const search = record.steps[0]!.searchEvidence!.searches[0]!;
  const outcomes = sufficient
    ? ["match", "no-match", "no-match", "no-match", "no-match", "no-match"]
    : ["match", "no-match", "blocked", "blocked", "blocked", "blocked"];
  search.bounded = {
    ...search.bounded,
    target: { targetType: "rubric-coverage", repository: { revision: record.repository.revision } },
    probes: outcomes.map((outcome, index) => ({ id: `audit-probe-${index}`, outcome })),
    coverage: { sufficient },
  } as unknown as typeof search.bounded;
  return record;
}

function withheldPythonGitAuditRecord(): RunRecord {
  const record = succeededAuditRecord("found");
  const skill: SkillEvidence = {
    id: "audit-documentation",
    contentSha256: "d".repeat(64),
    toolPolicy: {
      declared: ["Read", "Bash(python:*)", "Bash(git:*)"],
      granted: ["read", "grep", "find", "ls"],
      withheld: ["Bash(python:*)", "Bash(git:*)"],
    },
  };
  record.skills = [skill];
  record.steps[0]!.skillEvidence = skill;
  attachToolSummary(record, {
    totalCalls: 1,
    failedCalls: 1,
    byTool: [{ name: "bash", calls: 1, failures: 1 }],
    failureCategories: [
      { category: "denied-path", count: 1 },
      { category: "governance-stop", count: 1 },
    ],
  });
  return record;
}

function mixedWithheldAndMaterialAuditRecord(): RunRecord {
  const record = succeededAuditRecord("found");
  const withheldSkill: SkillEvidence = {
    id: "probe-documentation",
    contentSha256: "e".repeat(64),
    toolPolicy: {
      declared: ["Bash(python:*)"],
      granted: ["read"],
      withheld: ["Bash(python:*)"],
    },
  };
  record.skills = [withheldSkill];
  record.steps.unshift(
    {
      id: "probe-documentation",
      title: "Probe documentation",
      kind: "inference",
      skill: "probe-documentation",
      mode: "read-only",
      status: "succeeded",
      summary: "The withheld Bash probe was retained.",
      skillEvidence: withheldSkill,
      tools: {
        totalCalls: 1,
        failedCalls: 1,
        byTool: [{ name: "bash", calls: 1, failures: 1 }],
        failureCategories: [{ category: "denied-path", count: 1 }],
      },
    },
    {
      id: "lint-documentation",
      title: "Lint documentation",
      kind: "inference",
      skill: "lint-documentation",
      mode: "read-only",
      status: "succeeded",
      summary: "The unrelated read failure was retained.",
      tools: {
        totalCalls: 1,
        failedCalls: 1,
        byTool: [{ name: "read", calls: 1, failures: 1 }],
        failureCategories: [{ category: "denied-path", count: 1 }],
      },
    },
  );
  record.steps[2]!.tools = { totalCalls: 0, failedCalls: 0, byTool: [] };
  record.tools = {
    totalCalls: 2,
    failedCalls: 2,
    byTool: [
      { name: "bash", calls: 1, failures: 1 },
      { name: "read", calls: 1, failures: 1 },
    ],
    failureCategories: [{ category: "denied-path", count: 2 }],
  };
  return record;
}

function unexpectedDeniedPathTools(): ToolActivitySummary {
  return {
    totalCalls: 9,
    failedCalls: 1,
    byTool: [{ name: "read", calls: 9, failures: 1 }],
    failureCategories: [{ category: "denied-path", count: 1 }],
  };
}

function toolDefectTools(): ToolActivitySummary {
  return {
    totalCalls: 1,
    failedCalls: 1,
    byTool: [{ name: "read", calls: 1, failures: 1 }],
    failureCategories: [{ category: "tool-defect", count: 1 }],
  };
}

function retainedToolDefectAuditRecord(): RunRecord {
  const record = succeededAuditRecord("found");
  record.steps.unshift({
    id: "lint-documentation",
    title: "Lint documentation",
    kind: "inference",
    skill: "lint-documentation",
    mode: "read-only",
    status: "succeeded",
    startedAt: "2026-08-05T00:00:00.000Z",
    completedAt: "2026-08-05T00:00:00.500Z",
    durationMs: 500,
    summary: "Lint completed with a retained tool limitation.",
    tools: toolDefectTools(),
  });
  record.steps[1]!.tools = { totalCalls: 0, failedCalls: 0, byTool: [] };
  record.tools = toolDefectTools();
  return record;
}

function attachToolSummary(record: RunRecord, tools: ToolActivitySummary): void {
  record.tools = structuredClone(tools);
  record.steps[0]!.tools = structuredClone(tools);
}
