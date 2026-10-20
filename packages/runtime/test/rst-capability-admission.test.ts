// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalDigest } from "../src/content-ir/canonical.js";
import { createRstCapabilityAdmission } from "../src/rst-authoring/capability-admission.js";
import type { WorkflowTaskInput } from "../src/workflow-contracts/contracts.js";
import type { RunRequest } from "../src/execution/contracts.js";
import { isProcessEntrypoint, runCliEntrypoint } from "../src/operator/cli-entrypoint.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import type { WorkflowRunnerOptions } from "../src/workflow-execution/runner-ports.js";

const digest = "a".repeat(64);
const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

function runnerRequest(workflow: "update-documentation" | "foundation-to-patch"): RunRequest {
  const sourcePath = "/tmp/docsfab-central-rst-guard";
  const revision = "b".repeat(40);
  const approvedProposal = "Add one source-backed RST clarification.";
  const task: WorkflowTaskInput =
    workflow === "update-documentation"
      ? {
          kind: "bounded-doc-improvement",
          campaignId: "campaign",
          repositoryId: "fixture/docs",
          testedCommit: revision,
          repositoryIdentitySha256: createHash("sha256").update(sourcePath).digest("hex"),
          contextSourcePath: "src/change.md",
          gap: { id: "gap", evidenceSha256: digest, successCriterionSha256: digest },
          analysis: {
            runId: "analysis-run",
            recordSha256: digest,
            approvedOutcomeSha256: canonicalDigest(approvedProposal),
            approvedProposal,
          },
          authorization: { sha256: digest, digest },
          intendedPaths: ["docs/guide.rst"],
        }
      : { kind: "foundation-to-patch", intendedPaths: ["docs/guide.rst"] };
  return {
    workflow,
    workspacePath: `${sourcePath}/workspace`,
    repository: { sourcePath, requestedRevision: revision, revision },
    task,
    allowWrite: true,
  };
}

function runnerOptions(
  providerCalls: { count: number },
  extra: Partial<WorkflowRunnerOptions> = {},
) {
  return {
    harness: {
      async runStep() {
        providerCalls.count += 1;
        return { summary: "unexpected provider call" };
      },
    },
    store: { async save() {} },
    repositoryScanner: {
      async scan() {
        return {
          ruleSet: "test",
          status: "passed" as const,
          scannedFiles: 0,
          binaryFiles: 0,
          findings: [],
        };
      },
    },
    ...extra,
  };
}

async function runShippedErrorBoundary(error: unknown) {
  const lines: string[] = [];
  vi.spyOn(console, "error").mockImplementation((line?: unknown) => {
    lines.push(String(line));
  });
  process.argv = [originalArgv[0]!, fileURLToPath(import.meta.url), "--json"];
  if (!isProcessEntrypoint(import.meta.url)) {
    throw new Error(`test CLI module was not recognized as entrypoint: ${process.argv[1]}`);
  }
  runCliEntrypoint(import.meta.url, async () => {
    throw error;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { lines, exitCode: process.exitCode };
}

describe("central RST capability admission", () => {
  it("refuses a direct RST operation before any provider call", async () => {
    const providerCalls = { count: 0 };
    const failure = await new WorkflowRunner(runnerOptions(providerCalls))
      .run(runnerRequest("foundation-to-patch"))
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "rst-capability-unsupported-operation" });
    expect(providerCalls.count).toBe(0);
  });

  it("requires admission when a host omits delivery facts and preserves the CLI error", async () => {
    const providerCalls = { count: 0 };
    const failure = await new WorkflowRunner(runnerOptions(providerCalls))
      .run(runnerRequest("update-documentation"))
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "rst-capability-admission-required" });
    expect(providerCalls.count).toBe(0);
    const cli = await runShippedErrorBoundary(failure);
    expect(cli.exitCode).toBe(1);
    expect(JSON.parse(cli.lines[0]!)).toMatchObject({
      code: "rst-capability-admission-required",
      nextAction:
        "Run one existing Sphinx RST page through the DocsFab CLI with update-documentation and --patch-only, or select a supported Markdown or MDX target.",
    });
  });

  it("refuses mismatched and forged internal bindings before any provider call", async () => {
    const request = runnerRequest("update-documentation");
    const matchingOptions = {
      planWriteScope: {
        roots: ["docs/"],
        rule: () => undefined,
        rstUpdatePaths: ["docs/guide.rst"],
      },
    };
    const admission = createRstCapabilityAdmission({
      workflow: request.workflow,
      delivery: "patch-only",
      targetPaths: ["docs/guide.rst"],
      taskSha256: "c".repeat(64),
      repositoryIdentitySha256: createHash("sha256")
        .update(request.repository.sourcePath)
        .digest("hex"),
      repositoryRevision: request.repository.revision,
      documentationRoots: ["docs/"],
      adapterConfigurationSha256: digest,
      adapterEligible: true,
    });
    const mismatchedCalls = { count: 0 };
    const mismatched = await new WorkflowRunner(
      runnerOptions(mismatchedCalls, { ...matchingOptions, rstCapabilityAdmission: admission }),
    )
      .run(request)
      .catch((error: unknown) => error);
    expect(mismatched).toMatchObject({ code: "rst-capability-admission-required" });
    expect(mismatchedCalls.count).toBe(0);

    const valid = createRstCapabilityAdmission({
      workflow: request.workflow,
      delivery: "patch-only",
      targetPaths: ["docs/guide.rst"],
      taskSha256: canonicalDigest(request.task),
      repositoryIdentitySha256: createHash("sha256")
        .update(request.repository.sourcePath)
        .digest("hex"),
      repositoryRevision: request.repository.revision,
      documentationRoots: ["docs/"],
      adapterConfigurationSha256: digest,
      adapterEligible: true,
    });
    if (!valid) throw new Error("test admission was not minted");

    const forgeries: Array<(record: Record<string, unknown>) => void> = [
      (record) => (record.schemaVersion = 2),
      (record) => (record.kind = "docsfab-rst-capability-admission-forged"),
      (record) => (record.contractVersion = "other-contract"),
      (record) => (record.configurationSha256 = "e".repeat(64)),
      (record) => ((record.adapter as Record<string, unknown>).id = "unknown"),
      (record) =>
        ((record.adapter as Record<string, unknown>).configurationSha256 = "f".repeat(64)),
      (record) => (record.admissionSha256 = "0".repeat(64)),
    ];
    const forgedCalls = { count: 0 };
    for (const forge of forgeries) {
      const forged = structuredClone(valid) as unknown as Record<string, unknown>;
      forge(forged);
      const failure = await new WorkflowRunner(
        runnerOptions(forgedCalls, { ...matchingOptions, rstCapabilityAdmission: forged }),
      )
        .run(request)
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "rst-capability-admission-required" });
    }
    expect(forgedCalls.count).toBe(0);
  });

  it("binds identity digests and leaves unbound Markdown outside RST admission", () => {
    const admission = createRstCapabilityAdmission({
      workflow: "update-documentation",
      delivery: "patch-only",
      targetPaths: ["docs/guide.rst"],
      taskSha256: digest,
      repositoryIdentitySha256: digest,
      repositoryRevision: "b".repeat(40),
      documentationRoots: ["docs/"],
      adapterConfigurationSha256: "c".repeat(64),
      adapterEligible: true,
    });
    expect(admission).toMatchObject({
      schemaVersion: 1,
      kind: "docsfab-rst-capability-admission",
      status: "admitted",
      workflow: "update-documentation",
      delivery: "patch-only",
      targetCount: 1,
      taskSha256: digest,
      repository: { identitySha256: digest, revision: "b".repeat(40) },
      adapter: { id: "sphinx", configurationSha256: "c".repeat(64) },
    });
    expect(admission?.admissionSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(admission?.admissionSha256).not.toBe(admission?.targetPathsSha256);
    expect(
      createRstCapabilityAdmission({
        workflow: "update-documentation",
        delivery: "default",
        targetPaths: ["docs/guide.md"],
        taskSha256: digest,
        repositoryIdentitySha256: digest,
        repositoryRevision: "b".repeat(40),
        documentationRoots: ["docs/"],
        adapterEligible: false,
      }),
    ).toBeUndefined();
  });
});
