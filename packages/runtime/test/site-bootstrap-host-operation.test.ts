// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { HarnessStepInput } from "../src/execution/contracts.js";
import {
  SiteBootstrapHostOperation,
  type SiteBootstrapOperationRunner,
  type SiteBootstrapRunInput,
  type SiteBootstrapRunRecord,
} from "../src/site-bootstrap/index.js";
import { siteBootstrapBundle, siteBootstrapIndex } from "./site-bootstrap-fixtures.js";

const NOW = new Date("2026-08-03T16:00:00.000Z");
const REVISION = "a".repeat(40);

describe("site-bootstrap host operation adapter", () => {
  it("binds the exact closed task and returns only content-free artifact uses", async () => {
    const operationInput = input();
    const runner: SiteBootstrapOperationRunner = {
      run: async () => record("succeeded"),
    };
    const result = await new SiteBootstrapHostOperation(runner, operationInput).runStep(
      stepInput(operationInput),
    );

    expect(result).toMatchObject({ outcome: "succeeded" });
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts?.map((use) => use.reference.kind)).toEqual([
      "ia-plan",
      "ia-evaluation",
    ]);
    expect(JSON.stringify(result)).not.toContain("docs/get-started/quickstart.md");
  });

  it("rejects another plan and converts a failed mutation record to a step failure", async () => {
    const operationInput = input();
    const adapter = new SiteBootstrapHostOperation(
      {
        run: async () => record("failed"),
      },
      operationInput,
    );
    const mismatched = stepInput(operationInput);
    if (mismatched.task?.kind !== "site-bootstrap") throw new Error("fixture");
    mismatched.task.plan.digest = "0".repeat(64);
    await expect(adapter.runStep(mismatched)).rejects.toThrow("invalid-bundle");
    await expect(adapter.runStep(stepInput(operationInput))).rejects.toThrow("scaffold-failed");
  });
});

function input(): SiteBootstrapRunInput {
  const bundle = siteBootstrapBundle(siteBootstrapIndex(REVISION), NOW);
  return {
    allowWrite: true,
    workspace: {
      path: "/workspace",
      sourcePath: "/source",
      requestedRevision: bundle.repository.revision,
      revision: bundle.repository.revision,
    } as SiteBootstrapRunInput["workspace"],
    repository: {
      sourcePath: "/source",
      requestedRevision: bundle.repository.revision,
      revision: bundle.repository.revision,
    },
    bundle,
    approval: {} as SiteBootstrapRunInput["approval"],
    templates: {} as SiteBootstrapRunInput["templates"],
    checks: {} as SiteBootstrapRunInput["checks"],
  };
}

function stepInput(operation: SiteBootstrapRunInput): HarnessStepInput {
  const plan = operation.bundle.plan;
  return {
    repositoryPath: operation.workspace.path,
    workflow: {
      name: "site-bootstrap",
      title: "Site bootstrap",
      outcome: "Patch",
      contextPolicy: { schemaVersion: 1, steps: [] },
      steps: [],
    },
    step: {
      id: "apply-site-bootstrap",
      title: "Apply",
      kind: "host-operation",
      operation: "site-bootstrap",
      skill: "template-scaffold-site",
      mode: "write",
      prompt: "Apply",
    },
    task: {
      kind: "site-bootstrap",
      plan: {
        kind: "ia-plan",
        schemaVersion: 1,
        digest: plan.digest,
        repositoryRevision: plan.repository.revision,
        repositoryContentDigest: plan.repository.contentDigest,
      },
    },
  };
}

function record(status: "succeeded" | "failed"): SiteBootstrapRunRecord {
  const bundle = siteBootstrapBundle(siteBootstrapIndex(REVISION), NOW);
  return {
    schemaVersion: 1,
    id: "site-run",
    operation: "site-bootstrap",
    repository: {
      sourcePath: "/source",
      requestedRevision: bundle.repository.revision,
      revision: bundle.repository.revision,
    },
    workspace: { strategy: "tracked-export", disposable: true },
    plan: {
      kind: "ia-plan",
      schemaVersion: 1,
      digest: bundle.plan.digest,
      repositoryRevision: bundle.repository.revision,
      repositoryContentDigest: bundle.repository.contentDigest,
    },
    status,
    createdAt: "2026-08-03T16:00:00.000Z",
    mutationBoundaryEntered: true,
    ...(status === "failed" ? { error: "scaffold-failed" as const } : {}),
  };
}
