// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { AgentHarness, HarnessStepInput } from "../src/execution/contracts.js";
import type { RepositorySecurityScanner } from "../src/security/contracts.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import {
  buildCliOperatorDirectedLineageInputs,
  captureRunTaskLineage,
  createBoundedInstructionRequestIdentity,
  mintCliOperatorDirectedLineage,
  projectTaskLineage,
} from "../src/lineage/index.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { readyContextPreflight } from "./helpers.js";

const IDENTITY = createHash("sha256").update("/tmp/cli-run-lineage-repo").digest("hex");
const REVISION = "a".repeat(40);
const REPOSITORY = {
  identitySha256: IDENTITY,
  revision: REVISION,
};
const INSTRUCTION = "Polish the onboarding guide for clarity.";
const AUTHORITY_ID = "local-operator";

describe("CLI operator-directed run lineage (#244)", () => {
  it("binds bounded-instruction request digests without persisting instruction text", () => {
    const inputs = buildCliOperatorDirectedLineageInputs({
      instruction: INSTRUCTION,
      task: null,
      workflow: "update-documentation",
      repository: REPOSITORY,
      authorityId: AUTHORITY_ID,
      runId: "run-fixture-001",
    });
    expect(inputs.origin.origin).toBe("operator-directed");
    expect(inputs.origin.request.kind).toBe("bounded-instruction");
    const expectedRequest = createBoundedInstructionRequestIdentity(
      INSTRUCTION,
      null,
      "update-documentation",
      REPOSITORY,
    );
    expect(inputs.origin.request.requestSha256).toBe(expectedRequest.requestSha256);
    expect(inputs.origin.request.taskSha256).toBe(expectedRequest.taskSha256);
    expect(JSON.stringify(inputs)).not.toContain(INSTRUCTION);
  });

  it("mints host-authenticated lineage that captures on the run record", async () => {
    const artifacts = await mintCliOperatorDirectedLineage({
      instruction: INSTRUCTION,
      task: null,
      workflow: "update-documentation",
      repository: REPOSITORY,
      authorityId: AUTHORITY_ID,
      now: () => new Date("2026-08-11T12:00:00.000Z"),
    });
    const projection = captureRunTaskLineage(
      {
        workflow: "update-documentation",
        repository: {
          sourcePath: "/tmp/cli-run-lineage-repo",
          requestedRevision: "HEAD",
          revision: REVISION,
        },
      },
      artifacts,
    );
    expect(projection.origin).toBe("operator-directed");
    expect(projection.requestKind).toBe("bounded-instruction");
    expect(projection.selectedWorkflow).toBe("update-documentation");
    expect(projection.authorityStatus).toBe("host-authenticated");
    const expectedRequest = createBoundedInstructionRequestIdentity(
      INSTRUCTION,
      null,
      "update-documentation",
      REPOSITORY,
    );
    expect(projection.requestSha256).toBe(expectedRequest.requestSha256);
  });

  it("records taskLineage on a write-capable run before steps execute", async () => {
    const artifacts = await mintCliOperatorDirectedLineage({
      instruction: INSTRUCTION,
      task: null,
      workflow: "update-documentation",
      repository: REPOSITORY,
      authorityId: AUTHORITY_ID,
      now: () => new Date("2026-08-11T12:00:00.000Z"),
    });
    const store = new MemoryStore();
    const runner = new WorkflowRunner({
      harness: new FakeHarness(),
      store,
      repositoryScanner: scanner,
      contextPreflight: readyContextPreflight,
      id: () => "cli-lineage-run",
      now: () => new Date("2026-08-11T12:00:00.000Z"),
    });
    const record = await runner.run({
      workflow: "update-documentation",
      workspacePath: "disposable-workspace",
      repository: {
        sourcePath: "/tmp/cli-run-lineage-repo",
        requestedRevision: "HEAD",
        revision: REVISION,
      },
      instruction: INSTRUCTION,
      allowWrite: true,
      taskLineage: artifacts,
    });
    expect(record.taskLineage).toBeDefined();
    expect(record.taskLineage!.origin).toBe("operator-directed");
    expect(record.taskLineage!.requestSha256).toBe(
      createBoundedInstructionRequestIdentity(INSTRUCTION, null, "update-documentation", REPOSITORY)
        .requestSha256,
    );
    expect(projectTaskLineage(artifacts.origin, artifacts.lineage).projectionSha256).toBe(
      record.taskLineage!.projectionSha256,
    );
  });
});

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

class FakeHarness implements AgentHarness {
  public async runStep(input: HarnessStepInput) {
    return {
      summary: `ran ${input.step.skill}`,
      model: { provider: "hosted", model: "test-model" },
      skill: { id: input.step.skill, contentSha256: "a".repeat(64) },
      usage: {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        total: 18,
        turns: 1,
        cost: 0.25,
      },
      tools: {
        totalCalls: 0,
        failedCalls: 0,
        byTool: [],
        failureCategories: [],
      },
    };
  }
}
