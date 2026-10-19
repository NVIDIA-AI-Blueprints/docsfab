// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  projectAutoDryRunPresentation,
  projectAutoGatePresentation,
  projectAutoOncePresentation,
  projectAutoPublishPresentation,
  projectCampaignPresentation,
  projectEvaluationPresentation,
  projectIssueApplyPresentation,
  projectIssuePreflightPresentation,
  renderAdvancedPresentation,
} from "../src/cli/advanced-presentation.js";
import { resolvePresentationCapabilities } from "../src/operator/presentation/index.js";
import { runAutoOnceCli } from "../src/autonomy/once-cli.js";
import { runAutoPublishCli } from "../src/autonomy/managed-publish-cli.js";
import type { AutoDryRunResultV1 } from "../src/autonomy/dry-run.js";
import type { AutoCycleOnceRecordV1 } from "../src/autonomy/once.js";
import type { ManagedCyclePublishOutcomeV1 } from "../src/autonomy/managed-publish.js";
import type { MultiUnitCampaignDryRunResultV1 } from "../src/autonomy/multi-unit-campaign-run.js";
import type { EvaluationResult } from "../src/quality-evaluation/contracts.js";
import type {
  IssueLifecycleApplicationResult,
  IssueLifecyclePreflightV1,
} from "../src/roadmap/issue-lifecycle.js";

const caps = (columns: number) =>
  resolvePresentationCapabilities({
    stdout: { isTTY: false, columns },
    stderr: { isTTY: false, columns },
    environment: { noColorPresent: true, forceColor: false, ci: true, termDumb: false },
    unicode: false,
  });

function show(document: Parameters<typeof renderAdvancedPresentation>[0], columns = 120): string {
  return renderAdvancedPresentation(document, caps(columns));
}

const source = {
  repositoryPath: "/work/docs",
  targetBranch: "main",
  decision: { disposition: "execute" },
} as unknown as import("../src/autonomy/dry-run.js").AutoDryRunSourceV1;

const missingInput = {
  repositoryPath: "/work/docs",
  reasonCode: "missing-observation",
  openInputIds: ["tracker-snapshot", "reviewer-policy"],
} as unknown as import("../src/autonomy/dry-run.js").AutoDryRunNeedsInputV1;

describe("advanced CLI shared presentation (#2491)", () => {
  it("keeps structural evaluation decisive and judge findings advisory", () => {
    const result: EvaluationResult = {
      passed: false,
      structural: {
        fixture: "sample",
        recordCount: 2,
        passed: false,
        results: [
          { assertion: { type: "run-count", minimum: 1 }, passed: true, message: "has a record" },
          {
            assertion: { type: "run-count", minimum: 1 },
            passed: false,
            recordId: "run-2",
            message: "missing governed evidence",
          },
        ],
      },
      judge: {
        status: "passed",
        rubric: { id: "evidence", version: 1 },
        model: { provider: "offline", model: "fixture" },
        score: 0.8,
        rationale: "advisory only",
      },
    };
    const output = show(projectEvaluationPresentation("sample", result), 44);
    expect(output).toContain("Verdict: FAIL");
    expect(output).toContain("run-2");
    expect(output.replace(/\s+/gu, " ")).toContain("missing governed evidence");
    expect(output).toContain("ADVISORY JUDGE");
    expect(output).toContain("Rationale: advisory only");
    expect(output).not.toContain("\u001b[");
  });

  it("preserves dry-run proposal effects, open inputs, operation identities and safe next action", () => {
    const result = {
      decision: {
        disposition: "execute",
        confidence: "bounded",
        workflow: "create-documentation",
        reasonCode: "selected",
        evidenceIds: ["finding-a"],
        dependencies: [{ id: "source", state: "satisfied" }],
        pathScope: ["docs/guide.md"],
        expectedValidation: ["docs-build"],
        openInputIds: ["approval"],
      },
      repository: {
        path: "/work/docs",
        revision: "abc123",
        inventoryStatus: "complete",
        inventorySha256: "digest",
      },
      operations: [{ key: "issue-a", action: "create", target: { kind: "issue" } }],
      draftMergeRequestDestination: { targetBranch: "main" },
      nextAction: "Review the plan before confirmation.",
    } as unknown as AutoDryRunResultV1;
    const output = show(projectAutoDryRunPresentation(result), 48);
    expect(output).toContain("Writes performed: none");
    expect(output).toContain("Authorization: none");
    expect(output).toContain("issue-a: create issue");
    expect(output).toContain("Open inputs: approval");
    expect(output).toContain("Review the plan before confirmation.");
    const quiet = show(projectAutoDryRunPresentation(result, "quiet"));
    expect(quiet).toContain("issue-a: create issue");
    expect(quiet).toContain("Open inputs: approval");
    const verbose = show(projectAutoDryRunPresentation(result, "verbose"), 40);
    expect(verbose).toContain("Repository revision: abc123");
    expect(verbose).toContain("Validation: docs-build");
  });

  it("renders unconfirmed and missing-input auto modes without performing work", async () => {
    const missing = show(
      projectAutoGatePresentation("once", { status: "needs-input", input: missingInput }),
    );
    expect(missing).toContain("Disposition: needs-input");
    expect(missing).toContain("tracker-snapshot");
    expect(missing).toContain("Writes performed: none");
    const logs: string[] = [];
    let writes = 0;
    await runAutoOnceCli(["--once", "--repo", "/work/docs"], {
      cwd: "/work/docs",
      log: (line) => logs.push(line),
      assess: async () => ({ status: "ready", source, dispose: async () => undefined }),
      runWorkflow: async () => {
        writes += 1;
        return undefined;
      },
      save: async () => {
        writes += 1;
      },
    });
    expect(writes).toBe(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("Auto once proposal");
    expect(logs[0]).toContain("Authorization: confirmation required");
    expect(logs[0]).toContain("--confirm-cycle");
  });

  it("preserves the existing machine-path proposal bytes for auto --once", async () => {
    const logs: string[] = [];
    await runAutoOnceCli(["--once", "--json", "--repo", "/work/docs"], {
      cwd: "/work/docs",
      log: (line) => logs.push(line),
      assess: async () => ({ status: "ready", source, dispose: async () => undefined }),
      runWorkflow: async () => undefined,
    });
    expect(logs).toEqual([
      "auto --once proposal: execute; re-run with --confirm-cycle to authorize one bounded documentation cycle.",
    ]);
  });

  it("keeps saved auto-cycle failure and validation evidence inspectable", () => {
    const record = {
      cycleId: "cycle-a",
      disposition: "executed-failed",
      requestSha256: "request-digest",
      checkpoints: [{}, {}],
      runRecordId: "run-a",
      authorizationProjection: {
        authorizationSha256: "authority-digest",
        workflow: "create-documentation",
        deliveryMode: "local-patch",
      },
      publicationEligibility: { eligible: false, diagnostics: ["run-not-successful"] },
      terminalResult: {
        workflowExecutionStatus: "failed",
        terminalResultSha256: "terminal-digest",
        validation: [{ id: "docs-build", status: "not-run" }],
      },
    } as unknown as AutoCycleOnceRecordV1;
    const output = show(projectAutoOncePresentation(record), 54);
    expect(output).toContain("Disposition: executed-failed");
    expect(output).toContain("Publication diagnostic: run-not-successful");
    expect(output).toContain("docs-build: not-run");
    expect(output).toContain("'docsfab' 'runs' 'show' 'run-a'");
  });

  it("keeps publish proposals read-only and deferred patch recovery visible", async () => {
    const logs: string[] = [];
    let published = 0;
    await runAutoPublishCli(["--publish", "--candidates", "/unused/manifest.json"], {
      cwd: "/work/docs",
      stateDirectory: "/unused/state",
      log: (line) => logs.push(line),
      readCandidates: async () => ({ trackerObservationSha256: "unused", candidates: [] }) as never,
      assess: async () => ({ status: "ready", source, dispose: async () => undefined }),
      runWorkflow: async () => {
        published += 1;
        return undefined;
      },
      publish: async () => {
        published += 1;
        throw new Error("unexpected publish");
      },
    });
    expect(published).toBe(0);
    expect(logs[0]).toContain("Auto publish proposal");
    expect(logs[0]).toContain("Writes performed: none");
    const outcome = {
      cycle: {
        selection: { cycleId: "cycle-a", selected: { issueIid: 42 } },
        link: { disposition: "linked", lifecycleTarget: "issue" },
      },
      publish: {
        status: "deferred",
        failureCode: "push-refused",
        patchEvidencePreserved: true,
        recoveryCommand: "docsfab publish --run run-a",
        nextAction: "inspect receipt",
      },
    } as unknown as ManagedCyclePublishOutcomeV1;
    const output = show(projectAutoPublishPresentation(outcome));
    expect(output).toContain("Publication: deferred");
    expect(output).toContain("Patch preserved: yes");
    expect(output).toContain("push-refused");
    expect(output).toContain("inspect receipt");
    expect(output).toContain("docsfab publish --run run-a");
    expect(output.indexOf("inspect receipt")).toBeLessThan(
      output.indexOf("docsfab publish --run run-a"),
    );
  });

  it("preserves the existing machine-path proposal bytes for auto --publish", async () => {
    const logs: string[] = [];
    await runAutoPublishCli(["--publish", "--json", "--candidates", "/unused/manifest.json"], {
      cwd: "/work/docs",
      stateDirectory: "/unused/state",
      log: (line) => logs.push(line),
      readCandidates: async () => ({ trackerObservationSha256: "unused", candidates: [] }) as never,
      assess: async () => ({ status: "ready", source, dispose: async () => undefined }),
      runWorkflow: async () => undefined,
      publish: async () => {
        throw new Error("unexpected publish");
      },
    });
    expect(logs).toEqual([
      "auto --publish proposal: execute; re-run with --confirm-cycle to authorize one bounded documentation publish cycle.",
    ]);
  });

  it("shows a successful publication artifact without changing the saved outcome", () => {
    const outcome = {
      cycle: {
        selection: { cycleId: "cycle-b", selected: { issueIid: 43 } },
        link: { disposition: "linked", lifecycleTarget: "draft-mr" },
      },
      publish: {
        status: "opened",
        patchEvidencePreserved: true,
        mergeRequest: { iid: 7, url: "https://example.invalid/merge_requests/7" },
      },
    } as unknown as ManagedCyclePublishOutcomeV1;
    const before = JSON.stringify(outcome);
    const output = show(projectAutoPublishPresentation(outcome), 46);
    expect(output).toContain("Publication: opened");
    expect(output).toContain("Draft MR !7");
    expect(output).toContain("https://example.invalid/merge_requests/7");
    expect(JSON.stringify(outcome)).toBe(before);
  });

  it("shows partial campaign progress and its unchanged source", () => {
    const result = {
      campaignId: "campaign-a",
      stopReason: "cap-exhausted",
      sourceRevision: "abc123",
      unitsProcessed: 2,
      queueIndex: 2,
      campaignAttempts: 3,
      sourceCheckoutUnchanged: true,
      progressDigest: "progress-digest",
    } as unknown as MultiUnitCampaignDryRunResultV1;
    const output = show(projectCampaignPresentation(result), 42);
    expect(output).toContain("cap-exhausted");
    expect(output).toContain("Campaign attempt cap: exhausted");
    expect(output).toContain("Queue index: 2");
    expect(output).toContain("Source checkout unchanged: yes");
    expect(output).toContain("Progress digest: progress-digest");
  });

  it("shows roadmap preflight effects and partial-apply recovery without new authority", () => {
    const preflight = {
      status: "ready",
      project: { fullPath: "example/docs" },
      operations: [{ operationKey: "create-a", action: "create-issue" }],
      planDigest: "plan-digest",
      digest: "preflight-digest",
    } as unknown as IssueLifecyclePreflightV1;
    const plan = show(projectIssuePreflightPresentation(preflight));
    expect(plan).toContain("Writes performed: none");
    expect(plan).toContain("Authorization: required for apply");
    expect(plan).toContain("create-a: create-issue");
    expect(plan).toContain("Plan: plan-digest");
    const applied = {
      preflight,
      nextSafeAction: "reconcile-ambiguous-effect",
      receipt: {
        terminal: "ambiguous",
        attempts: [{ disposition: "uncertain" }],
        remainingOperationKeys: ["create-b"],
        digest: "receipt-digest",
        planDigest: "plan-digest",
        authorizationDigest: "authorization-digest",
        lastConfirmedOperationKey: "create-a",
      },
    } as unknown as IssueLifecycleApplicationResult;
    const result = show(projectIssueApplyPresentation(applied), 45);
    expect(result).toContain("Status: ambiguous");
    expect(result).toContain("Remaining operation keys: create-b");
    expect(result).toContain("reconcile-ambiguous-effect");
    expect(result).toContain("Receipt: receipt-digest");
  });
});
