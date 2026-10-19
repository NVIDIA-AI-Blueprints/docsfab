// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  importFoundationCanonFromKnowledgeSnapshot,
  type FoundationCanonV1,
} from "../src/canon/index.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import type {
  AgentHarness,
  HarnessStepInput,
  HostOperationExecutor,
} from "../src/execution/contracts.js";
import type { ContextPreflightService } from "../src/context/contracts.js";
import type { RepositorySecurityScanner } from "../src/security/contracts.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import type { FoundationInspectResultV1 } from "../src/foundation/index.js";
import { readCatalogSkillCrateLock, verifyCatalogSkill } from "../src/skills/catalog-crate.js";
import {
  createFoundationToPatchAuthorization,
  FoundationToPatchHostOperation,
  FoundationToPatchWorkflowOutcomeProjector,
  FOUNDATION_TO_PATCH_SKILLS,
  type FoundationToPatchRunResultV1,
} from "../src/foundation/to-patch.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { GitPatchEvidenceCollector } from "../src/repository/evidence.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import type { RepositoryWorkspace } from "../src/repository/workspace/contracts.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillCrateDirectory = resolve(projectRoot, "skill-crate");
const acceptedSnapshotPath = resolve(
  projectRoot,
  "test/fixtures/runtime-evaluation/fixtures/knowledge-accepted-snapshot.json",
);

const CANON_SHA256 = "d9fa679a1df1abf7b3f9ee8a9f44a8647dabb6306bed3f4a05ab8f7a7d10a727";
// Taken from the regenerated `skill-crate/lock.json`, which is the generated
// source of truth for this bundle. Editing a canonical skill reference is what
// moves it; the source-evidence reference is part of this literal witness.
const VERIFICATION_PACK_BUNDLE_SHA256 =
  "23dbf5e63a55585d260d2be672a12ec918889279fb2ba2587d2b50a82f5a9dc7";
const exec = promisify(execFile);
const NOW = "2026-08-19T12:00:00.000Z";
const EXPIRES = "2026-08-20T12:00:00.000Z";
const READ_ONLY = ["read", "grep", "find", "ls"] as const;

class MemoryStore implements RunStore {
  public records: RunRecord[] = [];

  public async save(record: RunRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}

class RejectingOfflineHarness implements AgentHarness {
  public calls = 0;

  public async runStep(): Promise<never> {
    this.calls += 1;
    throw new Error("The package-compose golden must not invoke a live model harness.");
  }
}

class PackageComposeHostOperation implements HostOperationExecutor {
  public result: FoundationToPatchRunResultV1 | undefined;

  public constructor(
    private readonly foundation: FoundationToPatchHostOperation,
    private readonly packBundleSha256: string,
  ) {}

  public async runStep(input: HarnessStepInput) {
    const step = await this.foundation.runStep(input);
    this.result = step.foundationToPatch;
    return {
      ...step,
      summary: `${step.summary} pack-bundle=${this.packBundleSha256}`,
    };
  }
}

const passedScanner: RepositorySecurityScanner = {
  scan: async () => ({
    ruleSet: "package-compose-golden-v1",
    status: "passed",
    scannedFiles: 1,
    binaryFiles: 0,
    findings: [],
  }),
};

const offlineContextPreflight: ContextPreflightService = {
  preflight: async () => ({
    status: "unnecessary",
    reason: "target-not-applicable",
  }),
};

describe("package compose golden journey (#46)", () => {
  it("binds accepted canon, a locked catalog skill, and an offline harness in one run record", async () => {
    const snapshotBefore = await readFile(acceptedSnapshotPath);
    const canon = importFoundationCanonFromKnowledgeSnapshot(
      JSON.parse(snapshotBefore.toString("utf8")) as unknown,
    );
    expect(canon.canonSha256).toBe(CANON_SHA256);

    const lock = await readCatalogSkillCrateLock(skillCrateDirectory);
    const lockedSkill = lock.skills.find((skill) => skill.id === "verify-technical-accuracy");
    expect(lockedSkill?.bundleSha256).toBe(VERIFICATION_PACK_BUNDLE_SHA256);

    const verifiedSkill = await verifyCatalogSkill({
      skillCrateDirectory,
      skillId: "verify-technical-accuracy",
      grantedTools: READ_ONLY,
    });
    expect(verifiedSkill.evidence).toMatchObject({
      id: "verify-technical-accuracy",
      contentSha256: lockedSkill?.contentSha256,
      bundleSha256: VERIFICATION_PACK_BUNDLE_SHA256,
    });

    const root = await mkdtemp(join(tmpdir(), "docsfab-package-compose-"));
    const sourcePath = join(root, "source");
    const originalGuide = "# Guide\n\nOriginal accepted guidance.\n";
    const candidateGuide = "# Guide\n\nUpdated evidence-backed guidance.\n";
    let workspace: RepositoryWorkspace | undefined;
    let collector: GitPatchEvidenceCollector | undefined;
    const git = async (...args: string[]) =>
      (
        await exec(
          "/usr/bin/git",
          [
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-C",
            sourcePath,
            ...args,
          ],
          {
            env: {
              PATH: process.env.PATH,
              HOME: "/dev/null",
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_TERMINAL_PROMPT: "0",
            },
          },
        )
      ).stdout.trim();
    try {
      await mkdir(join(sourcePath, "docs"), { recursive: true });
      await writeFile(join(sourcePath, "docs/guide.md"), originalGuide);
      await writeFile(join(sourcePath, "accepted-canon.json"), snapshotBefore);
      await git("init", "--quiet");
      await git("config", "user.name", "Package compose fixture");
      await git("config", "user.email", "fixture@example.invalid");
      await git("add", ".");
      await git("commit", "--quiet", "-m", "Accepted source fixture");
      const revision = await git("rev-parse", "HEAD");
      const sourceTree = await git("rev-parse", "HEAD^{tree}");
      workspace = await prepareRepositoryWorkspace(sourcePath, revision);
      const candidatePath = workspace.path;
      const repository = { sourcePath, requestedRevision: revision, revision };
      collector = await GitPatchEvidenceCollector.create(candidatePath, join(root, "patches"));
      const patchCollector = collector;

      const authorization = createFoundationToPatchAuthorization({
        intendedPaths: ["docs/guide.md"],
        decidedAt: NOW,
        expiresAt: EXPIRES,
        seed: "package-compose-golden",
      });
      const foundation = new FoundationToPatchHostOperation({
        runInput: {
          // The selected source remains immutable; controlled authoring writes
          // only its separate tracked export and captures the real Git diff.
          repositoryPath: sourcePath,
          allowWrite: true,
          now: NOW,
          inspect: readyInspect(canon),
          authorization,
          planStep: () => ({
            schemaVersion: 1,
            kind: "docsfab-foundation-to-patch-plan",
            skillId: FOUNDATION_TO_PATCH_SKILLS.plan,
            status: "ready",
            planSha256: canonicalDigest({ canonSha256: canon.canonSha256, stage: "plan" }),
            intendedPaths: ["docs/guide.md"],
          }),
          draftStep: async () => {
            await writeFile(join(candidatePath, "docs/guide.md"), candidateGuide);
            return {
              schemaVersion: 1,
              kind: "docsfab-foundation-to-patch-candidate",
              skillId: FOUNDATION_TO_PATCH_SKILLS.draft,
              candidateSha256: canonicalDigest({
                canonSha256: canon.canonSha256,
                content: candidateGuide,
              }),
              changedPaths: ["docs/guide.md"],
            };
          },
          patchStep: async () => {
            const captured = await patchCollector.capture({
              runId: "package-compose-golden-1",
              repository,
              workspacePath: candidatePath,
              persistPatch: true,
            });
            expect(captured.files).toEqual([{ path: "docs/guide.md", status: "modified" }]);
            expect(captured.patch!.byteLength).toBeGreaterThan(0);
            return {
              schemaVersion: 1,
              kind: "docsfab-foundation-to-patch-patch",
              patchSha256: captured.patch!.sha256,
              byteLength: captured.patch!.byteLength,
              changedPaths: captured.files.map((file) => file.path),
            };
          },
        },
      });
      const hostOperation = new PackageComposeHostOperation(
        foundation,
        verifiedSkill.evidence.bundleSha256!,
      );
      const harness = new RejectingOfflineHarness();
      const store = new MemoryStore();
      const runner = new WorkflowRunner({
        harness,
        hostOperations: hostOperation,
        outcomeProjector: new FoundationToPatchWorkflowOutcomeProjector(),
        store,
        repositoryScanner: passedScanner,
        contextPreflight: offlineContextPreflight,
        repositoryEvidence: patchCollector,
        id: () => "package-compose-golden-1",
        now: () => new Date(NOW),
      });

      const request = {
        workflow: "foundation-to-patch" as const,
        workspacePath: candidatePath,
        repository,
        task: {
          kind: "foundation-to-patch" as const,
          intendedPaths: ["docs/guide.md"],
          canonSha256: canon.canonSha256,
        },
        allowWrite: true,
      };
      // Denied runner write admission must precede the host operation and edits.
      await expect(runner.run({ ...request, allowWrite: false })).rejects.toThrow(
        'Workflow "foundation-to-patch" can modify files.',
      );
      expect(hostOperation.result).toBeUndefined();
      expect(await readFile(join(candidatePath, "docs/guide.md"), "utf8")).toBe(originalGuide);
      const record = await runner.run(request);

      expect(harness.calls).toBe(0);
      expect(record.status, record.error).toBe("succeeded");
      expect(record.workflowOutcome?.disposition).toBe("ready");
      expect(record.task).toMatchObject({
        kind: "foundation-to-patch",
        canonSha256: CANON_SHA256,
      });
      expect(record.steps[0]?.summary).toContain(`pack-bundle=${VERIFICATION_PACK_BUNDLE_SHA256}`);
      expect(hostOperation.result?.checkpoint.canonSha256).toBe(CANON_SHA256);
      expect(hostOperation.result?.sourceCheckoutUnchanged).toBe(true);
      expect(store.records.at(-1)?.task).toEqual(record.task);
      expect(await readFile(acceptedSnapshotPath)).toEqual(snapshotBefore);
      expect(record.steps[0]?.mode).toBe("write");
      expect(record.changes?.files).toEqual([{ path: "docs/guide.md", status: "modified" }]);
      const patch = await readFile(record.changes!.patch!.artifactPath);
      expect(patch.byteLength).toBeGreaterThan(0);
      expect(createHash("sha256").update(patch).digest("hex")).toBe(record.changes!.patch!.sha256);
      expect(hostOperation.result?.checkpoint.patch?.patchSha256).toBe(
        record.changes!.patch!.sha256,
      );
      expect(hostOperation.result?.checkpoint.patch?.byteLength).toBe(patch.byteLength);
      expect(patch.toString("utf8")).toContain("-Original accepted guidance.");
      expect(patch.toString("utf8")).toContain("+Updated evidence-backed guidance.");
      expect(store.records.at(-1)?.changes).toEqual(record.changes);
      expect(await readFile(join(sourcePath, "docs/guide.md"), "utf8")).toBe(originalGuide);
      expect(await readFile(join(sourcePath, "accepted-canon.json"))).toEqual(snapshotBefore);
      expect(await git("status", "--porcelain")).toBe("");
      expect(await git("rev-parse", "HEAD^{tree}")).toBe(sourceTree);
    } finally {
      await collector?.dispose();
      await workspace?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function readyInspect(canon: FoundationCanonV1): FoundationInspectResultV1 {
  const body: Omit<FoundationInspectResultV1, "resultSha256"> = {
    schemaVersion: 1,
    kind: "docsfab-foundation-inspect-result",
    readiness: "ready",
    productDisposition: "ready",
    canon,
    summary: {
      canonId: canon.canonId,
      version: canon.version,
      state: canon.state,
      claimCount: canon.claims.length,
      evidenceCount: canon.evidence.length,
      conflictCount: canon.conflicts.length,
      instructionPresent: false,
      documentCount: 0,
    },
    conflicts: canon.conflicts.map((conflict) => ({
      id: conflict.id,
      claimIds: conflict.claimIds,
    })),
    missingFacts: [],
    nextQuestions: [],
    evidenceLimitations: [],
    artifactReferences: [{ role: "candidate-canon", canonSha256: canon.canonSha256 }],
    guarantees: {
      writeToolsGranted: false,
      hostMutation: false,
      allowWriteRequired: false,
    },
  };
  return { ...body, resultSha256: canonicalDigest(body) };
}
