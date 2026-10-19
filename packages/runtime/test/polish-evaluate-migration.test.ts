// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { AgentHarness } from "../src/execution/contracts.js";
import type { ContextPreflightService } from "../src/context/contracts.js";
import type { RepositorySecurityScanner } from "../src/security/contracts.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import { grantedTools } from "../src/harness/pi-tool-confine.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import * as workflowCatalog from "../src/workflow-registry/catalog.js";
import {
  assertEvaluateCannotSoleFlipAcceptance,
  assertEvaluateStepPolicy,
  WorkflowRunner,
} from "../src/workflow-execution/runner.js";
import { bindDocumentationPlanProposal } from "../src/workflow-execution/plan-binding.js";
import { scriptedEditorialProtocol } from "./helpers/editorial-protocol.js";
import {
  inventorySearchCoordinatorFixture,
  sourceObligationObserverFixture,
  verificationFixture,
} from "./helpers/verification.js";

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

describe("update-documentation evaluate vs write policy (#262)", () => {
  it("keeps planning evaluate read-only and write inference write-capable", () => {
    const workflow = getWorkflow("update-documentation");
    const plan = workflow.steps.find((step) => step.id === "plan-documentation");
    const write = workflow.steps.find((step) => step.id === "write-documentation");
    expect(plan).toMatchObject({
      id: "plan-documentation",
      kind: "evaluate",
      mode: "read-only",
      skill: "plan-documentation",
    });
    expect(write).toMatchObject({
      id: "write-documentation",
      kind: "inference",
      mode: "write",
      skill: "write-documentation",
    });

    expect(() =>
      assertEvaluateStepPolicy({
        step: plan!,
        grantedTools: grantedTools(plan!.mode, plan!.kind),
        pathScopeExpanded: false,
        authMinting: false,
      }),
    ).not.toThrow();

    expect(grantedTools(plan!.mode, plan!.kind)).not.toContain("edit");
    expect(grantedTools(plan!.mode, plan!.kind)).not.toContain("write");
    expect(grantedTools(write!.mode, write!.kind)).toContain("edit");
  });

  it("does not let evaluate alone flip Acceptance", () => {
    const plan = getWorkflow("update-documentation").steps[0]!;
    expect(plan.kind).toBe("evaluate");

    expect(() =>
      assertEvaluateCannotSoleFlipAcceptance({
        acceptancePassed: true,
        authorities: ["evaluate"],
        soleAuthorityStepKind: plan.kind,
      }),
    ).toThrow(/evaluate-acceptance-sole-flip/);

    expect(() =>
      assertEvaluateCannotSoleFlipAcceptance({
        acceptancePassed: true,
        authorities: ["evaluate"],
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
  });

  it("runs planning evaluate under read-only allowWrite=false and attaches evidence", async () => {
    const workflow = getWorkflow("update-documentation");
    const plan = workflow.steps[0]!;
    // Drop search so this case exercises evaluate policy/evidence, not search wiring.
    const { search: _search, ...evaluateStep } = plan;
    const evaluateOnly = {
      ...workflow,
      steps: [evaluateStep],
      contextPolicy: {
        ...workflow.contextPolicy,
        steps: [workflow.contextPolicy.steps[0]!],
      },
    };
    const originalGetWorkflow = getWorkflow;
    const catalogSpy = vi
      .spyOn(workflowCatalog, "getWorkflow")
      .mockImplementation((name) =>
        name === "update-documentation" ? evaluateOnly : originalGetWorkflow(name),
      );
    const harness: AgentHarness = {
      runStep: async (input) => {
        expect(input.step.kind).toBe("evaluate");
        expect(input.step.mode).toBe("read-only");
        return {
          outcome: "succeeded",
          summary: "plan-evaluate-ok",
          planBinding: bindDocumentationPlanProposal({
            mode: "update",
            pages: [{ path: "README.md", disposition: "retain" }],
            sourceBindings: [],
          }),
          skill: {
            id: "plan-documentation",
            contentSha256: "a".repeat(64),
          },
        };
      },
    };
    try {
      const store = new MemoryStore();
      const protocol = withCompletedSelection(
        scriptedEditorialProtocol(harness, "insufficient-evidence"),
      );
      const runner = new WorkflowRunner({
        ...protocol,
        store,
        repositoryScanner: passedScanner,
        contextPreflight: unnecessaryContext,
        id: () => "run-update-evaluate-262",
      });
      const record = await runner.run({
        workflow: "update-documentation",
        workspacePath: "/tmp/docsfab-workspace/repository",
        repository: {
          sourcePath: "/tmp/repo",
          requestedRevision: "HEAD",
          revision: "c".repeat(40),
        },
        allowWrite: false,
      });
      expect(record.status, record.error).toBe("needs-input");
      expect(record.steps).toHaveLength(1);
      expect(record.steps[0]?.id).toBe("plan-documentation");
      expect(record.steps[0]?.kind).toBe("evaluate");
      expect(record.steps[0]?.evaluateEvidence).toMatchObject({
        schemaVersion: 1,
        kind: "docsfab-evaluate-step-evidence",
      });
    } finally {
      catalogSpy.mockRestore();
    }
    expect(getWorkflow("update-documentation").steps.some((step) => step.mode === "write")).toBe(
      true,
    );
  });

  it("requests --allow-write only after the author branch is selected", async () => {
    const store = new MemoryStore();
    const scripted = scriptedEditorialProtocol({
      runStep: async (input) => {
        if (input.step.id === "derive-source-obligations") {
          return verificationFixture(input);
        }
        if (input.step.id !== "plan-documentation") {
          throw new Error("apply must not run without allowWrite");
        }
        return {
          summary: "planned write",
          planBinding: bindDocumentationPlanProposal({
            mode: "update",
            pages: [{ path: "README.md", disposition: "update" }],
            sourceBindings: [{ pagePath: "README.md", sources: ["src/api.ts"] }],
          }),
        };
      },
    });
    const protocol = withCompletedSelection(scripted);
    const runner = new WorkflowRunner({
      ...protocol,
      store,
      repositoryScanner: passedScanner,
      contextPreflight: unnecessaryContext,
      workflowSearch: inventorySearchCoordinatorFixture,
      sourceObligationObserver: sourceObligationObserverFixture,
      id: () => "run-polish-apply-deny-262",
    });
    const record = await runner.run({
      workflow: "update-documentation",
      workspacePath: "/tmp/docsfab-workspace/repository",
      repository: {
        sourcePath: "/tmp/repo",
        requestedRevision: "HEAD",
        revision: "d".repeat(40),
      },
      allowWrite: false,
    });
    expect(record.status).toBe("needs-input");
    expect(record.steps.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "plan-documentation", status: "succeeded" },
      { id: "derive-source-obligations", status: "succeeded" },
      { id: "write-documentation", status: "needs-input" },
      { id: "lint-documentation", status: "pending" },
      { id: "verify-technical-accuracy", status: "pending" },
      { id: "review-documentation", status: "pending" },
      { id: "test-audience-understanding", status: "pending" },
      { id: "evaluate-document-quality", status: "pending" },
    ]);
    expect(record.workflowBranchCoverage).toMatchObject({
      selection: { branchId: "author" },
    });
    expect(
      getWorkflow("update-documentation").steps.find((step) => step.id === "write-documentation"),
    ).toMatchObject({
      id: "write-documentation",
      kind: "inference",
      mode: "write",
    });
  });
});

function withCompletedSelection(protocol: ReturnType<typeof scriptedEditorialProtocol>) {
  return {
    ...protocol,
    workflowBranchEvidence: {
      ...protocol.workflowBranchEvidence,
      select: async (input: Parameters<typeof protocol.workflowBranchEvidence.select>[0]) => {
        const selection = await protocol.workflowBranchEvidence.select(input);
        const insufficient = selection.candidate === "insufficient-evidence";
        const rationale = insufficient
          ? "The comparison evidence is unavailable."
          : "The retained plan nominates a documentation update.";
        const readerContext = {
          schema_version: 1 as const,
          target_audience: "DocsFab operator",
          reader_job: "Assess the planned documentation update.",
          change_scope: ["README.md"],
          source_priority: ["repository"],
          required_content: ["Current guidance"],
          excluded_content: [],
          unresolved_questions: [],
          impact_basis: {
            kind: insufficient ? ("unknown" as const) : ("public-behavior-change" as const),
            rationale,
            evidence_refs: [],
          },
        };
        const { impact_basis: _impactBasis, ...readerContextInput } = readerContext;
        const provenance = {
          schema_version: 1 as const,
          reader_context_sha256: "1".repeat(64),
          baseline_sha256: "2".repeat(64),
          admitted_revision: input.record.repository.revision,
          workspace_snapshot_sha256: selection.workspaceSnapshotSha256,
          repository_identity_sha256: "3".repeat(64),
          policy: { id: "update-documentation", version: "1", sha256: "4".repeat(64) },
          comparison: { kind: "unknown" as const },
          sources: [],
          observed_at: "2026-09-14T00:00:00.000Z",
          limitations: ["comparison-unavailable"],
        };
        return {
          ...selection,
          readerContext,
          readerContextProvenance: provenance,
          readerTaskContext: {
            schemaVersion: 1 as const,
            kind: "docsfab-reader-task-context-completed" as const,
            inputOrigin: "explicit" as const,
            noChangeAssessment: "requires-evidence" as const,
            readerContextInput,
            baseline: {
              path: "profiles/docsfab-documentation-quality/reader-impact-baseline.md",
              sha256: provenance.baseline_sha256,
              content: "Verified reader-impact baseline.",
            },
            policy: provenance.policy,
            readerContext,
            provenance,
            prompt: "[reader-task-context]\nCompleted host projection.",
          },
          editorialCandidate: {
            reference: selection.candidateArtifact,
            proposal: {
              schemaVersion: 1 as const,
              kind: "docsfab-editorial-decision-proposal" as const,
              candidate: selection.candidate,
              rationale,
              evidenceRefs: [],
              limitations: ["comparison-unavailable"],
              impactBasis: readerContext.impact_basis,
            },
          },
        };
      },
    },
  };
}
