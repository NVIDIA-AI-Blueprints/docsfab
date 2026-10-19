// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { AgentHarness } from "../src/execution/contracts.js";
import type { ContextPreflightService } from "../src/context/contracts.js";
import type { RepositorySecurityScanner } from "../src/security/contracts.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import type { WorkflowDefinition, WorkflowStepKind } from "../src/workflow-contracts/contracts.js";
import { grantedTools } from "../src/harness/pi-tool-confine.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import * as workflowCatalog from "../src/workflow-registry/catalog.js";
import {
  EvaluateStepPolicyError,
  assertEvaluateCannotSoleFlipAcceptance,
  assertEvaluateStepPolicy,
  buildEvaluateStepEvidence,
  WorkflowRunner,
} from "../src/workflow-execution/runner.js";
import { readyContextPreflight } from "./helpers.js";

class MemoryStore implements RunStore {
  public records: RunRecord[] = [];
  public async save(record: RunRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}

const passedScanner: RepositorySecurityScanner = {
  scan: async () => ({
    ruleSet: "test-v1",
    status: "passed",
    scannedFiles: 1,
    binaryFiles: 0,
    findings: [],
  }),
};

const unnecessaryContext: ContextPreflightService = {
  preflight: async () => ({
    status: "unnecessary",
    reason: "target-not-applicable",
  }),
};

function evaluateWorkflow(): WorkflowDefinition {
  return {
    name: "readiness",
    title: "Evaluate step fixture",
    outcome: "A read-only evaluate step for policy tests.",
    contextPolicy: {
      schemaVersion: 1,
      steps: [
        {
          stepId: "judge-unit",
          required: false,
          level: "local",
          query: "locate",
          allowReadOnlyDegraded: true,
        },
      ],
    },
    steps: [
      {
        id: "judge-unit",
        title: "Judge unit",
        kind: "evaluate",
        skill: "documentation-audit",
        mode: "read-only",
        prompt: "Judge the candidate without writing files or flipping Acceptance.",
      },
    ],
  };
}

describe("WorkflowStepKind evaluate (#261)", () => {
  it("admits evaluate as a valid WorkflowStepKind", () => {
    const kinds: WorkflowStepKind[] = ["inference", "host-operation", "evaluate"];
    expect(kinds).toContain("evaluate");
    const step = evaluateWorkflow().steps[0]!;
    expect(step.kind).toBe("evaluate");
    expect(step.mode).toBe("read-only");
  });

  it("rejects evaluate steps with write tools, path expansion, or auth minting", () => {
    const step = evaluateWorkflow().steps[0]!;

    expect(() =>
      assertEvaluateStepPolicy({
        step: { ...step, mode: "write" },
      }),
    ).toThrow(EvaluateStepPolicyError);
    expect(() =>
      assertEvaluateStepPolicy({
        step: { ...step, mode: "write" },
      }),
    ).toThrow(/evaluate-not-read-only/);

    expect(() =>
      assertEvaluateStepPolicy({
        step,
        grantedTools: ["read", "grep", "edit", "write"],
      }),
    ).toThrow(/evaluate-write-tools/);

    expect(() =>
      assertEvaluateStepPolicy({
        step,
        pathScopeExpanded: true,
      }),
    ).toThrow(/evaluate-path-scope-expanded/);

    expect(() =>
      assertEvaluateStepPolicy({
        step,
        authMinting: true,
      }),
    ).toThrow(/evaluate-auth-minting/);

    expect(() =>
      assertEvaluateStepPolicy({
        step,
        grantedTools: ["read", "grep", "find", "ls"],
        pathScopeExpanded: false,
        authMinting: false,
      }),
    ).not.toThrow();
  });

  it("cannot record evaluate as the sole Acceptance-passed authority", () => {
    expect(() =>
      assertEvaluateCannotSoleFlipAcceptance({
        acceptancePassed: true,
        authorities: ["evaluate"],
      }),
    ).toThrow(/evaluate-acceptance-sole-flip/);

    expect(() =>
      assertEvaluateCannotSoleFlipAcceptance({
        acceptancePassed: true,
        authorities: ["evaluate"],
        soleAuthorityStepKind: "evaluate",
      }),
    ).toThrow(/evaluate-acceptance-sole-flip/);

    expect(() =>
      assertEvaluateCannotSoleFlipAcceptance({
        acceptancePassed: true,
        authorities: ["evaluate", "host"],
      }),
    ).not.toThrow();

    expect(() =>
      assertEvaluateCannotSoleFlipAcceptance({
        acceptancePassed: true,
        authorities: ["machine-check"],
      }),
    ).not.toThrow();

    expect(() =>
      assertEvaluateCannotSoleFlipAcceptance({
        acceptancePassed: false,
        authorities: ["evaluate"],
      }),
    ).not.toThrow();
  });

  it("records content-free evaluator identity and policy digests", () => {
    const evidence = buildEvaluateStepEvidence({
      evaluatorSkillId: "documentation-audit",
      evaluatorContentSha256: "a".repeat(64),
      mode: "read-only",
      grantedTools: ["read", "grep", "find", "ls"],
    });
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      kind: "docsfab-evaluate-step-evidence",
    });
    expect(evidence.evaluatorIdentitySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.toolPolicySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.acceptancePolicySha256).toMatch(/^[a-f0-9]{64}$/);
    // Digests are content-free: no skill prose, credentials, or raw judgment.
    expect(JSON.stringify(evidence)).not.toMatch(/Judge the candidate/);
    expect(JSON.stringify(evidence)).not.toMatch(/api[_-]?key/i);
    expect(JSON.stringify(evidence)).not.toMatch(/secret/i);

    const again = buildEvaluateStepEvidence({
      evaluatorSkillId: "documentation-audit",
      evaluatorContentSha256: "a".repeat(64),
      mode: "read-only",
      grantedTools: ["ls", "find", "grep", "read"],
    });
    expect(again).toEqual(evidence);
  });

  it("mirrors evaluate as read-only in harness tool grants", () => {
    expect(grantedTools("write", "evaluate")).toEqual(grantedTools("read-only"));
    expect(grantedTools("write", "evaluate")).not.toContain("edit");
    expect(grantedTools("write", "evaluate")).not.toContain("write");
    expect(grantedTools("write", "inference")).toContain("edit");
  });

  it("runs an evaluate step through the runner and attaches evaluate evidence", async () => {
    const workflow = evaluateWorkflow();
    const originalGetWorkflow = getWorkflow;
    const catalogSpy = vi
      .spyOn(workflowCatalog, "getWorkflow")
      .mockImplementation((name) => (name === "readiness" ? workflow : originalGetWorkflow(name)));
    const harness: AgentHarness = {
      runStep: async () => ({
        outcome: "succeeded",
        summary: "evaluate-ok",
        skill: {
          id: "documentation-audit",
          contentSha256: "b".repeat(64),
        },
      }),
    };
    try {
      const store = new MemoryStore();
      const runner = new WorkflowRunner({
        harness,
        store,
        repositoryScanner: passedScanner,
        contextPreflight: unnecessaryContext,
        id: () => "run-evaluate-261",
      });
      const record = await runner.run({
        workflow: "readiness",
        workspacePath: "/tmp/docsfab-workspace/repository",
        repository: {
          sourcePath: "/tmp/repo",
          requestedRevision: "HEAD",
          revision: "c".repeat(40),
        },
        allowWrite: false,
      });
      expect(record.status).toBe("succeeded");
      expect(record.steps[0]?.kind).toBe("evaluate");
      expect(record.steps[0]?.evaluateEvidence).toMatchObject({
        schemaVersion: 1,
        kind: "docsfab-evaluate-step-evidence",
      });
      expect(record.steps[0]?.evaluateEvidence?.evaluatorIdentitySha256).toMatch(/^[a-f0-9]{64}$/);
      expect(() =>
        assertEvaluateCannotSoleFlipAcceptance({
          acceptancePassed: true,
          authorities: ["evaluate"],
          soleAuthorityStepKind: record.steps[0]?.kind,
        }),
      ).toThrow(/evaluate-acceptance-sole-flip/);
    } finally {
      catalogSpy.mockRestore();
    }
  });

  it("fails the run when an evaluate step is declared write", async () => {
    const workflow = evaluateWorkflow();
    Object.assign(workflow.steps, { 0: { ...workflow.steps[0]!, mode: "write" } });
    const originalGetWorkflow = getWorkflow;
    const catalogSpy = vi
      .spyOn(workflowCatalog, "getWorkflow")
      .mockImplementation((name) => (name === "readiness" ? workflow : originalGetWorkflow(name)));
    try {
      const store = new MemoryStore();
      const runner = new WorkflowRunner({
        harness: {
          runStep: async () => {
            throw new Error("evaluate write step must not reach the harness");
          },
        },
        store,
        repositoryScanner: passedScanner,
        contextPreflight: readyContextPreflight,
        id: () => "run-evaluate-write-reject",
      });
      const record = await runner.run({
        workflow: "readiness",
        workspacePath: "/tmp/docsfab-workspace/repository",
        repository: {
          sourcePath: "/tmp/repo",
          requestedRevision: "HEAD",
          revision: "d".repeat(40),
        },
        allowWrite: true,
      });
      expect(record.status).toBe("failed");
      expect(record.steps[0]?.error).toMatch(/evaluate-not-read-only/);
    } finally {
      catalogSpy.mockRestore();
    }
  });

  it("keeps existing inference and host-operation workflows decodable", () => {
    const readiness = getWorkflow("readiness");
    expect(readiness.steps.every((step) => (step.kind ?? "inference") === "inference")).toBe(true);

    const foundation = getWorkflow("foundation");
    expect(foundation.steps.map((step) => step.kind)).toEqual(["host-operation"]);
    expect(foundation.steps[0]?.operation).toBe("foundation");

    const iaPlan = getWorkflow("ia-plan");
    expect(iaPlan.steps[0]?.kind).toBe("host-operation");
    expect(iaPlan.steps[0]?.operation).toBe("ia-plan");

    const siteBootstrap = getWorkflow("site-bootstrap");
    expect(siteBootstrap.steps[0]?.kind).toBe("host-operation");

    // Closed kind union still accepts historical values without evaluate.
    const historical: WorkflowStepKind[] = ["inference", "host-operation"];
    expect(historical.includes("inference")).toBe(true);
    expect(historical.includes("host-operation")).toBe(true);
    expect((["inference", "host-operation", "evaluate"] as const).includes("evaluate")).toBe(true);
  });
});
