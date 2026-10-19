// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { grantedTools } from "../src/harness/pi-tool-confine.js";
import {
  digest,
  parseHostRuntimeRequest,
  sealHostRuntimeComposition,
  sealHostRuntimeReaderEvidencePolicy,
  sealHostRuntimeReaderTask,
  sealHostRuntimeWriteAuthority,
} from "../src/host-invoker/contracts.js";
import { runHostedWorkflow } from "../src/host-invoker/workflow-runner.js";
import { readRunFailure } from "../src/operator/failure-classification.js";
import { PLAN_TARGET_NOT_NAMED_CODE } from "../src/workflow-execution/plan-binding.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { EditorialProtocolHarness } from "./helpers/editorial-protocol-harness.js";
import {
  git,
  observePublicContract,
  orbitOptionChangeRepository,
  orbitReaderContextInput,
} from "./helpers/orbit-option-change-fixture.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const roots: string[] = [];
const target = "docs/SKILL.md";
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function hosted(naming: "none" | "text" | "explicit" | "lookalike" | "legacy") {
  const fixture = await orbitOptionChangeRepository("docsfab-naming-hosted", roots, {
    files: { [target]: "# Agent guidance\n\nUse --old.\n" },
  });
  const workflow = getWorkflow("update-documentation");
  const declaredTools = [
    ...new Set(workflow.steps.flatMap((step) => grantedTools(step.mode, step.kind, step.search))),
  ].sort();
  const composition = sealHostRuntimeComposition({
    compositionId: "operator-naming-test",
    route: "offline-fixture",
    credentialFamily: "none",
    executionProfile: null,
    declaredTools,
  });
  const stepIds = workflow.steps.map((step) => step.id);
  const capsuleBody = {
    receiptSha256: "a".repeat(64),
    expiresAt: "2099-01-01T00:00:00.000Z",
    selectedEvidence: [
      { evidenceId: "repository-issue", content: `Update ${target} for the changed option.` },
    ],
  };
  const capsule = { ...capsuleBody, sha256: digest(capsuleBody) };
  const toolPolicySha256 = digest({ workflow: workflow.name, stepIds, declaredTools });
  const tree = await git(fixture.repository, "rev-parse", "HEAD^{tree}");
  const readerTask = sealHostRuntimeReaderTask({
    schemaVersion: 1,
    kind: "docsfab-reader-task-evidence",
    readerContextInput: {
      ...orbitReaderContextInput(),
      change_scope: naming === "explicit" ? [target] : ["docs/cli.md"],
    },
    inputOrigin: "conservative-fallback",
    ...(naming === "legacy"
      ? {}
      : {
          operatorInput: {
            requestText:
              naming === "lookalike"
                ? "Update docs/SKILL.md for the new option."
                : naming === "text"
                  ? `Update ${target} for the new option.`
                  : "Update the documentation for the new option.",
            targetPaths: naming === "explicit" ? [target] : ["docs/cli.md"],
          },
        }),
    requestText:
      naming === "text" || naming === "lookalike" || naming === "legacy"
        ? `Update ${target} for the new option.`
        : "Update the documentation for the new option.",
    comparison: { kind: "base-head", baseRevision: fixture.base, headRevision: fixture.head },
    sources: [
      { role: "changed-source", path: "src/orbit.ts" },
      { role: "public-contract", path: "src/orbit.ts" },
      { role: "current-documentation", path: target },
    ],
  });
  const readerEvidencePolicy = sealHostRuntimeReaderEvidencePolicy({
    workflow: "update-documentation",
    sourceRoles: ["public-contract", "changed-source", "current-documentation", "request"],
    pathCeiling: ["docs/", "src/"],
    maximumSourceNominations: 8,
  });
  const binding = {
    deploymentId: "naming-deployment",
    projectId: "naming-project",
    deploymentEpoch: "naming-epoch",
    requestKey: "naming-request",
    runId: "naming-hosted-run",
    fence: 1,
    workflow: "update-documentation" as const,
  };
  const authority = sealHostRuntimeWriteAuthority({
    schemaVersion: 2,
    kind: "docsfab-host-runtime-write-authority",
    ...binding,
    sourceRevision: fixture.head,
    sourceTreeObjectId: tree,
    pathCeiling: ["docs/"],
    // Intentionally overbroad: runtime admission must enforce naming even if
    // an older host granted a special file. Host minting has its own tests.
    targets: [
      {
        path: target,
        operations: ["modify"],
        preimageObjectId: await git(fixture.repository, "rev-parse", `HEAD:${target}`),
        fileMode: "100644",
      },
    ],
    writeStepIds: ["write-documentation"],
    capsuleSha256: capsule.sha256,
    compositionSha256: composition.compositionSha256,
    toolPolicySha256,
    expiresAt: capsule.expiresAt,
    limits: { maximumChangedPaths: 4, maximumPatchBytes: 64 * 1024 },
  });
  const content = "{}";
  const request = parseHostRuntimeRequest({
    schemaVersion: 1,
    kind: "docsfab-host-runtime-request",
    ...binding,
    origin: { principalId: "operator-naming-member", requestId: "operator-naming-origin" },
    revision: fixture.head,
    sourceTreeObjectId: tree,
    packet: {
      packetFingerprintSha256: "b".repeat(64),
      inputManifest: {
        kind: "input-manifest",
        content,
        sha256: createHash("sha256").update(content).digest("hex"),
        sourcePathSha256: "c".repeat(64),
        gitObjectId: "d".repeat(40),
      },
      canon: null,
      reviewEvent: null,
      readerTask: JSON.parse(JSON.stringify(readerTask)),
    },
    stepIds,
    toolPolicySha256,
    workspacePath: fixture.repository,
    stateDirectory: fixture.config.stateDirectory,
    capsule,
    composition,
    readerEvidencePolicy,
    allowWrite: true,
    writeAuthority: authority,
  });
  const harness = new EditorialProtocolHarness({
    candidate: "update",
    writePlannedPages: true,
    impactSource: await observePublicContract(fixture.repository, fixture.head),
    plannerPages: [{ path: target, disposition: "update" }],
  });
  const result = await runHostedWorkflow({
    request,
    credential: null,
    emit() {},
    executionHarness: harness,
  });
  return { result, harness };
}

describe("the shipped hosted UPDATE admission uses the submitted operator input", () => {
  it("ignores a capsule instruction and a reader-source nomination that name the target", {
    timeout: testTimeoutMs(90_000),
  }, async () => {
    const { result, harness } = await hosted("none");
    expect(readRunFailure(result.record)?.code, result.record.error).toBe(
      PLAN_TARGET_NOT_NAMED_CODE,
    );
    expect(harness.stepIds.at(-1)).toBe("plan-documentation");
    expect(result.patch).toBeNull();
  });
  it.each(["text", "explicit"] as const)(
    "delivers a file named by the submitted %s (control)",
    { timeout: testTimeoutMs(90_000) },
    async (naming) => {
      const { result } = await hosted(naming);
      expect(result.record.status, result.record.error).toBe("succeeded");
      expect(result.patchEvidence?.changes.map((change) => change.path)).toEqual([target]);
    },
  );
});

describe("hosted runner enforces raw naming across the wire", () => {
  it.each(["lookalike", "legacy"] as const)(
    "refuses a special target when normalized reader text names it but %s input does not",
    { timeout: testTimeoutMs(90_000) },
    async (naming) => {
      const { result, harness } = await hosted(naming);
      expect(readRunFailure(result.record)?.code, result.record.error).toBe(
        PLAN_TARGET_NOT_NAMED_CODE,
      );
      expect(harness.stepIds.at(-1)).toBe("plan-documentation");
      expect(result.patch).toBeNull();
    },
  );
});
