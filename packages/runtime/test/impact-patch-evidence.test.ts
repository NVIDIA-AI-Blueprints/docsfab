// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ChangeEvidence } from "../src/impact/contracts.js";
import {
  bindPersistedGitPatchEvidence,
  PatchEvidenceBindingError,
} from "../src/impact/patch-evidence.js";
import {
  createDecisionRecord,
  createHealingPlan,
  validateHealingPlan,
  type HealingPlan,
} from "../src/impact/contracts.js";
import { DEFAULT_HEALING_POLICY } from "../src/impact/policy.js";
import { GitPatchEvidenceCollector } from "../src/repository/evidence.js";

const REVISION = "a".repeat(40);
const REPOSITORY = {
  revision: REVISION,
  contentDigest: "b".repeat(64),
  indexDigest: "c".repeat(64),
};
const FINGERPRINT = "d".repeat(64);
const MATERIAL = "e".repeat(64);
const APPROVAL_REQUIREMENTS = DEFAULT_HEALING_POLICY.approvals;

let testRoot: string;
let workspace: string;
let collector: GitPatchEvidenceCollector;
let changes: ChangeEvidence;

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), "docsfab-impact-patch-binding-"));
  workspace = join(testRoot, "workspace");
  await mkdir(join(workspace, "docs"), { recursive: true });
  await writeFile(join(workspace, "docs/guide.md"), "[old](old.md)\n");
  collector = await GitPatchEvidenceCollector.create(workspace, join(testRoot, "evidence"));
  await writeFile(join(workspace, "docs/guide.md"), "[new](new.md)\n");
  changes = await collector.capture({
    runId: "impact-patch-binding",
    repository: {
      sourcePath: join(testRoot, "source"),
      requestedRevision: REVISION,
      revision: REVISION,
    },
    workspacePath: workspace,
    persistPatch: true,
  });
});

afterEach(async () => {
  await collector?.dispose().catch(() => undefined);
  await rm(testRoot, { recursive: true, force: true });
});

describe("persisted Git patch evidence binding", () => {
  it("binds exact durable patch bytes into a bounded HealingPlan task", async () => {
    const original = plan();
    const bound = await bindPersistedGitPatchEvidence({
      plan: original,
      taskIds: ["repair:link"],
      repositoryRevision: REVISION,
      changes,
    });

    expect(bound.taskGroups[0]!.tasks[0]!.patch).toEqual({
      sha256: changes.patch!.sha256,
      byteLength: changes.patch!.byteLength,
    });
    expect(bound.taskGroups[0]!.tasks[0]!.patch).not.toEqual(
      original.taskGroups[0]!.tasks[0]!.patch,
    );
    expect(validateHealingPlan(bound)).toEqual(bound);
    expect(JSON.stringify(bound)).not.toContain(changes.patch!.artifactPath);
  });

  it("rejects revision, changed-path, metadata, and durable-byte mismatches", async () => {
    await expect(
      bindPersistedGitPatchEvidence({
        plan: plan(),
        taskIds: ["repair:other"],
        repositoryRevision: REVISION,
        changes,
      }),
    ).rejects.toEqual(new PatchEvidenceBindingError("invalid-task", "$.taskIds"));

    await expect(
      bindPersistedGitPatchEvidence({
        plan: plan(),
        taskIds: ["repair:link"],
        repositoryRevision: "f".repeat(40),
        changes,
      }),
    ).rejects.toEqual(new PatchEvidenceBindingError("repository-mismatch", "$.repositoryRevision"));

    await expect(
      bindPersistedGitPatchEvidence({
        plan: plan(),
        taskIds: ["repair:link"],
        repositoryRevision: REVISION,
        changes: { ...changes, files: [{ path: "docs/other.md", status: "modified" }] },
      }),
    ).rejects.toEqual(new PatchEvidenceBindingError("path-mismatch", "$.changes.files"));

    const tamperedMetadata = structuredClone(changes);
    tamperedMetadata.patch!.sha256 = "f".repeat(64);
    await expect(
      bindPersistedGitPatchEvidence({
        plan: plan(),
        taskIds: ["repair:link"],
        repositoryRevision: REVISION,
        changes: tamperedMetadata,
      }),
    ).rejects.toEqual(
      new PatchEvidenceBindingError("patch-mismatch", "$.changes.patch.artifactPath"),
    );

    await writeFile(changes.patch!.artifactPath, "tampered patch\n");
    await expect(
      bindPersistedGitPatchEvidence({
        plan: plan(),
        taskIds: ["repair:link"],
        repositoryRevision: REVISION,
        changes,
      }),
    ).rejects.toEqual(
      new PatchEvidenceBindingError("patch-mismatch", "$.changes.patch.artifactPath"),
    );
  });
});

function plan(): HealingPlan {
  const decision = createDecisionRecord({
    schemaVersion: 1,
    repository: REPOSITORY,
    proposalFingerprint: FINGERPRINT,
    disposition: "approved",
    decidedBy: "maintainer:docs",
    decidedAt: "2026-08-03T12:00:00.000Z",
    evidenceDigest: "1".repeat(64),
    materialEvidenceDigest: MATERIAL,
    cooldownUntil: "2026-08-10T12:00:00.000Z",
  });
  return createHealingPlan({
    schemaVersion: 1,
    repository: REPOSITORY,
    impactDigest: "2".repeat(64),
    policy: DEFAULT_HEALING_POLICY,
    approvalRequirements: { ...APPROVAL_REQUIREMENTS },
    decisions: [decision],
    taskGroups: [
      {
        owner: "team:docs",
        source: "docs/guide.md",
        section: "section:docs/guide.md#links",
        affectedOutput: "docs/guide.md",
        tasks: [
          {
            id: "repair:link",
            proposalFingerprint: FINGERPRINT,
            materialEvidenceDigest: MATERIAL,
            level: "bounded-repair",
            requiredApproval: "maintainer",
            action: "link-repair",
            targetNodeIds: ["document:docs/guide.md"],
            outputPaths: ["docs/guide.md"],
            evidenceDigests: [MATERIAL],
            patch: { sha256: createHash("sha256").update("unbound").digest("hex"), byteLength: 7 },
          },
        ],
      },
    ],
    moves: [],
    delivery: "patch-only",
  });
}
