// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { AgentHarness } from "../src/execution/contracts.js";
import type { RepositorySecurityScanner } from "../src/security/contracts.js";
import type { RunRecord, RunStatus, RunStore } from "../src/records/contracts.js";
import type { WorkflowName } from "../src/workflow-contracts/contracts.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import {
  assertRunTaskLineageResumeEquivalent,
  captureRunTaskLineage,
  createTaskLineageArtifacts,
  evaluateRunPublicationLineageEligibility,
  mintTaskLineageHostCapability,
  recordRunTaskLineage,
  restoreRunTaskLineage,
  RunTaskLineageError,
  serializeRunTaskLineage,
} from "../src/lineage/index.js";
import { internalCreateTaskLineageHostAuthority } from "../src/lineage/authority-internal.js";
import type {
  DecisionAttributionInputV1,
  TaskLineageArtifactsV1,
  TaskLineageRepositoryBindingV1,
  TaskOriginInputV1,
  TaskRequestIdentityV1,
} from "../src/lineage/index.js";
import { buildCurrentTaskLineageFixture } from "./helpers/current-task-lineage.js";

const fixture = buildCurrentTaskLineageFixture();
const SHA = (character: string) => character.repeat(64);
const REPO_REVISION = fixture.repository.revision;

type OriginClass = "operator-directed" | "docsfab-recommended-approved" | "docsfab-autonomous";

function currentOrigin(origin: OriginClass): TaskOriginInputV1 {
  const common = {
    lineageId: `lineage:${origin}`,
    repository: structuredClone(fixture.repository),
    request: structuredClone(fixture.request),
  };
  if (origin === "operator-directed") return operatorOrigin(common);
  if (origin === "docsfab-recommended-approved") return recommendedOrigin(common);
  return autonomousOrigin(common);
}

interface CommonOrigin {
  lineageId: string;
  repository: TaskLineageRepositoryBindingV1;
  request: TaskRequestIdentityV1;
}

function operatorOrigin(common: CommonOrigin): TaskOriginInputV1 {
  const approval = structuredClone(fixture.approval);
  const origin = "operator-directed" as const;
  const selectedBy = "operator" as const;
  return {
    ...common,
    origin,
    selectedBy,
    approval,
    recommendation: null,
    autonomousSelection: null,
  };
}

function recommendedOrigin(common: CommonOrigin): TaskOriginInputV1 {
  const approval = structuredClone(fixture.approval);
  approval.approvedRecommendationSha256 = fixture.recommendation.recommendationSha256;
  const origin = "docsfab-recommended-approved" as const;
  const recommendation = structuredClone(fixture.recommendation);
  const selectedBy = "operator" as const;
  return {
    ...common,
    origin,
    selectedBy,
    approval,
    recommendation,
    autonomousSelection: null,
  };
}

function autonomousOrigin(common: CommonOrigin): TaskOriginInputV1 {
  const origin = "docsfab-autonomous" as const;
  const selectedBy = "deterministic-workflow" as const;
  const autonomousSelection = structuredClone(fixture.autonomousSelection);
  return {
    ...common,
    origin,
    selectedBy,
    approval: null,
    recommendation: null,
    autonomousSelection,
  };
}

function lineageInput(origin: OriginClass) {
  const autonomous = origin === "docsfab-autonomous";
  const taskActor = autonomous ? "deterministic-workflow" : "operator";
  const authoritySource = autonomous ? "workflow-contract" : "operator-approval";
  const authoritySha256 = autonomous
    ? fixture.autonomousSelection.decisionSha256
    : fixture.approval.approvalSha256;
  const taskDecision: DecisionAttributionInputV1 = {
    id: "decision:task",
    domain: "task",
    actor: taskActor,
    effect: "authoritative",
    outcomeSha256: fixture.request.taskSha256!,
    authoritySource,
    authoritySha256,
    evidenceSha256s: [fixture.request.requestSha256!],
    boundedByDecisionIds: [],
    reasonCode: origin,
  };
  const autoCandidate = autonomous ? fixture.autonomousSelection.candidateSha256 : null;
  return {
    lineageId: `lineage:${origin}`,
    candidates: structuredClone(fixture.candidates),
    selectedCandidateSha256: fixture.selectedCandidateSha256,
    selectedSourceAutoCandidateSha256: autoCandidate,
    rejectedAlternatives: structuredClone(fixture.rejectedAlternatives),
    decisions: [taskDecision, ...structuredClone(fixture.sharedDecisions)],
  };
}

function authority(receipt: string) {
  return internalCreateTaskLineageHostAuthority({
    async verifyCurrent(challenge) {
      const status = "current" as const;
      const observedAt = "2026-08-05T18:00:00.000Z";
      const challengeSha256 = challenge.challengeSha256;
      const authorityReceiptSha256 = receipt;
      return { status, challengeSha256, observedAt, authorityReceiptSha256 };
    },
  });
}

async function mintArtifacts(
  origin: OriginClass,
  receipt: string,
): Promise<TaskLineageArtifactsV1> {
  const capability = await mintTaskLineageHostCapability(
    { origin: currentOrigin(origin) as never, lineage: lineageInput(origin) },
    authority(receipt),
  );
  return createTaskLineageArtifacts(capability);
}

const REPOSITORY = {
  sourcePath: "source-repository",
  requestedRevision: "HEAD",
  revision: REPO_REVISION,
};

class MemoryStore implements RunStore {
  public records: RunRecord[] = [];
  public async save(record: RunRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}

const scanner: RepositorySecurityScanner = {
  scan: async () => ({
    ruleSet: "test-v1",
    status: "passed",
    scannedFiles: 1,
    binaryFiles: 0,
    findings: [],
  }),
};

const unusedHarness: AgentHarness = {
  runStep: async () => {
    throw new Error("harness must not execute when lineage capture rejects the run early");
  },
};

async function mintPair(origin: OriginClass, receipt: string) {
  const input = {
    origin: currentOrigin(origin) as never,
    lineage: lineageInput(origin),
  };
  const capability = await mintTaskLineageHostCapability(input, authority(receipt));
  const artifacts = createTaskLineageArtifacts(capability);
  return { capability, artifacts };
}

function runRecord(workflow: WorkflowName, status: RunStatus): RunRecord {
  const partial = { workflow, repository: REPOSITORY, status };
  return partial as unknown as RunRecord;
}

describe("task-lineage runtime capture", () => {
  const context = {
    workflow: "update-documentation" as const,
    repository: REPOSITORY,
  };

  const captureError = (fn: () => unknown): string => {
    try {
      fn();
      return "no-error";
    } catch (error) {
      return (error as RunTaskLineageError).code;
    }
  };

  it("records a manual edit as operator-directed even when an audit substantiates it", async () => {
    const artifacts = await mintArtifacts("operator-directed", SHA("a"));
    const projection = captureRunTaskLineage(context, artifacts);
    expect(projection.origin).toBe("operator-directed");
    expect(projection.selectedWorkflow).toBe("update-documentation");
    expect(projection.authorityStatus).toBe("host-authenticated");
  });

  it("captures recommended and autonomous origins only through the authenticated path", async () => {
    const recommended = await mintArtifacts("docsfab-recommended-approved", SHA("b"));
    const autonomous = await mintArtifacts("docsfab-autonomous", SHA("c"));
    const one = captureRunTaskLineage(context, recommended);
    const two = captureRunTaskLineage(context, autonomous);
    expect(one.origin).toBe("docsfab-recommended-approved");
    expect(two.origin).toBe("docsfab-autonomous");
    const serialized = serializeRunTaskLineage(recommended);
    const origin = JSON.parse(serialized.origin);
    const lineage = JSON.parse(serialized.lineage);
    const lookalike = { origin, lineage };
    const code = captureError(() => captureRunTaskLineage(context, lookalike));
    expect(code).toBe("lineage-unauthenticated");
  });

  it("fails capture with a content-free diagnostic when lineage misbinds the workflow", async () => {
    const artifacts = await mintArtifacts("operator-directed", SHA("e"));
    const wrong = {
      workflow: "review-documentation" as const,
      repository: REPOSITORY,
    };
    const code = captureError(() => captureRunTaskLineage(wrong, artifacts));
    expect(code).toBe("workflow-mismatch");
  });

  it("keeps resumed lineage byte-equivalent and rejects any restatement of scope", async () => {
    const pair = await mintPair("docsfab-autonomous", SHA("6"));
    const original = captureRunTaskLineage(context, pair.artifacts);
    const serialized = serializeRunTaskLineage(pair.artifacts);
    const restored = restoreRunTaskLineage(serialized, pair.capability, context, original);
    expect(restored.projectionSha256).toBe(original.projectionSha256);
    const other = await mintArtifacts("operator-directed", SHA("a"));
    const otherProjection = captureRunTaskLineage(context, other);
    const code = captureError(() =>
      assertRunTaskLineageResumeEquivalent(otherProjection, original),
    );
    expect(code).toBe("resume-lineage-conflict");
  });

  it("gates publication eligibility on complete lineage with content-free diagnostics", async () => {
    const artifacts = await mintArtifacts("operator-directed", SHA("a"));
    const succeeded = runRecord("update-documentation", "succeeded");
    recordRunTaskLineage(succeeded, artifacts);
    const eligible = evaluateRunPublicationLineageEligibility(succeeded);
    expect(eligible.eligible).toBe(true);
    expect(eligible.diagnostics).toEqual([]);
    const missing = runRecord("update-documentation", "succeeded");
    const missingResult = evaluateRunPublicationLineageEligibility(missing);
    expect(missingResult.eligible).toBe(false);
    expect(missingResult.diagnostics).toContain("lineage-absent");
    const failed = runRecord("update-documentation", "failed");
    recordRunTaskLineage(failed, artifacts);
    const failedResult = evaluateRunPublicationLineageEligibility(failed);
    expect(failedResult.eligible).toBe(false);
    expect(failedResult.diagnostics).toContain("run-not-successful");
    const serialized = JSON.stringify(missingResult) + JSON.stringify(eligible);
    expect(serialized).not.toContain("operator:fixture");
    expect(serialized).not.toContain("approval");
  });

  it("fails a run whose supplied lineage is incompatible before any step executes", async () => {
    const artifacts = await mintArtifacts("operator-directed", SHA("a"));
    const store = new MemoryStore();
    const runner = new WorkflowRunner({
      harness: unusedHarness,
      store,
      repositoryScanner: scanner,
      id: () => "lineage-run",
      now: () => new Date("2026-08-07T12:00:00.000Z"),
    });
    const record = await runner.run({
      workflow: "readiness",
      workspacePath: "disposable-workspace",
      repository: REPOSITORY,
      allowWrite: false,
      taskLineage: artifacts,
    });
    expect(record.status).toBe("failed");
    expect(record.taskLineage).toBeUndefined();
    expect(record.error).not.toContain("operator:fixture");
    expect(store.records.length).toBeGreaterThan(0);
  });
});
