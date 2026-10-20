// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Synthetic model edge with real Git, skill locks and closed request constructors. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  digest,
  parseHostRuntimeRequest,
  sealHostRuntimeComposition,
  type HostRuntimeRequestV1,
} from "../../src/host-invoker/contracts.js";
import { inspectHostedWorkflowCatalog } from "../../src/host-invoker/workflow-catalog.js";
import {
  sourceReadinessBinding,
  SOURCE_READINESS_ASSESSMENT_KIND,
} from "../../src/readiness/assessment.js";
import { verifyCatalogSkill } from "../../src/skills/catalog-crate.js";
import { FILESYSTEM_READ_ONLY_TOOLS } from "../../src/harness/pi-tool-confine.js";
import type { AgentHarness, HarnessStepInput } from "../../src/execution/contracts.js";
const exec = promisify(execFile);
export const projectConfig = {
  schemaVersion: 1,
  gitlab: { remote: "origin", defaultBranch: "stable" },
  provider: { configuration: "host" },
  storage: { scope: "user-private" },
};
export async function createReadinessFixture(withConfig = true) {
  const root = await mkdtemp(join(tmpdir(), "docsfab-hosted-readiness-"));
  const repository = join(root, "repo"),
    state = join(root, "state");
  await mkdir(join(repository, "docs"), { recursive: true });
  await writeFile(join(repository, "README.md"), "# Product\n\n[Install](docs/install.md)\n");
  await writeFile(
    join(repository, "docs/install.md"),
    "# Install\n\nInstall the supported package.\n",
  );
  if (withConfig) await writeFile(join(repository, ".docsfab.json"), JSON.stringify(projectConfig));
  const git = async (...args: string[]) =>
    (
      await exec("git", ["-C", repository, ...args], {
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      })
    ).stdout.trim();
  await git("init", "-q");
  await git("config", "user.name", "DocsFab Test");
  await git("config", "user.email", "test@example.invalid");
  await git("config", "commit.gpgsign", "false");
  await git("add", ".");
  await git("commit", "-qm", "source fixture");
  return {
    root,
    repository,
    state,
    git,
    revision: await git("rev-parse", "HEAD"),
    tree: await git("rev-parse", "HEAD^{tree}"),
  };
}
export function readinessRequest(
  f: Awaited<ReturnType<typeof createReadinessFixture>>,
  workflow: "readiness" | "release-documentation-readiness",
): HostRuntimeRequestV1 {
  const catalog = inspectHostedWorkflowCatalog(workflow);
  const content = '{"schemaVersion":1,"kind":"fixture-input"}\n';
  const composition = sealHostRuntimeComposition({
    compositionId: "readiness-model-edge-fixture",
    route: "offline-fixture",
    credentialFamily: "none",
    executionProfile: null,
    declaredTools: catalog.declaredTools,
  });
  const capsule = {
    receiptSha256: "d".repeat(64),
    expiresAt: "2099-01-01T00:00:00.000Z",
    selectedEvidence: [
      {
        evidenceId: "approved-context",
        content: "Assess the bound repository; no release decision is supplied.",
      },
    ],
  };
  return parseHostRuntimeRequest({
    schemaVersion: 1,
    kind: "docsfab-host-runtime-request",
    deploymentId: "fixture",
    projectId: "readiness-project",
    deploymentEpoch: "epoch-one",
    requestKey: "readiness-request",
    origin: { principalId: "fixture-user", requestId: "request-origin" },
    runId: `run-${workflow}`,
    fence: 1,
    workflow,
    revision: f.revision,
    sourceTreeObjectId: f.tree,
    packet: {
      packetFingerprintSha256: "e".repeat(64),
      inputManifest: {
        kind: "input-manifest",
        sha256: createHash("sha256").update(content).digest("hex"),
        sourcePathSha256: digest("fixture-input"),
        gitObjectId: "b".repeat(40),
        content,
      },
      canon: null,
      reviewEvent: null,
    },
    stepIds: catalog.stepIds,
    toolPolicySha256: digest({
      workflow,
      stepIds: catalog.stepIds,
      declaredTools: catalog.declaredTools,
    }),
    workspacePath: f.repository,
    stateDirectory: f.state,
    capsule: { ...capsule, sha256: digest(capsule) },
    composition,
    allowWrite: false,
  });
}
export function readinessModelEdge(calls: HarnessStepInput[]): AgentHarness {
  const inspectSkill = async (input: HarnessStepInput) =>
    (
      await verifyCatalogSkill({
        skillCrateDirectory: resolve(import.meta.dirname, "../../skill-crate"),
        skillId: input.step.skill,
        grantedTools: FILESYSTEM_READ_ONLY_TOOLS,
      })
    ).evidence;
  return {
    inspectSkill,
    async runStep(input) {
      calls.push(input);
      assert.equal(input.step.mode, "read-only");
      assert.equal(input.step.skill, "assess-documentation-readiness");
      // Only the model edge is synthetic, including the read ledger a real
      // confined read would record. Search, minted quotes, skill lock,
      // response admission, outcome projection, and retained records are real.
      return {
        summary:
          input.workflow.name === "readiness"
            ? JSON.stringify({
                schemaVersion: 1,
                kind: SOURCE_READINESS_ASSESSMENT_KIND,
                ...sourceReadinessBinding(input),
                summary:
                  "The requested input fixture provides its installation source and navigation.",
                criteria: [
                  {
                    criterionId: "source-completeness",
                    status: "met",
                    reason: "The declared fixture scope supplies installation instructions.",
                    citations: [{ path: "docs/install.md", startLine: 3, endLine: 3 }],
                  },
                  {
                    criterionId: "source-usability",
                    status: "met",
                    reason: "The repository entrypoint links the instructions.",
                    citations: [{ path: "README.md", startLine: 3, endLine: 3 }],
                  },
                ],
              })
            : "All documentation is ready to release.",
        skill: await inspectSkill(input),
        model: {
          provider: "offline-fixture",
          model: sealHostRuntimeComposition({
            compositionId: "readiness-model-edge-fixture",
            route: "offline-fixture",
            credentialFamily: "none",
            executionProfile: null,
            declaredTools: inspectHostedWorkflowCatalog(input.workflow.name).declaredTools,
          }).compositionSha256.slice(0, 16),
        },
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
        tools: { totalCalls: 0, failedCalls: 0, byTool: [], failureCategories: [] },
        observedSourceLines: { "README.md": [[1, 3]], "docs/install.md": [[1, 3]] },
      };
    },
  };
}
