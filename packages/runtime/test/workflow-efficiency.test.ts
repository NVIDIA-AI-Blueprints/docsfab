// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalContextPreflightService } from "../src/context/preflight.js";
import type { ContextPreflightInput } from "../src/context/contracts.js";
import type { HarnessStepInput, RunReviewScope } from "../src/execution/contracts.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import { sourceObligationObserverFixture, verificationFixture } from "./helpers/verification.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();
const revision = "a".repeat(40);
async function fixture() {
  const root = await roots.create("docsfab-workflow-efficiency-");
  const repository = join(root, "repository");
  await mkdir(join(repository, "docs"), { recursive: true });
  await mkdir(join(repository, "unrelated"));
  await writeFile(join(repository, "docs", "quickstart.md"), "# Quickstart\n\nRun the tool.\n");
  await writeFile(join(repository, "unrelated", "other.md"), "# Other\n\nUnrelated content.\n");
  return {
    repository,
    service: new LocalContextPreflightService({ cacheRoot: join(root, "cache") }),
  };
}
function input(repository: string, stepId: string): ContextPreflightInput {
  const workflow = getWorkflow("review-documentation");
  return {
    runId: "efficiency-run",
    repository: { sourcePath: repository, requestedRevision: "HEAD", revision },
    workspacePath: repository,
    workflow,
    step: workflow.steps.find((step) => step.id === stepId)!,
    policy: workflow.contextPolicy.steps.find((policy) => policy.stepId === stepId)!,
  };
}

describe("workflow evidence efficiency", () => {
  it("reuses read-only context across roles and rebuilds after content changes", async () => {
    const { repository, service } = await fixture();
    const contextTarget = { sourcePath: "docs/quickstart.md" };
    const audit = { ...input(repository, "audit-documentation"), contextTarget };
    const review = { ...input(repository, "review-documentation"), contextTarget };
    const first = await service.preflight(audit);
    const repeated = await service.preflight(review);
    expect(first.status).toBe("ready");
    expect(first.cache?.disposition).toBe("miss");
    expect(repeated.cache).toMatchObject({ disposition: "hit", rebuildAttempted: false });
    expect(repeated.packetDigest).toBe(first.packetDigest);
    // A write inside the disposable checkout changes bytes, not its base revision.
    await writeFile(
      join(repository, "docs", "quickstart.md"),
      "# Quickstart\n\nUpdated instructions.\n",
    );
    const changed = await service.preflight(review);
    expect(changed.cache?.disposition).toBe("miss");
    expect(changed.packetDigest).not.toBe(first.packetDigest);
    expect((await service.preflight(audit)).cache?.disposition).toBe("hit");
  });
  it("separates target, budget, access mode, and degraded-read policy in the cache", async () => {
    const { repository, service } = await fixture();
    const base = {
      ...input(repository, "audit-documentation"),
      contextTarget: { sourcePath: "docs/quickstart.md" },
    };
    const first = await service.preflight(base);
    for (const changed of [
      { ...base, contextTarget: { sourcePath: "unrelated/other.md" } },
      { ...base, policy: { ...base.policy, level: "local" as const } },
      { ...base, step: { ...base.step, mode: "write" as const } },
      { ...base, policy: { ...base.policy, allowReadOnlyDegraded: false } },
    ]) {
      const result = await service.preflight(changed);
      expect(result.cache?.keyDigest).not.toBe(first.cache?.keyDigest);
      expect(result.cache?.disposition).toBe("miss");
    }
  });
  it("keeps a named page bounded through six stages and preserves findings only for the evaluator", async () => {
    const { repository, service } = await fixture();
    const seen: HarnessStepInput[] = [];
    const scope: RunReviewScope = {
      scope: "focused-set",
      reason: "operator-named",
      targetPaths: ["docs/quickstart.md"],
      deferredPaths: [],
      corpusFileCount: 2,
      scopeSha256: "b".repeat(64),
    };
    const record = await new WorkflowRunner({
      contextPreflight: service,
      store: { save: async () => {} },
      repositoryScanner: {
        scan: async () => ({
          ruleSet: "fixture",
          status: "passed",
          scannedFiles: 2,
          binaryFiles: 0,
          findings: [],
        }),
      },
      sourceObligationObserver: sourceObligationObserverFixture,
      workflowSearch: new LocalWorkflowSearchCoordinator(),
      hostOperations: {
        runStep: async (step) => {
          seen.push(step);
          return { summary: "Native check unavailable: fixture" };
        },
      },
      harness: {
        runStep: async (step) => {
          seen.push(step);
          if (step.step.id === "evaluate-document-quality") {
            throw new Error("Fixture evaluation failed; no formal quality evidence produced.");
          }
          return {
            summary: `EVIDENCE-${step.step.id}: docs/quickstart.md:3 needs correction; untested scope retained.`,
            ...(await verificationFixture(step)),
          };
        },
      },
    }).run({
      workflow: "review-documentation",
      workspacePath: repository,
      repository: { sourcePath: repository, requestedRevision: "HEAD", revision },
      reviewScope: scope,
      allowWrite: false,
    });
    expect(seen.map((step) => step.step.id)).toEqual(
      getWorkflow("review-documentation").steps.map((step) => step.id),
    );
    for (const step of seen) {
      expect(step.reviewScope).toEqual(scope);
      const nodes = step.contextPacket?.nodes as Array<{ sourcePath: string }>;
      expect(nodes.some((node) => node.sourcePath === "docs/quickstart.md")).toBe(true);
      expect(nodes.some((node) => node.sourcePath === "unrelated/other.md")).toBe(false);
    }
    expect(record.steps[0]?.contextPreflight?.cache?.disposition).toBe("miss");
    expect(
      record.steps.slice(1).every((step) => step.contextPreflight?.cache?.disposition === "hit"),
    ).toBe(true);
    expect(seen.find((step) => step.step.id === "review-documentation")?.step.prompt).not.toContain(
      "EVIDENCE-audit-documentation",
    );
    expect(seen.at(-1)!.step.prompt).toContain("EVIDENCE-audit-documentation");
    expect(seen.at(-1)!.step.prompt).toContain("EVIDENCE-review-documentation");
    expect(seen.at(-1)!.step.prompt).toContain("untested scope retained");
    // A failed evaluator must retain the earlier evidence and failed status.
    expect(record.status).toBe("failed");
  });
});
