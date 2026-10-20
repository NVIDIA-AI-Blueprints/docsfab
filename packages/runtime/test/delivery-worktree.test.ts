// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChangedFileEvidence } from "../src/impact/contracts.js";
import {
  DeliveryWorktreeError,
  ExecFileDeliveryCommandRunner,
  FileScmDeliveryReceiptStore,
  archiveDeliveryWorktree,
  buildDocsFabPublicationMetadata,
  assertDeliveryWorktreeReadyAttestation,
  authorizeDeliveryDiscard,
  authorizeLocalUserPublication,
  authorizePublishedDeliveryCleanup,
  cleanupDeliveryWorktree,
  canonicalMergeRequestUrl,
  confirmScmDeliveryObservation,
  createScmDeliveryRecord,
  deterministicLocalUserSourceBranch,
  issueScmPublishedTerminalCapability,
  inspectReadyDeliveryWorktree,
  localUserGitIdentitySha256,
  localUserPublicationPlanSha256,
  loadVerifiedPublicationRun,
  LocalUserPublicationPreflightError,
  prepareDeliveryWorktree,
  publishLocalUserGitLab,
  recordScmDeliveryProgress,
  runLocalUserPublishExecuteCli,
  scmDeliveryIdempotencyKey,
  NestedSandboxIsolationError,
  nestedExecuteHostMustStayConfined,
  selectDocumentationValidationProfile,
  validationIsolationCandidates,
  type DeliveryCommandRunner,
  type DeliveryCommandResult,
  type DeliveryValidationIsolationRequest,
  type DeliveryWorktreeCapability,
  type DeliveryWorktreeReadyAttestation,
  type LocalUserPublicationPlan,
  type LocalUserPublicationPlanV2,
  type ScmDeliveryRecord,
  type ScmDeliveryReceiptStore,
  type LocalGitPublisher,
  type GitLabMergeRequest,
  type GitLabPublisherAdapter,
  DOCUMENTATION_VALIDATION_ENTRYPOINT_COMMAND,
  ExecFileReadOnlyCommandRunner,
  preflightLocalUserGitLabPublication,
  type ReadOnlyCommandResult,
  type ReadOnlyCommandRunner,
  DeterministicLocalGitPublisher,
  ExecFileGitPublisherCommandRunner,
  resolveLocalUserGitIdentity,
  type GitPublisherCommandResult,
  type GitPublisherCommandRunner,
} from "../src/delivery/index.js";
import {
  documentationCandidateInputTreeSha256,
  documentationRepositoryIdentitySha256,
  withDocumentationValidationCandidate,
} from "../src/delivery/documentation-validation-candidate.js";
import {
  selectHostValidationBackendIdentity,
  validationBackendPolicySha256,
} from "../src/delivery/worktree/validation-backend.js";
import { DurableArtifactStore } from "../src/artifacts/store.js";
import {
  GIT_CONFIGURATION_LIST_ARGS,
  HOST_GIT_CONFIG_FLAGS,
} from "../src/delivery/git-config-policy.js";
import { gitEnvironment } from "../src/delivery/git-environment.js";
import { DELIVERY_ACTIONS } from "../src/operator/situation-catalog.js";
import { containsConfiguredCredential } from "../src/security/configured-credentials.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";
import {
  deriveDocumentationSourceApplicability,
  storeDocumentationSourceApplicability,
} from "../src/repository/documentation-source-applicability.js";

const exec = promisify(execFile);
/** Git worktree / bwrap suites need headroom under parallel Vitest workers. */
const HEAVY_SUITE_TIMEOUT_MS = 180_000;
const temporaryDirectories: string[] = [];
const deliveryValidationFailureFixtureRoot = join(
  process.cwd(),
  "test",
  "fixtures",
  "delivery-validation-failure",
);
const invalidLinkTarget = "./fixture-private-target-769.md";

interface Fixture {
  root: string;
  source: string;
  deliveryRoot: string;
  recordPath: string;
  patchPath: string;
  revision: string;
  plan: LocalUserPublicationPlan;
  authorization: ReturnType<typeof authorizeLocalUserPublication>;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("governed delivery worktree", { timeout: HEAVY_SUITE_TIMEOUT_MS }, () => {
  it.each([
    [
      "text modification",
      async (writer: string) => {
        await writeFile(join(writer, "README.md"), "changed\n");
      },
      [{ path: "README.md", status: "modified" }],
    ],
    [
      "binary addition",
      async (writer: string) => {
        await writeFile(join(writer, "asset.bin"), Buffer.from([0, 255, 1, 254, 2]));
      },
      [{ path: "asset.bin", status: "added" }],
    ],
    [
      "rename",
      async (writer: string) => {
        await git(writer, "mv", "rename.txt", "renamed.txt");
      },
      [
        {
          path: "renamed.txt",
          previousPath: "rename.txt",
          status: "renamed",
        },
      ],
    ],
    [
      "copy",
      async (writer: string) => {
        await writeFile(join(writer, "copied.txt"), await readFile(join(writer, "copy.txt")));
      },
      [{ path: "copied.txt", previousPath: "copy.txt", status: "copied" }],
    ],
    [
      "delete",
      async (writer: string) => {
        await rm(join(writer, "delete.txt"));
      },
      [{ path: "delete.txt", status: "deleted" }],
    ],
    [
      "empty-file addition",
      async (writer: string) => {
        await writeFile(join(writer, "empty.txt"), "");
      },
      [{ path: "empty.txt", status: "added" }],
    ],
    [
      "executable addition",
      async (writer: string) => {
        await writeFile(join(writer, "tool.sh"), "#!/bin/sh\nexit 0\n");
        await chmod(join(writer, "tool.sh"), 0o755);
      },
      [{ path: "tool.sh", status: "added" }],
    ],
    [
      "symlink addition",
      async (writer: string) => {
        await symlink("README.md", join(writer, "readme-link"));
      },
      [{ path: "readme-link", status: "added" }],
    ],
  ] as const)(
    "materializes and validates a %s patch from the exact base",
    async (_label, change, files) => {
      const fixture = await createFixture(change, [...files]);
      const sourceBefore = await completeSourceSnapshot(fixture.source);
      const result = await prepare(fixture);
      expect(result.status, result.status === "failed" ? result.code : undefined).toBe("ready");
      expect(result.worktree.baseRevision).toBe(fixture.revision);
      expect(await gitText(result.worktree.worktreePath, "rev-parse", "HEAD")).toBe(
        fixture.revision,
      );
      expect(await gitText(result.worktree.worktreePath, "branch", "--show-current")).toBe(
        fixture.plan.proposedSourceBranch,
      );
      expect(await completeSourceSnapshot(fixture.source)).toBe(sourceBefore);
      expect((await stat(result.worktree.patchPath)).mode & 0o077).toBe(0);
    },
  );

  it("preserves executable modes and symlink targets during host materialization", async () => {
    const fixture = await createFixture(
      async (writer) => {
        await writeFile(join(writer, "tool.sh"), "#!/bin/sh\nexit 0\n");
        await chmod(join(writer, "tool.sh"), 0o755);
        await symlink("tool.sh", join(writer, "tool-link"));
      },
      [
        { path: "tool-link", status: "added" },
        { path: "tool.sh", status: "added" },
      ],
    );
    const result = await prepare(fixture);
    expect(result.status).toBe("ready");
    expect((await lstat(join(result.worktree.worktreePath, "tool.sh"))).mode & 0o111).toBe(0o111);
    expect(await readlink(join(result.worktree.worktreePath, "tool-link"))).toBe("tool.sh");
  });

  it("materializes nested directories with the intended mode under umask 077", async () => {
    const fixture = await createFixture(
      async (writer) => {
        await mkdir(join(writer, "docs"));
        await writeFile(join(writer, "docs", "guide.md"), "nested\n");
      },
      [{ path: "docs/guide.md", status: "added" }],
    );
    const previous = process.umask(0o077);
    try {
      const result = await prepare(fixture);
      expect(result.status, result.status === "failed" ? result.code : undefined).toBe("ready");
      expect((await lstat(join(result.worktree.worktreePath, "docs"))).mode & 0o777).toBe(0o755);
    } finally {
      process.umask(previous);
    }
  });

  it("records built-in profile identity on the ready attestation", async () => {
    const fixture = await createFixture(
      async (writer) => {
        await writeFile(join(writer, "README.md"), "profiled\n");
      },
      [{ path: "README.md", status: "modified" }],
      { validationCommand: "test -d ." },
    );
    const selected = await upgradeFixtureToSourceAwareV2(fixture, [
      { path: "README.md", status: "modified" },
    ]);
    const result = await prepare(fixture);
    expect(result.status, result.status === "failed" ? result.code : undefined).toBe("ready");
    const attestation = await inspectReadyDeliveryWorktree(result.worktree);
    expect(attestation.validation.commandSha256).toBe(
      createHash("sha256").update(selected.entrypointCommand).digest("hex"),
    );
    expect(attestation.validation.profileId).toBe("docsfab-documentation-validation");
    expect(attestation.validation.checkIds).toEqual(selected.binding.checkIds);
    expect(attestation.validation.validatorIdentity).toBe("docsfab-documentation-validator");
    expect(attestation.validation.checkSetSha256).toBe(selected.binding.checkSetSha256);
    expect(attestation.validation.applicabilitySha256).toBe(selected.binding.applicabilitySha256);
    expect(attestation.validation.candidateTreeSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(attestation.validation.resultSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(attestation.validation.results).toEqual(
      selected.binding.checkIds.map((id) => ({ id, status: "passed" })),
    );
    expect(JSON.stringify(attestation.validation)).not.toContain(fixture.source);
    expect(JSON.stringify(attestation.validation)).not.toContain("docsfab test");
    await expect(
      assertDeliveryWorktreeReadyAttestation(attestation, result.worktree),
    ).resolves.toBeUndefined();
  });

  it("returns bounded typed evidence when ready-worktree inspection rejects an invalid link", async () => {
    const fixture = await createFixture(
      async (writer) => {
        await cp(join(deliveryValidationFailureFixtureRoot, "candidate"), writer, {
          recursive: true,
        });
      },
      [{ path: "README.md", status: "modified" }],
      {
        validationCommand: "test -d .",
        extraValidationScript: async (source) => {
          await cp(join(deliveryValidationFailureFixtureRoot, "base"), source, {
            recursive: true,
          });
        },
      },
    );
    const selected = await upgradeFixtureToSourceAwareV2(fixture, [
      { path: "README.md", status: "modified" },
    ]);
    const receiptRoot = join(fixture.root, "receipts");
    const patchBeforeDelivery = await readFile(fixture.patchPath);
    const logs: string[] = [];
    let postValidationCalls = 0;
    let preflights = 0;
    const invoke = () =>
      runLocalUserPublishExecuteCli(
        [
          fixture.plan.run.id,
          "--repo",
          fixture.source,
          "--draft-mr",
          "--execute",
          "--confirm-plan-sha256",
          fixture.plan.sha256,
          "--delivery-root",
          fixture.deliveryRoot,
          "--receipt-root",
          receiptRoot,
          "--state-dir",
          dirname(fixture.recordPath),
        ],
        {
          cwd: fixture.root,
          stateDirectory: dirname(fixture.recordPath),
          log: (message) => logs.push(message),
          preflight: async () => {
            preflights += 1;
            return fixture.plan;
          },
          deliveryCommands: new ExecFileDeliveryCommandRunner(),
          isolateValidation: async () => ({ commandPrefix: ["env"] }),
          loadRun: async () => {
            postValidationCalls += 1;
            throw new Error("publication must not follow failed validation");
          },
        },
      );
    const rejected = await invoke().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejected).toBeInstanceOf(DeliveryWorktreeError);
    if (!(rejected instanceof DeliveryWorktreeError)) return;
    expect(rejected.code).toBe("validation-failed");
    expect(rejected.validation).toMatchObject({
      reasonCode: "validation-check-failed",
      planSha256: fixture.plan.sha256,
      runId: fixture.plan.run.id,
      runRecordSha256: fixture.plan.run.recordSha256,
      patchSha256: fixture.plan.patch.sha256,
      workspaceKey: expect.stringMatching(/^[a-f0-9]{64}$/u),
      commandSha256: createHash("sha256").update(selected.entrypointCommand).digest("hex"),
      profileId: selected.binding.profileId,
      profileVersion: selected.binding.profileVersion,
      checkIds: [...selected.binding.checkIds],
      selectorInputSha256: selected.binding.selectorInputSha256,
      validatorIdentity: selected.binding.validatorIdentity,
      candidateTreeSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      checkSetSha256: selected.binding.checkSetSha256,
      applicabilitySha256: selected.binding.applicabilitySha256,
      ...(selectHostValidationBackendIdentity(process.platform)
        ? { backendIdentity: selectHostValidationBackendIdentity(process.platform) }
        : {}),
      results: [{ id: "documentation-relative-links", status: "failed" }],
    });
    expect(postValidationCalls).toBe(0);
    const projected = JSON.parse(logs.at(-1)!);
    expect(projected).toMatchObject({
      status: "failed",
      planSha256: fixture.plan.sha256,
      runId: fixture.plan.run.id,
      runRecordSha256: fixture.plan.run.recordSha256,
      patchSha256: fixture.plan.patch.sha256,
      state: "prepared",
      disposition: "failed",
      failurePersistence: "stored",
      validationFailure: rejected.validation,
    });
    const receipt = await new FileScmDeliveryReceiptStore(receiptRoot).load(
      scmDeliveryIdempotencyKey(fixture.plan),
    );
    expect(receipt).toMatchObject({
      state: "prepared",
      disposition: "failed",
      run: fixture.plan.run,
      planSha256: fixture.plan.sha256,
      patch: { sha256: fixture.plan.patch.sha256, preserved: true },
      failure: { code: "validation-failed", validation: rejected.validation },
    });
    expect(receipt?.failure?.validation?.workspaceKey).toBe(
      receipt?.evidence.prepared?.workspaceKey,
    );

    const retryRejected = await invoke().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(retryRejected).toBeInstanceOf(DeliveryWorktreeError);
    expect(retryRejected).toMatchObject({
      code: "validation-failed",
      validation: { applicabilitySha256: selected.binding.applicabilitySha256 },
    });
    const retriedReceipt = await new FileScmDeliveryReceiptStore(receiptRoot).load(
      scmDeliveryIdempotencyKey(fixture.plan),
    );
    expect(retriedReceipt).toMatchObject({
      state: "prepared",
      disposition: "failed",
      failure: {
        code: "validation-failed",
        validation: { applicabilitySha256: selected.binding.applicabilitySha256 },
      },
    });
    // The same retained worktree produces identical failure evidence. Preserve
    // the original attempt instead of appending a duplicate host failure.
    expect(retriedReceipt?.attempts).toEqual(receipt!.attempts);
    expect(preflights).toBe(1);
    expect(await readFile(fixture.patchPath)).toEqual(patchBeforeDelivery);
    const retained = (
      await readdir(join(fixture.deliveryRoot, "attempts"), { recursive: true })
    ).find((path) => path.endsWith("verified.patch"));
    expect(retained).toBeDefined();
    expect(await readFile(join(fixture.deliveryRoot, "attempts", retained!))).toEqual(
      patchBeforeDelivery,
    );
    expect(await gitText(fixture.source, "branch", "--show-current")).toBe("main");
    const serialized = JSON.stringify(rejected);
    expect(serialized).not.toContain(fixture.root);
    expect(serialized).not.toContain(fixture.source);
    expect(serialized).not.toContain(deliveryValidationFailureFixtureRoot);
    expect(serialized).not.toContain(invalidLinkTarget);
  });

  it("does not treat ordinary deleted or renamed documentation as deleted configuration", async () => {
    const changedPaths = [
      { path: "docs/old.md", status: "deleted" as const },
      { path: "docs/new.md", status: "added" as const },
      { path: "docs/rename.md", status: "deleted" as const },
      { path: "docs/renamed.md", status: "renamed" as const },
      { path: "fern/docs.yml", status: "added" as const },
    ];
    const fixture = await createFixture(
      async (writer) => {
        await rm(join(writer, "docs", "old.md"));
        await git(writer, "mv", "docs/rename.md", "docs/renamed.md");
        await writeFile(join(writer, "docs", "new.md"), "New page\n");
        await mkdir(join(writer, "fern"));
        await writeFile(
          join(writer, "fern", "docs.yml"),
          "navigation:\n  - page: New\n    path: ../docs/new.md\n  - page: Renamed\n    path: ../docs/renamed.md\n",
        );
      },
      [
        { path: "docs/old.md", status: "deleted" },
        { path: "docs/new.md", status: "added" },
        {
          path: "docs/renamed.md",
          previousPath: "docs/rename.md",
          status: "renamed",
        },
        { path: "fern/docs.yml", status: "added" },
      ],
      {
        validationCommand: "test -d .",
        extraValidationScript: async (source) => {
          await mkdir(join(source, "docs"));
          await writeFile(join(source, "docs", "old.md"), "Old page\n");
          await writeFile(join(source, "docs", "rename.md"), "Rename this page\n");
        },
      },
    );
    const selected = await upgradeFixtureToSourceAwareV2(fixture, changedPaths);
    const result = await prepare(fixture);
    expect(result.status, result.status === "failed" ? result.code : undefined).toBe("ready");
    if (result.status !== "ready") return;
    const attestation = await inspectReadyDeliveryWorktree(result.worktree);
    expect(attestation.validation.results).toEqual(
      selected.binding.checkIds.map((id) => ({ id, status: "passed" })),
    );
  });

  it("issues an unforgeable ready attestation with tree, workspace, and validation evidence", async () => {
    const fixture = await createFixture(
      async (writer) => {
        await writeFile(join(writer, "README.md"), "attested\n");
      },
      [{ path: "README.md", status: "modified" }],
    );
    const result = await prepare(fixture);
    expect(result.status).toBe("ready");
    const attestation = await inspectReadyDeliveryWorktree(result.worktree);
    expect(attestation).toMatchObject({
      kind: "docsfab-delivery-worktree-ready-attestation",
      planSha256: fixture.plan.sha256,
      baseRevision: fixture.revision,
      worktreePath: result.worktree.worktreePath,
    });
    expect(attestation.tree).toMatch(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
    expect(attestation.workspaceKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(attestation.patch).toEqual({
      sha256: fixture.plan.patch.sha256,
      byteLength: fixture.plan.patch.byteLength,
    });
    expect(attestation.validation.commandSha256).toBe(
      createHash("sha256").update(fixture.plan.validationCommand).digest("hex"),
    );
    await expect(
      assertDeliveryWorktreeReadyAttestation(attestation, result.worktree),
    ).resolves.toBeUndefined();
    await expect(
      assertDeliveryWorktreeReadyAttestation({ ...attestation }, result.worktree),
    ).rejects.toThrow(DeliveryWorktreeError);
    await writeFile(join(result.worktree.worktreePath, "README.md"), "mutated after readiness\n");
    await expect(
      assertDeliveryWorktreeReadyAttestation(attestation, result.worktree),
    ).rejects.toMatchObject({ code: "validation-mutated-delivery" });
    await expect(inspectReadyDeliveryWorktree(result.worktree)).rejects.toMatchObject({
      code: "validation-mutated-delivery",
    });
  });

  it("rejects ready attestation after preserved patch substitution or deletion", async () => {
    for (const removePatch of [false, true]) {
      const fixture = await createFixture(async () => undefined, [], {
        runId: removePatch ? "patch-deleted" : "patch-substituted",
      });
      const result = await prepare(fixture);
      expect(result.status).toBe("ready");
      if (removePatch) await rm(result.worktree.patchPath);
      else await writeFile(result.worktree.patchPath, "substituted patch\n");
      await expect(inspectReadyDeliveryWorktree(result.worktree)).rejects.toMatchObject({
        code: "patch-mismatch",
      });
    }
  }, 15_000);

  it("publishes through the real opaque ready-attestation verifier", async () => {
    const fixture = await createFixture(
      async (writer) => {
        await mkdir(join(writer, "docs"));
        await mkdir(join(writer, "fern"));
        await writeFile(join(writer, "docs", "guide.md"), "opaque publisher\n");
        await writeFile(
          join(writer, "fern", "docs.yml"),
          "navigation:\n  - page: ../docs/guide.md\n",
        );
      },
      [
        { path: "docs/guide.md", status: "added" },
        { path: "fern/docs.yml", status: "added" },
      ],
      { validationCommand: "test -d ." },
    );
    const selected = await upgradeFixtureToSourceAwareV2(fixture, [
      { path: "docs/guide.md", status: "added" },
      { path: "fern/docs.yml", status: "added" },
    ]);
    const prepared = await prepare(fixture);
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    const readyAttestation = await inspectReadyDeliveryWorktree(prepared.worktree);
    const run = await loadVerifiedPublicationRun(fixture.recordPath, fixture.plan.run.id);
    const metadata = buildDocsFabPublicationMetadata({
      plan: fixture.plan,
      workflowOutcome: run.workflowOutcome,
      changedPaths: run.changedFiles.map((file) => file.path),
    });
    const commit = "e".repeat(fixture.revision.length);
    let local = fixture.revision;
    let remote: string | undefined;
    const gitAdapter: LocalGitPublisher = {
      assertConfiguredIdentity: async () => undefined,
      localBranchRevision: async () => local,
      remoteBranchRevision: async () => remote,
      ensureCommit: async () => {
        local = commit;
        return commit;
      },
      ensurePush: async () => {
        remote = commit;
        return commit;
      },
      assertCommit: async ({ commitRevision }) => {
        if (commitRevision !== commit) throw new Error("commit mismatch");
      },
    };
    let request: GitLabMergeRequest | undefined;
    const gitlabAdapter: GitLabPublisherAdapter = {
      inspectPolicy: async () => ({
        username: "maintainer",
        projectId: fixture.plan.project.id,
        projectPath: fixture.plan.project.path,
        accessLevel: 30,
        defaultBranch: "main",
        targetBranch: {
          name: fixture.plan.targetBranch.name,
          protected: fixture.plan.targetBranch.protected,
          revision: fixture.plan.baseRevision,
        },
        sourceBranchProtected: false,
      }),
      findMergeRequests: async () => (request ? [request] : []),
      openDraftMergeRequest: async ({ plan, headRevision }) => {
        request = {
          iid: 7,
          url: "https://gitlab.example.test/group/docs/-/merge_requests/7",
          state: "opened",
          draft: true,
          sourceBranch: plan.proposedSourceBranch,
          targetBranch: plan.targetBranch.name,
          headRevision,
          sourceProjectId: plan.project.id,
          targetProjectId: plan.project.id,
          title: metadata.mergeRequestTitle,
          description: metadata.mergeRequestDescription,
        };
        return request;
      },
    };
    let stored: ScmDeliveryRecord | undefined;
    const receiptStore: ScmDeliveryReceiptStore = {
      load: async () => stored,
      claim: async (record) => {
        const created = stored === undefined;
        stored ??= record;
        return { record: stored, created };
      },
      compareAndSwap: async (expected, record) => {
        if (!stored || stored.sha256 !== expected) throw new Error("receipt conflict");
        stored = record;
        return record;
      },
    };
    const result = await publishLocalUserGitLab(
      {
        plan: fixture.plan,
        authorization: fixture.authorization,
        worktree: prepared.worktree,
        readyAttestation,
        receiptStore,
        workflowOutcome: run.workflowOutcome,
        changedPaths: run.changedFiles.map((file) => file.path),
      },
      { git: gitAdapter, gitlab: gitlabAdapter },
    );
    expect(result.status).toBe("opened");
    if (result.status === "opened") {
      expect(result.record.evidence.validation).toMatchObject({
        profileId: selected.binding.profileId,
        profileVersion: selected.binding.profileVersion,
        checkIds: [...selected.binding.checkIds],
        candidateTreeSha256: readyAttestation.validation.candidateTreeSha256,
        resultSha256: readyAttestation.validation.resultSha256,
        results: readyAttestation.validation.results,
        checkCount: selected.binding.checkIds.length,
      });
    }
  });

  it("rejects direct publication with a historical v1 explicit command before receipt claim", async () => {
    const fixture = await createFixture(
      async (writer) => {
        await writeFile(join(writer, "README.md"), "historical documentation\n");
      },
      [{ path: "README.md", status: "modified" }],
    );
    let claims = 0;
    const receiptStore: ScmDeliveryReceiptStore = {
      load: async () => undefined,
      claim: async (record) => {
        claims += 1;
        return { record, created: true };
      },
      compareAndSwap: async (_expected, record) => record,
    };
    await expect(
      publishLocalUserGitLab(
        {
          plan: fixture.plan,
          authorization: fixture.authorization,
          worktree: {} as DeliveryWorktreeCapability,
          readyAttestation: {} as DeliveryWorktreeReadyAttestation,
          receiptStore,
          workflowOutcome: "Historical documentation plan",
          changedPaths: ["README.md"],
        },
        { assertReady: async () => undefined },
      ),
    ).rejects.toMatchObject({ name: "LocalUserGitLabPublisherError", code: "invalid-input" });
    expect(claims).toBe(0);
  });

  it("rejects a zero patch contract before delivery preparation", async () => {
    const fixture = await createFixture(async () => undefined, []);
    const empty = redigest({
      ...fixture.plan,
      patch: {
        ...fixture.plan.patch,
        sha256: createHash("sha256").update("").digest("hex"),
        byteLength: 0,
        changedFileCount: 0,
      },
    });
    expect(() => authorize(empty)).toThrow();
    expect((await readdir(fixture.deliveryRoot)).length).toBe(0);
  });

  it("preserves the source checkout's tracked, staged, untracked, branch, and HEAD state", async () => {
    const fixture = await createFixture(
      async (writer) => {
        await writeFile(join(writer, "README.md"), "delivery\n");
      },
      [{ path: "README.md", status: "modified" }],
    );
    await writeFile(join(fixture.source, "delete.txt"), "source unstaged\n");
    await writeFile(join(fixture.source, "rename.txt"), "source staged\n");
    await git(fixture.source, "add", "rename.txt");
    await writeFile(join(fixture.source, "untracked.txt"), "untracked bytes\n");
    const before = await completeSourceSnapshot(fixture.source);
    const result = await prepare(fixture);
    expect(result.status).toBe("ready");
    expect(await completeSourceSnapshot(fixture.source)).toBe(before);
  });

  it("fails before validation on patch path/evidence mismatch and preserves recovery state", async () => {
    const fixture = await createFixture(
      async (writer) => {
        await writeFile(join(writer, "README.md"), "changed\n");
      },
      [{ path: "delete.txt", status: "modified" }],
    );
    const result = await prepare(fixture);
    expect(result).toMatchObject({
      status: "failed",
      code: "patch-path-mismatch",
    });
    expect(await readFile(result.worktree.patchPath)).toEqual(await readFile(fixture.patchPath));
    expect((await stat(result.worktree.worktreePath)).isDirectory()).toBe(true);
    expect(await gitText(result.worktree.worktreePath, "status", "--porcelain")).toBe("");
  });

  /** Files a binary hunk carries, each holding `value` where a UTF-8 screen cannot read it. */
  const hiddenValueFiles = [
    [
      "a binary blob",
      "asset.bin",
      (value: string) =>
        Buffer.concat([Buffer.from([0, 255, 1, 254]), Buffer.from(value), Buffer.from([0])]),
    ],
    [
      "a UTF-16LE text file with a byte order mark",
      "notes-utf16le.txt",
      (value: string) =>
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`note ${value}\n`, "utf16le")]),
    ],
    [
      "a UTF-16BE text file at an odd offset",
      "notes-utf16be.txt",
      (value: string) =>
        Buffer.concat([Buffer.from([0]), Buffer.from(`note ${value}\n`, "utf16le").swap16()]),
    ],
  ] as const;

  it.each(hiddenValueFiles)(
    "refuses %s that holds a configured credential before writing the delivery tree",
    async (_label, path, contents) => {
      const credential = configureCredential(
        ["harbor", plantedCredentialValue(1401, 24)].join("-"),
      );
      const fixture = await createFixture(
        async (writer) => {
          await writeFile(join(writer, path), contents(credential));
        },
        [{ path, status: "added" }],
      );
      // The patch carries the file as zlib and base85, so a screen of the
      // patch text cannot see the value (#1807).
      const patchText = (await readFile(fixture.patchPath)).toString("utf8");
      expect(patchText).toContain("GIT binary patch");
      expect(containsConfiguredCredential(patchText)).toBe(false);

      const result = await prepare(fixture);

      expect(result).toMatchObject({ status: "failed", code: "delivery-credential-material" });
      expect(DELIVERY_ACTIONS["delivery-credential-material"]).toContain(
        "Remove the configured credential",
      );
      // Nothing of the change reached the worktree; it holds the clean base.
      await expect(lstat(join(result.worktree.worktreePath, path))).rejects.toThrow();
      expect(await gitText(result.worktree.worktreePath, "status", "--porcelain")).toBe("");
    },
  );

  /** A base file holding `contents`, written before the base commit. */
  const baseFile = (path: string, contents: Buffer | string) => async (source: string) => {
    await writeFile(join(source, path), contents);
  };
  const utf16Note = (text: string) =>
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`note ${text}\n`, "utf16le")]);

  it.each([
    [
      "a rename (R100) of a file holding a configured credential",
      (value: string) => baseFile("notes-secret.txt", `note ${value}\n`),
      async (writer: string) => {
        await git(writer, "mv", "notes-secret.txt", "moved-notes.txt");
      },
      [{ path: "moved-notes.txt", previousPath: "notes-secret.txt", status: "renamed" }],
    ],
    [
      "a copy (C100) of a file holding a configured credential",
      (value: string) => baseFile("notes-secret.txt", `note ${value}\n`),
      async (writer: string) => {
        await writeFile(
          join(writer, "copied-notes.txt"),
          await readFile(join(writer, "notes-secret.txt")),
        );
      },
      [{ path: "copied-notes.txt", previousPath: "notes-secret.txt", status: "copied" }],
    ],
    [
      "a mode-only change to a file holding a configured credential",
      (value: string) => baseFile("secret-tool.sh", `#!/bin/sh\n# ${value}\n`),
      async (writer: string) => {
        await chmod(join(writer, "secret-tool.sh"), 0o755);
      },
      [{ path: "secret-tool.sh", status: "modified" }],
    ],
    [
      "a UTF-16 file modified to hold a configured credential",
      () => baseFile("notes-utf16.txt", utf16Note("clean")),
      async (writer: string, value: string) => {
        await writeFile(join(writer, "notes-utf16.txt"), utf16Note(value));
      },
      [{ path: "notes-utf16.txt", status: "modified" }],
    ],
    [
      "a configured credential in the second of two added blobs",
      () => async () => undefined,
      async (writer: string, value: string) => {
        await writeFile(join(writer, "a-clean.bin"), Buffer.from([0, 255, 1, 254, 2]));
        await writeFile(
          join(writer, "b-hidden.bin"),
          Buffer.concat([Buffer.from([0, 255]), Buffer.from(value), Buffer.from([0])]),
        );
      },
      [
        { path: "a-clean.bin", status: "added" },
        { path: "b-hidden.bin", status: "added" },
      ],
    ],
  ] as const)(
    "refuses %s before writing the delivery tree",
    async (_label, base, change, files) => {
      const credential = configureCredential(
        ["harbor", plantedCredentialValue(1403, 24)].join("-"),
      );
      const fixture = await createFixture(
        (writer) => change(writer, credential),
        files.map((file) => ({ ...file })),
        { extraValidationScript: base(credential) },
      );

      const result = await prepare(fixture);

      expect(result).toMatchObject({ status: "failed", code: "delivery-credential-material" });
      expect(await gitText(result.worktree.worktreePath, "status", "--porcelain")).toBe("");
    },
  );

  it("names a configured credential the patch text shows as a delivery credential stop", async () => {
    const credential = configureCredential(["harbor", plantedCredentialValue(1404, 24)].join("-"));
    const fixture = await createFixture(
      async (writer) => {
        await writeFile(join(writer, "notes.txt"), `note ${credential}\n`);
      },
      [{ path: "notes.txt", status: "added" }],
    );
    expect(containsConfiguredCredential((await readFile(fixture.patchPath)).toString("utf8"))).toBe(
      true,
    );
    await expect(prepare(fixture)).rejects.toMatchObject({ code: "delivery-credential-material" });
  });

  it.each(hiddenValueFiles)(
    "delivers %s whose value is not a configured credential",
    async (_label, path, contents) => {
      const value = ["harbor", plantedCredentialValue(1402, 24)].join("-");
      const fixture = await createFixture(
        async (writer) => {
          await writeFile(join(writer, path), contents(value));
        },
        [{ path, status: "added" }],
      );

      const result = await prepare(fixture);

      expect(result.status, result.status === "failed" ? result.code : undefined).toBe("ready");
      expect(await readFile(join(result.worktree.worktreePath, path))).toEqual(contents(value));
    },
  );

  it("rejects a saved copied tuple when the authenticated patch renames its source", async () => {
    const fixture = await createFixture(
      async (writer) => {
        await git(writer, "mv", "rename.txt", "renamed.txt");
      },
      [
        {
          path: "renamed.txt",
          previousPath: "rename.txt",
          status: "copied",
        },
      ],
    );

    const result = await prepare(fixture);

    expect(result).toMatchObject({
      status: "failed",
      code: "patch-path-mismatch",
    });
  });

  it("rejects a context conflict before applying and preserves the clean failed worktree", async () => {
    const fixture = await createFixture(
      async (writer) => {
        await writeFile(join(writer, "README.md"), "changed\n");
      },
      [{ path: "README.md", status: "modified" }],
      { corruptContext: true },
    );
    const result = await prepare(fixture);
    expect(result).toMatchObject({
      status: "failed",
      code: "patch-conflict",
    });
    expect(await gitText(result.worktree.worktreePath, "status", "--porcelain")).toBe("");
    expect(await readFile(result.worktree.patchPath)).toEqual(await readFile(fixture.patchPath));
  });

  it("reports a run record it cannot decode as run-record-contract-gap, not a mismatch (#2366)", async () => {
    const change = async (writer: string) => {
      await writeFile(join(writer, "README.md"), "changed\n");
    };
    const files: ChangedFileEvidence[] = [{ path: "README.md", status: "modified" }];
    const undecodable = await createFixture(change, files);
    const parsed = JSON.parse(await readFile(undecodable.recordPath, "utf8"));
    delete parsed.workspace;
    delete parsed.createdAt;
    await writeFile(undecodable.recordPath, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
    await expect(prepare(undecodable)).rejects.toMatchObject({
      code: "run-record-contract-gap",
    });
    // Positive control: the same run record, intact, prepares.
    const intact = await createFixture(change, files);
    expect((await prepare(intact)).status).toBe("ready");
  });

  it("rejects run-record, patch digest, repository identity, and base mismatches before apply", async () => {
    const recordMismatch = await createFixture(
      async (writer) => {
        await writeFile(join(writer, "README.md"), "changed\n");
      },
      [{ path: "README.md", status: "modified" }],
    );
    recordMismatch.plan = redigest({
      ...recordMismatch.plan,
      run: {
        ...recordMismatch.plan.run,
        recordSha256: "b".repeat(64),
      },
    });
    recordMismatch.authorization = authorize(recordMismatch.plan);
    await expect(prepare(recordMismatch)).rejects.toMatchObject({
      code: "run-record-mismatch",
    });

    const patchMismatch = await createFixture(
      async (writer) => {
        await writeFile(join(writer, "README.md"), "changed\n");
      },
      [{ path: "README.md", status: "modified" }],
    );
    await writeFile(patchMismatch.patchPath, "tampered", { mode: 0o600 });
    await expect(prepare(patchMismatch)).rejects.toMatchObject({
      code: "patch-mismatch",
    });

    const repositoryMismatch = await createFixture(async () => undefined, []);
    await git(
      repositoryMismatch.source,
      "remote",
      "set-url",
      "origin",
      "https://gitlab.example.test/other/docs.git",
    );
    await expect(prepare(repositoryMismatch)).rejects.toMatchObject({
      code: "source-repository-mismatch",
    });

    const baseMismatch = await createFixture(async () => undefined, []);
    baseMismatch.plan = redigest({
      ...baseMismatch.plan,
      baseRevision: "f".repeat(40),
    });
    baseMismatch.authorization = authorize(baseMismatch.plan);
    await expect(prepare(baseMismatch)).rejects.toMatchObject({
      code: "run-record-mismatch",
    });
  });

  it("rejects forged authorization and a symlinked delivery root before mutation", async () => {
    const authorization = await createFixture(async () => undefined, []);
    authorization.authorization = { ...authorization.authorization };
    await expect(prepare(authorization)).rejects.toMatchObject({
      code: "authorization-mismatch",
    });

    const unsafeRoot = await createFixture(async () => undefined, []);
    const link = join(unsafeRoot.root, "delivery-link");
    await symlink(unsafeRoot.deliveryRoot, link, "dir");
    unsafeRoot.deliveryRoot = link;
    await expect(prepare(unsafeRoot)).rejects.toMatchObject({
      code: "delivery-root-unsafe",
    });
  });

  it("uses deterministic collision-resistant branches and isolates concurrent deliveries", async () => {
    const first = await createFixture(
      async (writer) => {
        await writeFile(join(writer, "first.txt"), "first\n");
      },
      [{ path: "first.txt", status: "added" }],
      { runId: "run-first" },
    );
    const second = await createFixture(
      async (writer) => {
        await writeFile(join(writer, "second.txt"), "second\n");
      },
      [{ path: "second.txt", status: "added" }],
      {
        runId: "run-second",
        existingRoot: first.root,
        source: first.source,
      },
    );
    expect(first.plan.proposedSourceBranch).not.toBe(second.plan.proposedSourceBranch);
    const [one, two] = await Promise.all([prepare(first), prepare(second)]);
    expect(one).toMatchObject({ status: "ready" });
    expect(two).toMatchObject({ status: "ready" });
    expect(one.worktree.worktreePath).not.toBe(two.worktree.worktreePath);
    expect(await readFile(join(one.worktree.worktreePath, "first.txt"), "utf8")).toBe("first\n");
    expect(await readFile(join(two.worktree.worktreePath, "second.txt"), "utf8")).toBe("second\n");
  });

  it("fails closed on a same-delivery collision without disturbing the first worktree", async () => {
    const fixture = await createFixture(async () => undefined, []);
    const first = await prepare(fixture);
    await expect(prepare(fixture)).rejects.toMatchObject({
      code: "delivery-collision",
    });
    expect(first.status).toBe("ready");
    expect((await stat(first.worktree.worktreePath)).isDirectory()).toBe(true);
  });

  it("revalidates a fresh detached recovery worktree when the receipt-bound source branch exists", async () => {
    const fixture = await createFixture(
      async (writer) => {
        await writeFile(join(writer, "README.md"), "delivery\n");
      },
      [{ path: "README.md", status: "modified" }],
    );
    const first = await prepare(fixture);
    expect(first.status).toBe("ready");
    const recoveryRoot = join(fixture.root, "recovery-delivery");
    const recovered = await prepareDeliveryWorktree(
      prepareInput(fixture, {
        deliveryRoot: recoveryRoot,
        sourceBranchMode: "reuse-existing",
      }),
      new ExecFileDeliveryCommandRunner(),
      async () => ({ commandPrefix: [] }),
    );
    expect(recovered.status, recovered.status === "failed" ? recovered.code : undefined).toBe(
      "ready",
    );
    if (recovered.status !== "ready") return;
    expect(
      await gitText(recovered.worktree.worktreePath, "rev-parse", "--abbrev-ref", "HEAD"),
    ).toBe("HEAD");
    expect(await readFile(join(recovered.worktree.worktreePath, "README.md"), "utf8")).toBe(
      "delivery\n",
    );
  });

  it("rehydrates an exact receipt-bound published commit without moving the source ref", async () => {
    const fixture = await createFixture(
      async (writer) => {
        await writeFile(join(writer, "README.md"), "published delivery\n");
      },
      [{ path: "README.md", status: "modified" }],
    );
    const first = await prepare(fixture);
    expect(first.status).toBe("ready");
    if (first.status !== "ready") return;
    await git(first.worktree.worktreePath, "add", "-A");
    await git(first.worktree.worktreePath, "commit", "-m", "Publish exact delivery");
    const publishedRevision = await gitText(first.worktree.worktreePath, "rev-parse", "HEAD");

    const recovered = await prepareDeliveryWorktree(
      prepareInput(fixture, {
        deliveryRoot: join(fixture.root, "published-recovery"),
        sourceBranchMode: "rehydrate-published",
        expectedSourceRevision: publishedRevision,
      }),
      new ExecFileDeliveryCommandRunner(),
      async () => ({ commandPrefix: [] }),
    );
    expect(recovered.status, recovered.status === "failed" ? recovered.code : undefined).toBe(
      "ready",
    );
    if (recovered.status !== "ready") return;
    expect(await gitText(fixture.source, "rev-parse", fixture.plan.proposedSourceBranch)).toBe(
      publishedRevision,
    );
    expect(await gitText(recovered.worktree.worktreePath, "rev-parse", "HEAD")).toBe(
      fixture.plan.baseRevision,
    );
    expect(await gitText(recovered.worktree.worktreePath, "branch", "--show-current")).toBe("");
    expect(await readFile(join(recovered.worktree.worktreePath, "README.md"), "utf8")).toBe(
      "published delivery\n",
    );

    await expect(
      prepareDeliveryWorktree(
        prepareInput(fixture, {
          deliveryRoot: join(fixture.root, "published-drift"),
          sourceBranchMode: "rehydrate-published",
          expectedSourceRevision: fixture.plan.baseRevision,
        }),
        new ExecFileDeliveryCommandRunner(),
        async () => ({ commandPrefix: [] }),
      ),
    ).rejects.toMatchObject({ code: "delivery-collision" });
    expect(await gitText(fixture.source, "rev-parse", fixture.plan.proposedSourceBranch)).toBe(
      publishedRevision,
    );
  }, 20_000);

  it("atomically creates or reuses the exact base branch for a planned receipt", async () => {
    const withoutBranch = await createFixture(
      async (writer) => {
        await writeFile(join(writer, "planned.txt"), "planned\n");
      },
      [{ path: "planned.txt", status: "added" }],
    );
    const created = await prepareDeliveryWorktree(
      prepareInput(withoutBranch, { sourceBranchMode: "create-or-reuse" }),
      new ExecFileDeliveryCommandRunner(),
      async () => ({ commandPrefix: [] }),
    );
    expect(created.status).toBe("ready");
    expect(
      await gitText(withoutBranch.source, "rev-parse", withoutBranch.plan.proposedSourceBranch),
    ).toBe(withoutBranch.plan.baseRevision);

    const branchAlreadyCreated = await createFixture(
      async (writer) => {
        await writeFile(join(writer, "README.md"), "recovered\n");
      },
      [{ path: "README.md", status: "modified" }],
    );
    expect((await prepare(branchAlreadyCreated)).status).toBe("ready");
    const recovered = await prepareDeliveryWorktree(
      prepareInput(branchAlreadyCreated, {
        deliveryRoot: join(branchAlreadyCreated.root, "planned-recovery"),
        sourceBranchMode: "create-or-reuse",
      }),
      new ExecFileDeliveryCommandRunner(),
      async () => ({ commandPrefix: [] }),
    );
    expect(recovered.status).toBe("ready");
    if (recovered.status === "ready") {
      expect(
        await gitText(recovered.worktree.worktreePath, "rev-parse", "--abbrev-ref", "HEAD"),
      ).toBe("HEAD");
    }
  }, 20_000);

  it("rejects expired preparation authority before creating a worktree or source ref", async () => {
    const fixture = await createFixture(
      async (writer) => {
        await writeFile(join(writer, "expired.txt"), "expired\n");
      },
      [{ path: "expired.txt", status: "added" }],
    );
    fixture.authorization = authorizeLocalUserPublication({
      plan: fixture.plan,
      confirmedPlanSha256: fixture.plan.sha256,
      command: "publish",
      currentTime: new Date("2026-08-04T12:00:00.000Z"),
      expiresAt: "2026-08-04T12:01:00.000Z",
    });
    await expect(
      prepareDeliveryWorktree(
        prepareInput(fixture, {
          sourceBranchMode: "create-or-reuse",
          clock: () => new Date("2026-08-04T12:01:00.000Z"),
        }),
        new ExecFileDeliveryCommandRunner(),
        async () => ({ commandPrefix: [] }),
      ),
    ).rejects.toMatchObject({ code: "authorization-mismatch" });
    await expect(
      exec("git", ["show-ref", "--verify", `refs/heads/${fixture.plan.proposedSourceBranch}`], {
        cwd: fixture.source,
      }),
    ).rejects.toThrow();
    expect(await readdir(fixture.deliveryRoot)).toEqual([]);
  });

  it("rechecks preparation authority immediately before worktree/ref creation", async () => {
    const fixture = await createFixture(
      async (writer) => {
        await writeFile(join(writer, "expires-during-prepare.txt"), "expired\n");
      },
      [{ path: "expires-during-prepare.txt", status: "added" }],
    );
    fixture.authorization = authorizeLocalUserPublication({
      plan: fixture.plan,
      confirmedPlanSha256: fixture.plan.sha256,
      command: "publish",
      currentTime: new Date("2026-08-04T12:00:00.000Z"),
      expiresAt: "2026-08-04T12:01:00.000Z",
    });
    let checks = 0;
    const result = await prepareDeliveryWorktree(
      prepareInput(fixture, {
        sourceBranchMode: "create-or-reuse",
        clock: () =>
          new Date(++checks < 10 ? "2026-08-04T12:00:30.000Z" : "2026-08-04T12:01:00.000Z"),
      }),
      new ExecFileDeliveryCommandRunner(),
      async () => ({ commandPrefix: [] }),
    );
    expect(result).toMatchObject({
      status: "failed",
      code: "authorization-mismatch",
    });
    await expect(
      exec("git", ["show-ref", "--verify", `refs/heads/${fixture.plan.proposedSourceBranch}`], {
        cwd: fixture.source,
      }),
    ).rejects.toThrow();
    expect(await lstat(result.worktree.worktreePath).catch(() => undefined)).toBeUndefined();
  });

  it("rechecks preparation authority before index, cached-patch, and object mutations", async () => {
    for (const boundary of ["read-tree", "apply-cached", "write-tree"] as const) {
      const fixture = await createFixture(
        async (writer) => {
          await writeFile(join(writer, "README.md"), `${boundary}\n`);
        },
        [{ path: "README.md", status: "modified" }],
        { runId: `expires-${boundary}` },
      );
      fixture.authorization = boundaryAuthorization(fixture.plan);
      const runner = new ExpireAfterGitBoundaryRunner(boundary);
      const result = await prepareDeliveryWorktree(
        prepareInput(fixture, { clock: boundaryClock(() => runner.expired) }),
        runner,
        async () => ({ commandPrefix: [] }),
      );
      expect(result).toMatchObject({
        status: "failed",
        code: "authorization-mismatch",
      });
      if (boundary === "read-tree") {
        expect(runner.operations.some((operation) => operation[0] === "read-tree")).toBe(false);
      } else if (boundary === "apply-cached") {
        expect(
          runner.operations.some(
            (operation) => operation[0] === "apply" && !operation.includes("--check"),
          ),
        ).toBe(false);
      } else {
        expect(runner.operations.some((operation) => operation[0] === "write-tree")).toBe(false);
      }
    }
  }, 15_000);

  it("rechecks preparation authority before each tree filesystem write", async () => {
    const fixture = await createFixture(
      async (writer) => {
        await writeFile(join(writer, "first.txt"), "first\n");
        await writeFile(join(writer, "second.txt"), "second\n");
      },
      [
        { path: "first.txt", status: "added" },
        { path: "second.txt", status: "added" },
      ],
      { runId: "expires-materialization" },
    );
    fixture.authorization = boundaryAuthorization(fixture.plan);
    let materializationStarted = false;
    const runner = new ExpireAfterGitBoundaryRunner("tree-read", () => {
      materializationStarted = true;
    });
    const result = await prepareDeliveryWorktree(
      prepareInput(fixture, { clock: boundaryClock(() => materializationStarted) }),
      runner,
      async () => ({ commandPrefix: [] }),
    );
    expect(result).toMatchObject({
      status: "failed",
      code: "authorization-mismatch",
    });
    expect(result.worktree.worktreePath).toBeTruthy();
    await expect(readFile(join(result.worktree.worktreePath, "README.md"))).rejects.toBeDefined();
  });

  it("rechecks preparation authority before the private patch write", async () => {
    const fixture = await createFixture(
      async (writer) => {
        await writeFile(join(writer, "private.txt"), "private\n");
      },
      [{ path: "private.txt", status: "added" }],
      { runId: "expires-private-patch" },
    );
    fixture.authorization = boundaryAuthorization(fixture.plan);
    let checks = 0;
    await expect(
      prepareDeliveryWorktree(
        prepareInput(fixture, {
          clock: () =>
            new Date(++checks < 7 ? "2026-08-04T12:00:30.000Z" : "2026-08-04T12:01:00.000Z"),
        }),
        new ExecFileDeliveryCommandRunner(),
        async () => ({ commandPrefix: [] }),
      ),
    ).rejects.toMatchObject({ code: "authorization-mismatch" });
    const capsules = await readdir(fixture.deliveryRoot);
    expect(capsules).toHaveLength(1);
    expect(await readdir(join(fixture.deliveryRoot, capsules[0]!))).toEqual([]);
  });

  it("rechecks preparation authority before repository lock-root and lock-claim mutations", async () => {
    for (const [name, validChecks] of [
      ["lock-root", 1],
      ["lock-claim", 2],
    ] as const) {
      const fixture = await createFixture(
        async (writer) => {
          await writeFile(join(writer, `${name}.txt`), `${name}\n`);
        },
        [{ path: `${name}.txt`, status: "added" }],
        { runId: `expires-${name}` },
      );
      fixture.authorization = boundaryAuthorization(fixture.plan);
      let checks = 0;
      await expect(
        prepareDeliveryWorktree(
          prepareInput(fixture, {
            clock: () =>
              new Date(
                ++checks <= validChecks ? "2026-08-04T12:00:30.000Z" : "2026-08-04T12:01:00.000Z",
              ),
          }),
          new ExecFileDeliveryCommandRunner(),
          async () => ({ commandPrefix: [] }),
        ),
      ).rejects.toMatchObject({ code: "authorization-mismatch" });
      expect(await readdir(fixture.deliveryRoot)).toEqual([]);
      await expect(
        exec("git", ["show-ref", "--verify", `refs/heads/${fixture.plan.proposedSourceBranch}`], {
          cwd: fixture.source,
        }),
      ).rejects.toThrow();
    }
  });

  it("rechecks preparation authority at prepared, validation scratch, isolation, and launch boundaries", async () => {
    const baseline = await createFixture(
      async (writer) => {
        await writeFile(join(writer, "README.md"), "boundary baseline\n");
      },
      [{ path: "README.md", status: "modified" }],
      { runId: "boundary-baseline" },
    );
    baseline.authorization = boundaryAuthorization(baseline.plan);
    let totalChecks = 0;
    const baselineResult = await prepareDeliveryWorktree(
      prepareInput(baseline, {
        onPrepared: async () => undefined,
        clock: () => {
          totalChecks += 1;
          return new Date("2026-08-04T12:00:30.000Z");
        },
      }),
      new ExecFileDeliveryCommandRunner(),
      async () => ({ commandPrefix: [] }),
    );
    expect(baselineResult.status).toBe("ready");

    for (const [name, offset] of [
      ["prepared-transition", 4],
      ["validation-home", 3],
      ["validation-tmp", 2],
      ["validation-isolation", 1],
      ["validation-launch", 0],
    ] as const) {
      const fixture = await createFixture(
        async (writer) => {
          await writeFile(join(writer, "README.md"), "boundary baseline\n");
        },
        [{ path: "README.md", status: "modified" }],
        { runId: `expires-${name}` },
      );
      fixture.authorization = boundaryAuthorization(fixture.plan);
      let checks = 0;
      let preparedCalled = false;
      let isolationCalled = false;
      const runner = new RecordingRunner();
      const result = await prepareDeliveryWorktree(
        prepareInput(fixture, {
          onPrepared: async () => {
            preparedCalled = true;
          },
          clock: () =>
            new Date(
              ++checks < totalChecks - offset
                ? "2026-08-04T12:00:30.000Z"
                : "2026-08-04T12:01:00.000Z",
            ),
        }),
        runner,
        async () => {
          isolationCalled = true;
          return { commandPrefix: [] };
        },
      );
      expect(result, name).toMatchObject({
        status: "failed",
        code: "authorization-mismatch",
      });
      if (name === "prepared-transition") expect(preparedCalled).toBe(false);
      if (name === "validation-isolation") expect(isolationCalled).toBe(false);
      if (name === "validation-launch") {
        expect(isolationCalled).toBe(true);
        expect(runner.calls.some((call) => call.command === "node")).toBe(false);
      }
    }
  }, 30_000);

  it("confines validation to the delivery worktree with a credential-free environment", async () => {
    const fixture = await createFixture(
      async (writer) => {
        await writeFile(join(writer, "README.md"), "validated\n");
      },
      [{ path: "README.md", status: "modified" }],
    );
    const runner = new RecordingRunner();
    const result = await prepare(fixture, runner);
    expect(result.status).toBe("ready");
    const validation = runner.calls.find((call) => call.command === "node");
    expect(validation?.cwd).toBe(result.worktree.worktreePath);
    expect(validation?.options?.env).not.toHaveProperty("GLAB_TOKEN");
    expect(validation?.options?.env).not.toHaveProperty("SSH_AUTH_SOCK");
    expect(validation?.options?.env?.GIT_TERMINAL_PROMPT).toBe("0");
    expect(validation?.options?.env?.HOME).toBe(
      join(result.worktree.capsulePath, "validation-home"),
    );
    expect(
      runner.calls.some(
        (call) =>
          call.command === "glab" ||
          call.args.some((argument) => ["commit", "push"].includes(argument)),
      ),
    ).toBe(false);
    const gitCalls = runner.calls.filter((call) => call.command === "git");
    expect(gitCalls.length).toBeGreaterThan(0);
    expect(
      gitCalls.every(
        (call) =>
          call.args.includes("core.hooksPath=/dev/null") &&
          call.args.includes("core.fsmonitor=false") &&
          call.options?.env?.HOME === "/dev/null" &&
          call.options.env.GIT_NO_REPLACE_OBJECTS === "1" &&
          call.options.env.SSH_AUTH_SOCK === undefined &&
          call.options.env.GLAB_TOKEN === undefined,
      ),
    ).toBe(true);
    const applyCalls = gitCalls.filter((call) => call.args.includes("apply"));
    expect(applyCalls.length).toBeGreaterThan(0);
    const expectedPatch = await readFile(fixture.patchPath);
    expect(
      applyCalls.every(
        (call) =>
          call.args.at(-1) === "-" && Buffer.from(call.options?.stdin ?? []).equals(expectedPatch),
      ),
    ).toBe(true);
    const operations = gitCalls.map((call) => stripSafeGitConfig(call.args));
    expect(
      operations.some(
        (operation) =>
          operation[0] === "worktree" &&
          operation[1] === "add" &&
          operation.includes("--no-checkout"),
      ),
    ).toBe(true);
    expect(
      operations.some(
        (operation) =>
          [
            "status",
            "diff",
            "symbolic-ref",
            "show-ref",
            "for-each-ref",
            "reflog",
            "checkout",
            "reset",
          ].includes(operation[0] ?? "") ||
          (operation[0] === "worktree" && operation[1] === "list"),
      ),
    ).toBe(false);
  });

  it("provides Linux kernel confinement and rejects unsupported platforms", () => {
    expect(validationIsolationCandidates("darwin", ["/tmp/worktree"], ["/tmp/validation"])).toEqual(
      [],
    );
    const linux = validationIsolationCandidates(
      "linux",
      ["/tmp/worktree"],
      ["/tmp/validation"],
    )[0]!;
    expect(linux[0]).toBe("/usr/bin/bwrap");
    expect(linux).toContain("--unshare-net");
    expect(linux).toContain("--unshare-pid");
    expect(linux).toContain("--die-with-parent");
    expect(linux.join(" ")).not.toContain("--ro-bind / /");
    expect(
      validationIsolationCandidates(
        "linux",
        ["/tmp/worktree"],
        ["/tmp/validation"],
        ["/usr/local/src/repository"],
      ),
    ).toEqual([]);
    expect(
      validationIsolationCandidates(
        "linux",
        ["/tmp/worktree"],
        ["/tmp/validation"],
        ["/home/maintainer/repository"],
      ),
    ).toHaveLength(1);
    expect(validationIsolationCandidates("win32", ["/tmp/worktree"], ["/tmp/validation"])).toEqual(
      [],
    );
    expect(nestedExecuteHostMustStayConfined(() => true)).toBe(true);
    expect(nestedExecuteHostMustStayConfined(() => false)).toBe(false);
  });

  it("probes regular source and common-Git sentinels for a linked source worktree", async () => {
    const primary = await createFixture(async () => undefined, []);
    const linkedSource = join(primary.root, "linked-source");
    await git(primary.source, "worktree", "add", "--detach", linkedSource, primary.revision);
    const fixture = await createFixture(
      async (writer) => {
        await writeFile(join(writer, "README.md"), "linked source delivery\n");
      },
      [{ path: "README.md", status: "modified" }],
      {
        existingRoot: primary.root,
        source: linkedSource,
        runId: "linked-source-run",
      },
    );
    let captured: DeliveryValidationIsolationRequest | undefined;
    const result = await prepareDeliveryWorktree(
      prepareInput(fixture),
      new ExecFileDeliveryCommandRunner(),
      async (request) => {
        captured = request;
        return { commandPrefix: [] };
      },
    );
    expect(result.status).toBe("ready");
    expect(captured).toBeDefined();
    expect(captured!.deniedReadPaths).toContain(
      await realpath(join(primary.source, ".git", "config")),
    );
    const canonicalLinkedSource = await realpath(linkedSource);
    expect(captured!.deniedReadRoots).toContain(canonicalLinkedSource);
    expect(captured!.deniedReadRoots).toContain(await realpath(join(primary.source, ".git")));
    expect(
      captured!.deniedReadPaths.some(
        (path) =>
          path.startsWith(`${canonicalLinkedSource}/`) &&
          !path.includes(`${canonicalLinkedSource}/.git/`),
      ),
    ).toBe(true);
    for (const path of captured!.deniedReadPaths) {
      const details = await lstat(path);
      expect(details.isFile() && !details.isSymbolicLink()).toBe(true);
    }
  });

  it("kills the complete validation process group on timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-process-tree-"));
    temporaryDirectories.push(root);
    const marker = join(root, "escaped-child.txt");
    const script = [
      "const {spawn}=require('node:child_process');",
      `spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'escaped'),500);setTimeout(()=>{},2000);`)}]);`,
      "setTimeout(()=>{},2000);",
    ].join("");
    const result = await new ExecFileDeliveryCommandRunner().run(
      process.execPath,
      ["-e", script],
      root,
      { timeoutMs: 100 },
    );
    expect(result.exitCode).toBe(1);
    await new Promise((resolveWait) => setTimeout(resolveWait, 800));
    await expect(stat(marker)).rejects.toBeDefined();
  });

  it("rejects executable local Git hooks, fsmonitor, filters, and external diff config", async () => {
    for (const [key, value] of [
      ["core.fsmonitor", "malicious-monitor"],
      ["core.hooksPath", ".hooks"],
      ["filter.attack.process", "malicious-filter"],
      ["diff.attack.command", "malicious-diff"],
      ["diff.attack.textconv", "malicious-textconv"],
    ] as const) {
      const fixture = await createFixture(async () => undefined, []);
      await git(fixture.source, "config", key, value);
      await expect(prepare(fixture)).rejects.toMatchObject({
        code: "source-repository-mismatch",
      });
    }
  });

  it("rejects core.worktree redirection before touching an external worktree", async () => {
    const fixture = await createFixture(async () => undefined, []);
    const external = join(fixture.root, "external-worktree");
    await mkdir(external);
    const sentinel = join(external, "sentinel.txt");
    await writeFile(sentinel, "untouched\n");
    await git(fixture.source, "config", "core.worktree", external);
    await expect(prepare(fixture)).rejects.toMatchObject({
      code: "source-repository-mismatch",
    });
    expect(await readFile(sentinel, "utf8")).toBe("untouched\n");
    expect(await readdir(fixture.deliveryRoot)).toEqual([]);
  });

  it("contains transient filter and core.worktree injection restored inside Git boundaries", async () => {
    const fixture = await createFixture(
      async (writer) => {
        await writeFile(join(writer, "README.md"), "filter-safe\n");
      },
      [{ path: "README.md", status: "modified" }],
    );
    const marker = join(fixture.root, "transient-filter-executed");
    const external = join(fixture.root, "transient-external-worktree");
    await mkdir(external);
    const sentinel = join(external, "sentinel.txt");
    await writeFile(sentinel, "untouched\n");
    const result = await prepare(
      fixture,
      new TransientFilterRunner(fixture.source, marker, external),
    );
    expect(result.status, result.status === "failed" ? result.code : undefined).toBe("ready");
    await expect(stat(marker)).rejects.toBeDefined();
    expect(await readFile(sentinel, "utf8")).toBe("untouched\n");
  });

  it("rejects a gitlink tree without materializing it", async () => {
    const fixture = await createFixture(
      async (writer) => {
        const nested = join(writer, "nested-repository");
        await mkdir(nested);
        await git(nested, "init", "-b", "main");
        await git(nested, "config", "user.name", "Maintainer");
        await git(nested, "config", "user.email", "maintainer@example.test");
        await git(nested, "config", "commit.gpgsign", "false");
        await writeFile(join(nested, "README.md"), "nested\n");
        await git(nested, "add", "README.md");
        await git(nested, "commit", "-m", "nested");
        await git(writer, "add", "nested-repository");
      },
      [{ path: "nested-repository", status: "added" }],
    );
    const result = await prepare(fixture);
    expect(result).toMatchObject({
      status: "failed",
      code: "patch-application-failed",
    });
    await expect(
      lstat(join(result.worktree.worktreePath, "nested-repository")),
    ).rejects.toBeDefined();
  });

  it("supports SHA-256 repositories when the installed Git supports them", async () => {
    const probe = await mkdtemp(join(tmpdir(), "docsfab-sha256-probe-"));
    temporaryDirectories.push(probe);
    try {
      await git(probe, "init", "--object-format=sha256", "-b", "main");
    } catch {
      return;
    }
    const fixture = await createFixture(
      async (writer) => {
        await writeFile(join(writer, "README.md"), "sha256 delivery\n");
      },
      [{ path: "README.md", status: "modified" }],
      { objectFormat: "sha256" },
    );
    expect(fixture.revision).toHaveLength(64);
    const result = await prepare(fixture);
    expect(result.status, result.status === "failed" ? result.code : undefined).toBe("ready");
  });

  it("pins local Git configuration against a check/use race", async () => {
    const fixture = await createFixture(async () => undefined, []);
    await expect(prepare(fixture, new ConfigMutationRunner(fixture.source))).rejects.toMatchObject({
      code: "source-repository-mismatch",
    });
  });

  it("pins benign include origins and rejects source and delivery config.worktree filters", async () => {
    const included = await createFixture(async () => undefined, []);
    const includePath = join(included.root, "included.gitconfig");
    await writeFile(includePath, "[color]\n\tui = false\n", { mode: 0o600 });
    await git(included.source, "config", "include.path", includePath);
    expect((await prepare(included)).status).toBe("ready");

    for (const deliveryLayer of [false, true]) {
      const fixture = await createFixture(async () => undefined, []);
      await git(fixture.source, "config", "extensions.worktreeConfig", "true");
      const marker = join(fixture.root, "filter-executed");
      if (!deliveryLayer) {
        await git(
          fixture.source,
          "config",
          "--worktree",
          "filter.attack.clean",
          `node -e \"require('node:fs').writeFileSync('${marker}','x')\"`,
        );
        await expect(prepare(fixture)).rejects.toMatchObject({
          code: "source-repository-mismatch",
        });
      } else {
        const result = await prepare(fixture, new DeliveryWorktreeConfigFilterRunner(marker));
        expect(result).toMatchObject({
          status: "failed",
          code: "source-repository-mismatch",
        });
      }
      await expect(stat(marker)).rejects.toBeDefined();
    }
  });

  it("retains and retry-safely cleans delegated-success and branch-only partial adds", async () => {
    for (const runner of [
      new AddSuccessReturnedFailureRunner(),
      new BranchOnlyAddFailureRunner(),
    ]) {
      const fixture = await createFixture(async () => undefined, []);
      const result = await prepare(fixture, runner);
      expect(result).toMatchObject({
        status: "failed",
        code: "worktree-creation-failed",
      });
      expect((await readdir(fixture.deliveryRoot)).length).toBe(1);
      const discard = await authorizeDeliveryDiscard({
        worktree: result.worktree,
        confirmedPlanSha256: fixture.plan.sha256,
        confirmation: "discard-failed-or-uncommitted-delivery",
        reason: "Operator reviewed exact partial add artifacts.",
        deleteBranch: true,
      });
      await cleanupDeliveryWorktree(result.worktree, {
        mode: "operator-discard",
        authorization: discard,
      });
      expect(result.worktree.state).toBe("cleaned");
      expect(
        await gitText(fixture.source, "branch", "--list", fixture.plan.proposedSourceBranch),
      ).toBe("");
    }
  }, 15_000);

  it("allows only the exact branch-section config delta during deletion", async () => {
    const exact = await createFixture(async () => undefined, []);
    await git(exact.source, "config", `branch.${exact.plan.proposedSourceBranch}.remote`, "origin");
    const exactResult = await prepare(exact);
    const exactDiscard = await authorizeDeliveryDiscard({
      worktree: exactResult.worktree,
      confirmedPlanSha256: exact.plan.sha256,
      confirmation: "discard-failed-or-uncommitted-delivery",
      reason: "Operator reviewed exact branch config deletion.",
      deleteBranch: true,
    });
    await cleanupDeliveryWorktree(exactResult.worktree, {
      mode: "operator-discard",
      authorization: exactDiscard,
    });
    expect(exactResult.worktree.state).toBe("cleaned");

    const drift = await createFixture(async () => undefined, []);
    const driftResult = await prepare(drift);
    const driftDiscard = await authorizeDeliveryDiscard({
      worktree: driftResult.worktree,
      confirmedPlanSha256: drift.plan.sha256,
      confirmation: "discard-failed-or-uncommitted-delivery",
      reason: "Operator reviewed branch before concurrent config drift.",
      deleteBranch: true,
    });
    await expect(
      cleanupDeliveryWorktree(
        driftResult.worktree,
        { mode: "operator-discard", authorization: driftDiscard },
        new BranchDeleteConfigDriftRunner(),
      ),
    ).rejects.toMatchObject({ code: "cleanup-refused" });
    expect((await readdir(drift.deliveryRoot)).length).toBe(1);
  }, 15_000);

  it("rejects a permissive precreated cross-process lock root", async () => {
    const fixture = await createFixture(async () => undefined, []);
    const previousTmp = process.env.TMPDIR;
    const uid = process.getuid?.();
    expect(uid).toBeTypeOf("number");
    const lockRoot = join(fixture.root, `docsfab-delivery-locks-${uid}`);
    await mkdir(lockRoot, { mode: 0o755 });
    await chmod(lockRoot, 0o755);
    process.env.TMPDIR = fixture.root;
    try {
      await expect(prepare(fixture)).rejects.toMatchObject({
        code: "source-repository-mismatch",
      });
    } finally {
      if (previousTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmp;
    }
  });

  it("treats early child exit during large stdin delivery as a bounded failure", async () => {
    const runner = new ExecFileDeliveryCommandRunner();
    const result = await runner.run(process.execPath, ["-e", "process.exit(0)"], process.cwd(), {
      stdin: new Uint8Array(16 * 1024 * 1024),
      timeoutMs: 5_000,
    });
    expect(result.exitCode).toBe(1);
  });

  it("ignores real replacement refs at the publication base", async () => {
    const fixture = await createFixture(
      async (writer) => {
        await writeFile(join(writer, "README.md"), "delivery\n");
      },
      [{ path: "README.md", status: "modified" }],
    );
    const replacementWriter = join(fixture.root, "replacement-writer");
    await git(fixture.source, "worktree", "add", "--detach", replacementWriter, fixture.revision);
    await writeFile(join(replacementWriter, "README.md"), "replacement attack\n");
    await git(replacementWriter, "add", "README.md");
    await git(replacementWriter, "commit", "-m", "replacement");
    const replacement = await gitText(replacementWriter, "rev-parse", "HEAD");
    await git(fixture.source, "worktree", "remove", "--force", replacementWriter);
    await git(fixture.source, "replace", fixture.revision, replacement);
    const result = await prepare(fixture);
    expect(result.status).toBe("ready");
    expect(await gitText(result.worktree.worktreePath, "rev-parse", "HEAD")).toBe(fixture.revision);
    expect(await readFile(join(result.worktree.worktreePath, "README.md"), "utf8")).toBe(
      "delivery\n",
    );
  });

  it("accepts and fingerprints an ordinary symbolic remote HEAD ref", async () => {
    const fixture = await createFixture(async () => undefined, []);
    await git(fixture.source, "update-ref", "refs/remotes/origin/main", fixture.revision);
    await git(
      fixture.source,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    );
    const result = await prepare(fixture);
    expect(result.status, result.status === "failed" ? result.code : undefined).toBe("ready");
  });

  it("runs operator-supervised validation when OS isolation is unavailable", async () => {
    const fixture = await createFixture(async () => undefined, []);
    const result = await prepareDeliveryWorktree(
      prepareInput(fixture),
      new ExecFileDeliveryCommandRunner(),
      async () => {
        throw new Error("isolation unavailable");
      },
    );
    if (nestedExecuteHostMustStayConfined()) {
      expect(result).toMatchObject({
        status: "failed",
        code: "validation-isolation-unavailable",
      });
      return;
    }
    expect(result.status, result.status === "failed" ? result.code : undefined).toBe("ready");
  });

  it("fails closed when nested-sandbox execute isolation is unavailable", async () => {
    const fixture = await createFixture(async () => undefined, []);
    const result = await prepareDeliveryWorktree(
      prepareInput(fixture),
      new ExecFileDeliveryCommandRunner(),
      async () => {
        throw new NestedSandboxIsolationError();
      },
    );
    expect(result).toMatchObject({
      status: "failed",
      code: "validation-isolation-unavailable",
    });
  });

  it("warns and runs operator-supervised validation when host isolation allows fallback", async () => {
    if (nestedExecuteHostMustStayConfined()) return;
    const fixture = await createFixture(async () => undefined, []);
    const warnings: string[] = [];
    const result = await prepareDeliveryWorktree(
      prepareInput(fixture, {
        onValidationIsolationUnavailable: (message) => {
          warnings.push(message);
        },
      }),
      new ExecFileDeliveryCommandRunner(),
      async () => {
        throw new NestedSandboxIsolationError("Docker Desktop validation is unavailable.", true);
      },
    );
    expect(result.status, result.status === "failed" ? result.code : undefined).toBe("ready");
    expect(warnings).toEqual(["Docker Desktop validation is unavailable."]);
  });

  it("fails closed for standing-repo-grant when confinement is unavailable", async () => {
    const fixture = await createFixture(async () => undefined, [], {
      authorityBasis: "standing-repo-grant",
    });
    const result = await prepareDeliveryWorktree(
      prepareInput(fixture),
      new ExecFileDeliveryCommandRunner(),
      async () => {
        throw new Error("isolation unavailable");
      },
    );
    expect(result).toMatchObject({
      status: "failed",
      code: "validation-isolation-unavailable",
    });
  });

  it("behaviorally denies host credentials, source Git metadata, and worktree writes", async () => {
    let hostSecret = "";
    const fixture = await createFixture(async () => undefined, [], {
      validationCommand: "node isolation-behavior.cjs",
      extraValidationScript: async (source, root) => {
        hostSecret = join(root, "host-credential");
        await writeFile(hostSecret, "credential-material\n", { mode: 0o600 });
        const script = [
          "const fs=require('node:fs'),p=require('node:path');let bad=false;",
          `for(const target of ${JSON.stringify([hostSecret, join(source, ".git", "config")])}){try{fs.readFileSync(target);bad=true}catch{console.log('HOST_READ_DENIED')}}`,
          "try{fs.writeFileSync('README.md','sandbox escape\\n');bad=true}catch{console.log('SOURCE_WRITE_DENIED')}",
          "try{fs.writeFileSync(p.join(process.env.TMPDIR,'allowed-scratch'),'ok');console.log('SCRATCH_WRITE_ALLOWED')}catch{bad=true}",
          "process.exit(bad?9:0);",
        ].join("");
        await writeFile(join(source, "isolation-behavior.cjs"), script);
      },
    });
    const delegate = new ExecFileDeliveryCommandRunner();
    let configuredValidationCalls = 0;
    let validationOutput = "";
    const commands: DeliveryCommandRunner = {
      run: async (command, args, cwd, options) => {
        if (args.includes("isolation-behavior.cjs")) configuredValidationCalls += 1;
        const result = await delegate.run(command, args, cwd, options);
        if (args.includes("isolation-behavior.cjs")) validationOutput = result.stdout.toString();
        return result;
      },
    };
    const result = await prepareDeliveryWorktree(prepareInput(fixture), commands);
    if (process.platform === "darwin") {
      if (result.status === "ready") {
        expect(configuredValidationCalls).toBeGreaterThan(0);
      } else if (result.status === "failed" && result.code === "validation-isolation-unavailable") {
        expect(configuredValidationCalls).toBe(0);
      } else {
        expect(result).toMatchObject({ status: "failed", code: "validation-failed" });
        expect(configuredValidationCalls).toBeGreaterThan(0);
      }
    } else {
      expect(
        result.status === "ready" ||
          (result.status === "failed" && result.code === "validation-isolation-unavailable"),
      ).toBe(true);
    }
    if (result.status === "ready") {
      expect(validationOutput.trim().split("\n")).toEqual([
        "HOST_READ_DENIED",
        "HOST_READ_DENIED",
        "SOURCE_WRITE_DENIED",
        "SCRATCH_WRITE_ALLOWED",
      ]);
    }
    expect(await readFile(hostSecret, "utf8")).toBe("credential-material\n");
  });

  it("detects a concurrent source-checkout mutation on the final invariant check", async () => {
    const fixture = await createFixture(async () => undefined, []);
    const runner = new MutatingValidationRunner(fixture.source);
    await expect(prepare(fixture, runner)).resolves.toMatchObject({
      status: "failed",
      code: "source-state-changed",
    });
  });

  it("returns a cleanable governed capability when the API-entry source fingerprint fails", async () => {
    const fixture = await createFixture(async () => undefined, []);
    const indexPath = join(fixture.source, ".git", "index");
    const savedIndex = join(fixture.source, ".git", "index.saved");
    await rename(indexPath, savedIndex);
    await symlink("index.saved", indexPath);
    try {
      const result = await prepare(fixture);
      expect(result).toMatchObject({
        status: "failed",
        code: "source-state-changed",
      });
      const discard = await authorizeDeliveryDiscard({
        worktree: result.worktree,
        confirmedPlanSha256: fixture.plan.sha256,
        confirmation: "discard-failed-or-uncommitted-delivery",
        reason: "Operator reviewed failed initial fingerprint.",
        deleteBranch: false,
      });
      await cleanupDeliveryWorktree(result.worktree, {
        mode: "operator-discard",
        authorization: discard,
      });
      expect(result.worktree.state).toBe("cleaned");
    } finally {
      await rm(indexPath);
      await rename(savedIndex, indexPath);
    }
  });

  it("prevents delivery after validation failure and preserves patch/worktree", async () => {
    const fixture = await createFixture(async () => undefined, [], {
      validationCommand: "node fail.cjs",
    });
    let preparedEvidence: { workspaceKey: string; baseRevision: string } | undefined;
    const result = await prepareDeliveryWorktree(
      prepareInput(fixture, {
        onPrepared: async (evidence) => {
          preparedEvidence = evidence;
        },
      }),
      new ExecFileDeliveryCommandRunner(),
      async () => ({ commandPrefix: [] }),
    );
    expect(result).toMatchObject({
      status: "failed",
      code: "validation-failed",
    });
    expect(preparedEvidence).toMatchObject({
      baseRevision: fixture.revision,
    });
    expect(preparedEvidence?.workspaceKey).toMatch(/^[a-f0-9]{64}$/u);
    expect((await stat(result.worktree.worktreePath)).isDirectory()).toBe(true);
    expect(await readFile(result.worktree.patchPath)).toEqual(await readFile(fixture.patchPath));
    expect(await gitText(fixture.source, "branch", "--show-current")).toBe("main");
  });

  it("detects validation mutation and preserves the mutated worktree for diagnosis", async () => {
    const fixture = await createFixture(async () => undefined, [], {
      validationCommand: "node mutate.cjs",
    });
    const result = await prepare(fixture);
    expect(result).toMatchObject({
      status: "failed",
      code: "validation-mutated-delivery",
    });
    expect(await readFile(join(result.worktree.worktreePath, "README.md"), "utf8")).toBe(
      "validation mutation\n",
    );
  });

  it("detects validation mutation of the delivery index even when files are unchanged", async () => {
    const fixture = await createFixture(async () => undefined, []);
    const result = await prepare(fixture, new DeliveryIndexMutationRunner());
    expect(result).toMatchObject({
      status: "failed",
      code: "validation-mutated-delivery",
    });
    expect(await readFile(join(result.worktree.worktreePath, "README.md"), "utf8")).toBe(
      "default delivery\n",
    );
  });

  it("rejects a validator that substitutes the bytes of a newly added untracked file", async () => {
    const fixture = await createFixture(
      async (writer) => {
        await writeFile(join(writer, "added.txt"), "AUTHORIZED\n");
      },
      [{ path: "added.txt", status: "added" }],
      {
        validationCommand: "node rewrite-added.cjs",
      },
    );
    const result = await prepare(fixture);
    expect(result).toMatchObject({
      status: "failed",
      code: "validation-mutated-delivery",
    });
    expect(await readFile(join(result.worktree.worktreePath, "added.txt"), "utf8")).toBe(
      "SUBSTITUTED\n",
    );
  });

  it("returns a governed failure capability when validation escapes to an ignored source path", async () => {
    const fixture = await createFixture(async () => undefined, [], {
      validationCommand: "node escape-source.cjs",
    });
    const result = await prepare(fixture);
    expect(result).toMatchObject({
      status: "failed",
      code: "source-state-changed",
    });
    expect(result.worktree.state).toBe("failed");
    expect(await readFile(join(fixture.source, "ignored.txt"), "utf8")).toBe("ESCAPED\n");
  });

  it("detects verified patch substitution after apply --check", async () => {
    const fixture = await createFixture(
      async (writer) => {
        await writeFile(join(writer, "README.md"), "authorized\n");
      },
      [{ path: "README.md", status: "modified" }],
    );
    const runner = new PatchSwapRunner();
    const result = await prepare(fixture, runner);
    expect(result).toMatchObject({
      status: "failed",
      code: "patch-mismatch",
    });
    expect(await readFile(fixture.patchPath)).not.toEqual(Buffer.from("substituted patch\n"));
    expect(await gitText(result.worktree.worktreePath, "status", "--porcelain")).toBe("");
  });

  it("detects capsule pathname substitution after worktree creation", async () => {
    const fixture = await createFixture(async () => undefined, []);
    const result = await prepare(fixture, new CapsuleSwapRunner());
    expect(result).toMatchObject({
      status: "failed",
      code: "worktree-creation-failed",
    });
  });

  it("detects ignored bytes, modes, symlink targets, and unrelated shared-ref mutation", async () => {
    const fixture = await createFixture(async () => undefined, []);
    await writeFile(join(fixture.source, "ignored.txt"), "original ignored\n");
    await writeFile(join(fixture.source, "ignored-target.txt"), "target\n");
    await symlink("ignored-target.txt", join(fixture.source, "ignored-link"));
    const runner = new SourceBoundaryMutationRunner(fixture.source);
    const result = await prepare(fixture, runner);
    expect(result).toMatchObject({
      status: "failed",
      code: "source-state-changed",
    });
  });

  it("binds the default branch identity to the record and patch digests", () => {
    const revision = "a".repeat(40);
    const record = "b".repeat(64);
    const patch = "c".repeat(64);
    const branch = deterministicLocalUserSourceBranch("run-1", revision, record, patch);
    expect(deterministicLocalUserSourceBranch("run-1", revision, "d".repeat(64), patch)).not.toBe(
      branch,
    );
    expect(deterministicLocalUserSourceBranch("run-1", revision, record, "e".repeat(64))).not.toBe(
      branch,
    );
  });

  it("requires explicit discard for uncommitted/failed cleanup and supports non-destructive archive", async () => {
    const fixture = await createFixture(
      async (writer) => {
        await writeFile(join(writer, "README.md"), "changed\n");
      },
      [{ path: "README.md", status: "modified" }],
    );
    const result = await prepare(fixture);
    expect(result.status).toBe("ready");
    await expect(
      cleanupDeliveryWorktree(result.worktree, {
        mode: "published",
        authorization: {
          kind: "docsfab-published-delivery-cleanup-authorization",
        },
      }),
    ).rejects.toMatchObject({ code: "cleanup-refused" });
    archiveDeliveryWorktree(result.worktree);
    expect(result.worktree.state).toBe("archived");
    expect((await stat(result.worktree.worktreePath)).isDirectory()).toBe(true);
    await expect(
      cleanupDeliveryWorktree(result.worktree, {
        mode: "operator-discard",
        authorization: { kind: "docsfab-delivery-discard-authorization" },
      }),
    ).rejects.toMatchObject({ code: "cleanup-refused" });
    const discard = await authorizeDeliveryDiscard({
      worktree: result.worktree,
      confirmedPlanSha256: fixture.plan.sha256,
      confirmation: "discard-failed-or-uncommitted-delivery",
      reason: "Operator reviewed and discards this delivery.",
      deleteBranch: true,
    });
    await cleanupDeliveryWorktree(result.worktree, {
      mode: "operator-discard",
      authorization: discard,
    });
    expect(result.worktree.state).toBe("cleaned");
    await expect(stat(result.worktree.worktreePath)).rejects.toBeDefined();
    expect(
      await gitText(fixture.source, "branch", "--list", fixture.plan.proposedSourceBranch),
    ).toBe("");
  });

  it("cleans a committed delivery after publication while preserving its branch", async () => {
    const fixture = await createFixture(
      async (writer) => {
        await writeFile(join(writer, "README.md"), "published\n");
      },
      [{ path: "README.md", status: "modified" }],
    );
    const result = await prepare(fixture);
    expect(result.status).toBe("ready");
    await git(result.worktree.worktreePath, "add", "-A");
    await git(result.worktree.worktreePath, "commit", "-m", "delivery");
    const commit = await gitText(result.worktree.worktreePath, "rev-parse", "HEAD");
    const terminalCapability = makePublishedTerminalCapability(fixture, commit);
    expect(() =>
      authorizePublishedDeliveryCleanup({
        worktree: result.worktree,
        publicationAuthorization: fixture.authorization,
        terminalCapability: structuredClone(terminalCapability),
      }),
    ).toThrow(DeliveryWorktreeError);
    const cleanup = authorizePublishedDeliveryCleanup({
      worktree: result.worktree,
      publicationAuthorization: fixture.authorization,
      terminalCapability,
    });
    await cleanupDeliveryWorktree(result.worktree, {
      mode: "published",
      authorization: cleanup,
    });
    expect(result.worktree.state).toBe("cleaned");
    await expect(stat(result.worktree.capsulePath)).rejects.toBeDefined();
    expect(
      await gitText(fixture.source, "branch", "--list", fixture.plan.proposedSourceBranch),
    ).toContain(fixture.plan.proposedSourceBranch);
  });

  it("refuses published cleanup after the preserved patch is substituted", async () => {
    const fixture = await createFixture(async () => undefined, [], {
      runId: "published-patch-drift",
    });
    const result = await prepare(fixture);
    expect(result.status).toBe("ready");
    await git(result.worktree.worktreePath, "commit", "-m", "delivery");
    const commit = await gitText(result.worktree.worktreePath, "rev-parse", "HEAD");
    const cleanup = authorizePublishedDeliveryCleanup({
      worktree: result.worktree,
      publicationAuthorization: fixture.authorization,
      terminalCapability: makePublishedTerminalCapability(fixture, commit),
    });
    await writeFile(result.worktree.patchPath, "substituted after publication\n");
    await expect(
      cleanupDeliveryWorktree(result.worktree, {
        mode: "published",
        authorization: cleanup,
      }),
    ).rejects.toMatchObject({ code: "cleanup-refused" });
    expect((await stat(result.worktree.worktreePath)).isDirectory()).toBe(true);
  });

  it("uses the unforgeable host binding for cleanup targets", async () => {
    const fixture = await createFixture(async () => undefined, []);
    const result = await prepare(fixture);
    const actualWorktreePath = result.worktree.worktreePath;
    Object.assign(result.worktree, {
      repositoryPath: fixture.source,
      capsulePath: fixture.source,
      worktreePath: fixture.source,
      branch: "main",
      baseRevision: "f".repeat(40),
    });
    const discard = await authorizeDeliveryDiscard({
      worktree: result.worktree,
      confirmedPlanSha256: fixture.plan.sha256,
      confirmation: "discard-failed-or-uncommitted-delivery",
      reason: "Operator reviewed tamper-resistant cleanup.",
      deleteBranch: true,
    });
    await cleanupDeliveryWorktree(result.worktree, {
      mode: "operator-discard",
      authorization: discard,
    });
    expect((await stat(fixture.source)).isDirectory()).toBe(true);
    await expect(stat(actualWorktreePath)).rejects.toBeDefined();

    await expect(
      cleanupDeliveryWorktree(
        { ...result.worktree },
        {
          mode: "operator-discard",
          authorization: discard,
        },
      ),
    ).rejects.toMatchObject({ code: "cleanup-refused" });
  });

  it("rejects stale discard authority after branch drift and retries safely after partial cleanup", async () => {
    const staleFixture = await createFixture(async () => undefined, []);
    const staleResult = await prepare(staleFixture);
    const stale = await authorizeDeliveryDiscard({
      worktree: staleResult.worktree,
      confirmedPlanSha256: staleFixture.plan.sha256,
      confirmation: "discard-failed-or-uncommitted-delivery",
      reason: "Operator reviewed current branch before drift.",
      deleteBranch: true,
    });
    await git(staleResult.worktree.worktreePath, "switch", "-c", "drifted-branch");
    await expect(
      cleanupDeliveryWorktree(staleResult.worktree, {
        mode: "operator-discard",
        authorization: stale,
      }),
    ).rejects.toMatchObject({ code: "cleanup-refused" });

    const retryFixture = await createFixture(async () => undefined, []);
    const retryResult = await prepare(retryFixture);
    const retry = await authorizeDeliveryDiscard({
      worktree: retryResult.worktree,
      confirmedPlanSha256: retryFixture.plan.sha256,
      confirmation: "discard-failed-or-uncommitted-delivery",
      reason: "Operator reviewed retry-safe cleanup state.",
      deleteBranch: true,
    });
    await expect(
      cleanupDeliveryWorktree(
        retryResult.worktree,
        {
          mode: "operator-discard",
          authorization: retry,
        },
        new BranchDeleteOnceRunner(),
      ),
    ).rejects.toMatchObject({ code: "cleanup-failed" });
    await cleanupDeliveryWorktree(retryResult.worktree, {
      mode: "operator-discard",
      authorization: retry,
    });
    expect(retryResult.worktree.state).toBe("cleaned");
  }, 15_000);

  it("requires fresh discard authority after same-revision branch recreation during partial cleanup", async () => {
    const fixture = await createFixture(async () => undefined, []);
    const result = await prepare(fixture);
    const stale = await authorizeDeliveryDiscard({
      worktree: result.worktree,
      confirmedPlanSha256: fixture.plan.sha256,
      confirmation: "discard-failed-or-uncommitted-delivery",
      reason: "Operator reviewed branch before partial cleanup.",
      deleteBranch: true,
    });
    await expect(
      cleanupDeliveryWorktree(
        result.worktree,
        {
          mode: "operator-discard",
          authorization: stale,
        },
        new RecreateBranchAfterRemovalRunner(result.worktree.branch, fixture.revision),
      ),
    ).rejects.toMatchObject({ code: "cleanup-refused" });
    const fresh = await authorizeDeliveryDiscard({
      worktree: result.worktree,
      confirmedPlanSha256: fixture.plan.sha256,
      confirmation: "discard-failed-or-uncommitted-delivery",
      reason: "Operator reviewed recreated branch after partial cleanup.",
      deleteBranch: true,
    });
    await cleanupDeliveryWorktree(result.worktree, {
      mode: "operator-discard",
      authorization: fresh,
    });
    expect(result.worktree.state).toBe("cleaned");
  }, 15_000);

  it("keeps the model/harness boundary unchanged", async () => {
    // The harness's per-step reply admission lives beside it in
    // `reply-admission/`, so the boundary covers every module there too.
    const harnessDirectory = join(process.cwd(), "src", "harness");
    const admissionDirectory = join(harnessDirectory, "reply-admission");
    const sources = [
      join(harnessDirectory, "pi.ts"),
      ...(await readdir(admissionDirectory))
        .filter((name) => name.endsWith(".ts"))
        .sort()
        .map((name) => join(admissionDirectory, name)),
    ];
    expect(sources).toContain(join(admissionDirectory, "planner.ts"));
    for (const source of sources) {
      const harness = await readFile(source, "utf8");
      expect(harness, source).not.toMatch(
        /delivery\/worktree|prepareDeliveryWorktree|git worktree|glab/iu,
      );
    }
  });
});

class RecordingRunner implements DeliveryCommandRunner {
  public readonly calls: Array<{
    command: string;
    args: readonly string[];
    cwd: string;
    options?: {
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
      stdin?: Uint8Array;
    };
  }> = [];
  readonly #delegate = new ExecFileDeliveryCommandRunner();

  public run(
    command: string,
    args: readonly string[],
    cwd: string,
    options?: {
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
      stdin?: Uint8Array;
    },
  ): Promise<DeliveryCommandResult> {
    this.calls.push({ command, args: [...args], cwd, options });
    return this.#delegate.run(command, args, cwd, options);
  }
}

class ExpireAfterGitBoundaryRunner implements DeliveryCommandRunner {
  readonly #delegate = new ExecFileDeliveryCommandRunner();
  public readonly operations: string[][] = [];
  public expired = false;
  #catFiles = 0;

  public constructor(
    private readonly boundary: "read-tree" | "apply-cached" | "write-tree" | "tree-read",
    private readonly onExpire: () => void = () => undefined,
  ) {}

  public async run(
    command: string,
    args: readonly string[],
    cwd: string,
    options?: {
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
      stdin?: Uint8Array;
      maxOutputBytes?: number;
    },
  ): Promise<DeliveryCommandResult> {
    const operation = command === "git" ? [...stripSafeGitConfig(args)] : [command, ...args];
    this.operations.push(operation);
    const result = await this.#delegate.run(command, args, cwd, options);
    if (command !== "git" || result.exitCode !== 0 || this.expired) return result;
    if (this.boundary === "read-tree" && operation[0] === "worktree" && operation[1] === "add") {
      this.expire();
    } else if (
      this.boundary === "apply-cached" &&
      operation[0] === "apply" &&
      operation.includes("--check")
    ) {
      this.expire();
    } else if (
      this.boundary === "write-tree" &&
      operation[0] === "apply" &&
      !operation.includes("--check")
    ) {
      this.expire();
    } else if (
      this.boundary === "tree-read" &&
      operation[0] === "cat-file" &&
      ++this.#catFiles >= 1
    ) {
      this.expire();
    }
    return result;
  }

  private expire(): void {
    this.expired = true;
    this.onExpire();
  }
}

function boundaryAuthorization(plan: LocalUserPublicationPlan) {
  return authorizeLocalUserPublication({
    plan,
    confirmedPlanSha256: plan.sha256,
    command: "publish",
    currentTime: new Date("2026-08-04T12:00:00.000Z"),
    expiresAt: "2026-08-04T12:01:00.000Z",
  });
}

function boundaryClock(expired: () => boolean): () => Date {
  return () => new Date(expired() ? "2026-08-04T12:01:00.000Z" : "2026-08-04T12:00:30.000Z");
}

class MutatingValidationRunner implements DeliveryCommandRunner {
  readonly #delegate = new ExecFileDeliveryCommandRunner();
  #mutated = false;

  public constructor(private readonly source: string) {}

  public async run(
    command: string,
    args: readonly string[],
    cwd: string,
    options?: {
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
      stdin?: Uint8Array;
    },
  ): Promise<DeliveryCommandResult> {
    const result = await this.#delegate.run(command, args, cwd, options);
    if (command === "node" && !this.#mutated) {
      this.#mutated = true;
      await writeFile(join(this.source, "README.md"), "concurrent source mutation\n");
    }
    return result;
  }
}

class ConfigMutationRunner implements DeliveryCommandRunner {
  readonly #delegate = new ExecFileDeliveryCommandRunner();
  #mutated = false;

  public constructor(private readonly source: string) {}

  public async run(
    command: string,
    args: readonly string[],
    cwd: string,
    options?: {
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
      stdin?: Uint8Array;
    },
  ): Promise<DeliveryCommandResult> {
    const result = await this.#delegate.run(command, args, cwd, options);
    const gitArgs = stripSafeGitConfig(args);
    if (command === "git" && gitArgs[0] === "config" && !this.#mutated) {
      this.#mutated = true;
      await git(this.source, "config", "diff.race.textconv", "malicious-textconv");
    }
    return result;
  }
}

class DeliveryWorktreeConfigFilterRunner implements DeliveryCommandRunner {
  readonly #delegate = new ExecFileDeliveryCommandRunner();
  #injected = false;
  public constructor(private readonly marker: string) {}
  public async run(
    command: string,
    args: readonly string[],
    cwd: string,
    options?: {
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
      stdin?: Uint8Array;
    },
  ): Promise<DeliveryCommandResult> {
    const result = await this.#delegate.run(command, args, cwd, options);
    const operation = stripSafeGitConfig(args);
    if (
      command === "git" &&
      result.exitCode === 0 &&
      !this.#injected &&
      operation[0] === "worktree" &&
      operation[1] === "add"
    ) {
      this.#injected = true;
      const worktree = operation.at(-2)!;
      const gitFile = await readFile(join(worktree, ".git"), "utf8");
      const gitDirectory = gitFile.trim().slice("gitdir: ".length);
      await writeFile(
        join(gitDirectory, "config.worktree"),
        `[filter "attack"]\n\tclean = node -e \"require('node:fs').writeFileSync('${this.marker}','x')\"\n`,
      );
    }
    return result;
  }
}

class TransientFilterRunner implements DeliveryCommandRunner {
  readonly #delegate = new ExecFileDeliveryCommandRunner();
  readonly #configPath: string;

  public constructor(
    source: string,
    private readonly marker: string,
    private readonly externalWorktree: string,
  ) {
    this.#configPath = join(source, ".git", "config");
  }

  public async run(
    command: string,
    args: readonly string[],
    cwd: string,
    options?: {
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
      stdin?: Uint8Array;
      maxOutputBytes?: number;
    },
  ): Promise<DeliveryCommandResult> {
    const operation = stripSafeGitConfig(args);
    const inject =
      command === "git" &&
      ["worktree", "read-tree", "apply", "write-tree", "diff-tree", "ls-tree", "cat-file"].includes(
        operation[0] ?? "",
      );
    if (!inject) return this.#delegate.run(command, args, cwd, options);
    const original = await readFile(this.#configPath);
    const attack = Buffer.concat([
      original,
      Buffer.from(
        `\n[filter "attack"]\n\tclean = node -e "require('node:fs').writeFileSync('${this.marker}','x')"\n` +
          `[core]\n\tworktree = ${this.externalWorktree}\n`,
      ),
    ]);
    await writeFile(this.#configPath, attack);
    try {
      return await this.#delegate.run(command, args, cwd, options);
    } finally {
      await writeFile(this.#configPath, original);
    }
  }
}

class AddSuccessReturnedFailureRunner implements DeliveryCommandRunner {
  readonly #delegate = new ExecFileDeliveryCommandRunner();
  public async run(
    command: string,
    args: readonly string[],
    cwd: string,
    options?: {
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
      stdin?: Uint8Array;
    },
  ): Promise<DeliveryCommandResult> {
    const result = await this.#delegate.run(command, args, cwd, options);
    const operation = stripSafeGitConfig(args);
    return command === "git" &&
      result.exitCode === 0 &&
      operation[0] === "worktree" &&
      operation[1] === "add"
      ? { exitCode: 1, stdout: result.stdout }
      : result;
  }
}

class BranchOnlyAddFailureRunner implements DeliveryCommandRunner {
  readonly #delegate = new ExecFileDeliveryCommandRunner();
  public async run(
    command: string,
    args: readonly string[],
    cwd: string,
    options?: {
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
      stdin?: Uint8Array;
    },
  ): Promise<DeliveryCommandResult> {
    const operation = stripSafeGitConfig(args);
    if (command === "git" && operation[0] === "worktree" && operation[1] === "add") {
      const branchIndex = operation.indexOf("-b");
      await git(cwd, "branch", operation[branchIndex + 1]!, operation.at(-1)!);
      return { exitCode: 1, stdout: Buffer.alloc(0) };
    }
    return this.#delegate.run(command, args, cwd, options);
  }
}

class BranchDeleteConfigDriftRunner implements DeliveryCommandRunner {
  readonly #delegate = new ExecFileDeliveryCommandRunner();
  public async run(
    command: string,
    args: readonly string[],
    cwd: string,
    options?: {
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
      stdin?: Uint8Array;
    },
  ): Promise<DeliveryCommandResult> {
    const result = await this.#delegate.run(command, args, cwd, options);
    const operation = stripSafeGitConfig(args);
    if (command === "git" && operation[0] === "branch" && operation[1] === "-D") {
      await appendFile(join(cwd, ".git", "config"), "\n# concurrent benign drift\n");
    }
    return result;
  }
}

class PatchSwapRunner implements DeliveryCommandRunner {
  readonly #delegate = new ExecFileDeliveryCommandRunner();
  #swapped = false;

  public async run(
    command: string,
    args: readonly string[],
    cwd: string,
    options?: {
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
      stdin?: Uint8Array;
    },
  ): Promise<DeliveryCommandResult> {
    const result = await this.#delegate.run(command, args, cwd, options);
    if (command === "git" && args.includes("--check") && !this.#swapped) {
      this.#swapped = true;
      await writeFile(join(dirname(cwd), "verified.patch"), "substituted patch\n");
    }
    return result;
  }
}

class CapsuleSwapRunner implements DeliveryCommandRunner {
  readonly #delegate = new ExecFileDeliveryCommandRunner();
  #swapped = false;

  public async run(
    command: string,
    args: readonly string[],
    cwd: string,
    options?: {
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
      stdin?: Uint8Array;
    },
  ): Promise<DeliveryCommandResult> {
    const result = await this.#delegate.run(command, args, cwd, options);
    const gitArgs = stripSafeGitConfig(args);
    if (
      command === "git" &&
      gitArgs[0] === "worktree" &&
      gitArgs[1] === "add" &&
      result.exitCode === 0 &&
      !this.#swapped
    ) {
      this.#swapped = true;
      const worktree = gitArgs.at(-2)!;
      const capsule = dirname(worktree);
      await rename(capsule, `${capsule}.substituted`);
      await mkdir(capsule, { mode: 0o700 });
    }
    return result;
  }
}

function stripSafeGitConfig(args: readonly string[]): readonly string[] {
  let index = 0;
  while (args[index] === "-c" && args[index + 1] !== undefined) index += 2;
  return args.slice(index);
}

class SourceBoundaryMutationRunner implements DeliveryCommandRunner {
  readonly #delegate = new ExecFileDeliveryCommandRunner();
  #mutated = false;

  public constructor(private readonly source: string) {}

  public async run(
    command: string,
    args: readonly string[],
    cwd: string,
    options?: {
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
      stdin?: Uint8Array;
    },
  ): Promise<DeliveryCommandResult> {
    const result = await this.#delegate.run(command, args, cwd, options);
    if (command === "node" && !this.#mutated) {
      this.#mutated = true;
      await writeFile(join(this.source, "ignored.txt"), "changed ignored\n", {
        mode: 0o700,
      });
      await rm(join(this.source, "ignored-link"));
      await symlink("README.md", join(this.source, "ignored-link"));
      await git(this.source, "branch", "unrelated-reviewer-ref");
    }
    return result;
  }
}

class DeliveryIndexMutationRunner implements DeliveryCommandRunner {
  readonly #delegate = new ExecFileDeliveryCommandRunner();
  #mutated = false;

  public async run(
    command: string,
    args: readonly string[],
    cwd: string,
    options?: {
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
      stdin?: Uint8Array;
      maxOutputBytes?: number;
    },
  ): Promise<DeliveryCommandResult> {
    const result = await this.#delegate.run(command, args, cwd, options);
    if (command === "node" && result.exitCode === 0 && !this.#mutated) {
      this.#mutated = true;
      const gitFile = await readFile(join(cwd, ".git"), "utf8");
      const match = /^gitdir: (.+)\n?$/u.exec(gitFile);
      if (!match) throw new Error("Expected linked-worktree gitfile.");
      await appendFile(join(match[1]!, "index"), Buffer.from([0]));
    }
    return result;
  }
}

class BranchDeleteOnceRunner implements DeliveryCommandRunner {
  readonly #delegate = new ExecFileDeliveryCommandRunner();
  #failed = false;

  public run(
    command: string,
    args: readonly string[],
    cwd: string,
    options?: {
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
      stdin?: Uint8Array;
    },
  ): Promise<DeliveryCommandResult> {
    const gitArgs = stripSafeGitConfig(args);
    if (command === "git" && !this.#failed && gitArgs[0] === "branch" && gitArgs[1] === "-D") {
      this.#failed = true;
      return Promise.resolve({ exitCode: 1, stdout: Buffer.alloc(0) });
    }
    return this.#delegate.run(command, args, cwd, options);
  }
}

class RecreateBranchAfterRemovalRunner implements DeliveryCommandRunner {
  readonly #delegate = new ExecFileDeliveryCommandRunner();
  #recreated = false;

  public constructor(
    private readonly branch: string,
    private readonly revision: string,
  ) {}

  public async run(
    command: string,
    args: readonly string[],
    cwd: string,
    options?: {
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
      stdin?: Uint8Array;
    },
  ): Promise<DeliveryCommandResult> {
    const result = await this.#delegate.run(command, args, cwd, options);
    const gitArgs = stripSafeGitConfig(args);
    if (
      command === "git" &&
      result.exitCode === 0 &&
      !this.#recreated &&
      gitArgs[0] === "worktree" &&
      gitArgs[1] === "remove"
    ) {
      this.#recreated = true;
      await git(cwd, "update-ref", "-d", `refs/heads/${this.branch}`);
      await git(cwd, "update-ref", `refs/heads/${this.branch}`, this.revision);
    }
    return result;
  }
}

async function createFixture(
  change: (writer: string) => Promise<void>,
  files: ChangedFileEvidence[],
  options: {
    runId?: string;
    validationCommand?: string;
    authorityBasis?: LocalUserPublicationPlan["authorityBasis"];
    documentationValidation?: LocalUserPublicationPlan["documentationValidation"];
    corruptContext?: boolean;
    existingRoot?: string;
    source?: string;
    extraValidationScript?: (source: string, root: string) => Promise<void>;
    objectFormat?: "sha256";
  } = {},
): Promise<Fixture> {
  const root = options.existingRoot ?? (await mkdtemp(join(tmpdir(), "docsfab-worktree-test-")));
  if (!options.existingRoot) temporaryDirectories.push(root);
  const runId = options.runId ?? "run-1";
  const source = options.source ?? join(root, "source");
  const deliveryRoot = join(root, "deliveries");
  const state = join(root, `state-${runId}`);
  if (!options.source) {
    await mkdir(source);
    await git(
      source,
      "init",
      ...(options.objectFormat ? [`--object-format=${options.objectFormat}`] : []),
      "-b",
      "main",
    );
    await git(source, "config", "user.name", "Maintainer");
    await git(source, "config", "user.email", "maintainer@example.test");
    await git(source, "config", "commit.gpgsign", "false");
    await writeFile(join(source, "README.md"), "original\n");
    await writeFile(join(source, "delete.txt"), "delete me\n");
    await writeFile(join(source, "rename.txt"), "rename me\n");
    await writeFile(join(source, "copy.txt"), "copy me\n");
    await writeFile(join(source, "validate.cjs"), "process.exit(0);\n");
    await writeFile(join(source, "fail.cjs"), "process.exit(7);\n");
    await writeFile(
      join(source, "mutate.cjs"),
      "require('node:fs').writeFileSync('README.md', 'validation mutation\\n');\n",
    );
    await writeFile(join(source, ".gitignore"), "ignored.txt\nignored-link\nignored-target.txt\n");
    await writeFile(join(source, ".gitattributes"), "*.md filter=attack\n");
    await writeFile(
      join(source, "rewrite-added.cjs"),
      "require('node:fs').writeFileSync('added.txt', 'SUBSTITUTED\\n');\n",
    );
    await writeFile(
      join(source, "escape-source.cjs"),
      "require('node:fs').writeFileSync('../../../source/ignored.txt', 'ESCAPED\\n');\n",
    );
    await options.extraValidationScript?.(source, root);
    await git(source, "add", "-A");
    await git(source, "commit", "-m", "base");
    await git(source, "remote", "add", "origin", "https://gitlab.example.test/group/docs.git");
  }
  const revision = await gitText(source, "rev-parse", "HEAD");
  const writer = join(root, `writer-${runId}`);
  await git(source, "worktree", "add", "--detach", writer, revision);
  await change(writer);
  await git(writer, "add", "-A");
  let effectiveFiles = files;
  if (
    (await gitBuffer(writer, "diff", "--cached", "--binary", "--full-index", "--")).byteLength === 0
  ) {
    await writeFile(join(writer, "README.md"), "default delivery\n");
    await git(writer, "add", "README.md");
    effectiveFiles = [{ path: "README.md", status: "modified" }];
  }
  let patch = await gitBuffer(
    writer,
    "diff",
    "--cached",
    "--binary",
    "--full-index",
    "--find-renames",
    "--find-copies",
    "--find-copies-harder",
    "--",
  );
  if (options.corruptContext && patch.byteLength > 0) {
    patch = Buffer.from(patch.toString("utf8").replace("-original", "-not-the-base"));
  }
  await git(source, "worktree", "remove", "--force", writer);
  await mkdir(deliveryRoot, { recursive: true, mode: 0o700 });
  await chmod(deliveryRoot, 0o700);
  await mkdir(state, { mode: 0o700 });
  const patchPath = join(state, `${runId}.patch`);
  await writeFile(patchPath, patch, { mode: 0o600 });
  const recordPath = join(state, `${runId}.json`);
  const recordBytes = Buffer.from(
    `${JSON.stringify({
      schemaVersion: 2,
      id: runId,
      workflow: "site-bootstrap",
      repository: { sourcePath: source, requestedRevision: "HEAD", revision },
      workspace: { strategy: "tracked-export", disposable: true },
      task: {
        kind: "site-bootstrap",
        plan: {
          kind: "ia-plan",
          schemaVersion: 1,
          digest: "a".repeat(64),
          repositoryRevision: revision,
          repositoryContentDigest: "b".repeat(64),
        },
      },
      status: "succeeded",
      createdAt: "2026-08-04T00:00:00.000Z",
      startedAt: "2026-08-04T00:00:01.000Z",
      completedAt: "2026-08-04T00:00:02.000Z",
      durationMs: 1000,
      models: [],
      skills: [],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        turns: 0,
      },
      tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
      securityScan: {
        ruleSet: "credential-rules-v1",
        status: "passed",
        scannedFiles: 1,
        binaryFiles: 0,
        findings: [],
      },
      securityScanEffectiveDisposition: { status: "passed" },
      artifacts: [
        {
          role: "input",
          stepId: "apply-site-bootstrap",
          reference: {
            kind: "ia-plan",
            schemaVersion: 1,
            digest: "a".repeat(64),
            repositoryRevision: revision,
            repositoryContentDigest: "b".repeat(64),
          },
        },
      ],
      steps: [
        {
          id: "apply-site-bootstrap",
          title: "Apply approved site bootstrap",
          kind: "host-operation",
          operation: "site-bootstrap",
          skill: "template-scaffold-site",
          mode: "write",
          status: "succeeded",
          startedAt: "2026-08-04T00:00:01.000Z",
          completedAt: "2026-08-04T00:00:02.000Z",
          durationMs: 1000,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
            turns: 0,
          },
          tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
          contextPreflight: {
            status: "ready",
            packetDigest: "c".repeat(64),
            consultedNodeIds: ["node-a"],
            ontologyVersion: "ontology-v1",
            effectiveDecisionIds: [],
            measurements: {
              byteLength: 1,
              estimatedTokens: 1,
              latencyMs: 0,
              nodeCount: 1,
              edgeCount: 0,
              pathCount: 1,
            },
            cache: {
              disposition: "miss",
              keyDigest: "d".repeat(64),
              rebuildAttempted: true,
            },
          },
          artifacts: [
            {
              role: "input",
              stepId: "apply-site-bootstrap",
              reference: {
                kind: "ia-plan",
                schemaVersion: 1,
                digest: "a".repeat(64),
                repositoryRevision: revision,
                repositoryContentDigest: "b".repeat(64),
              },
            },
          ],
          summary: "Applied approved site plan.",
        },
      ],
      changes: {
        files: effectiveFiles,
        patch: {
          sha256: createHash("sha256").update(patch).digest("hex"),
          byteLength: patch.byteLength,
          lineCount: patch.byteLength === 0 ? 0 : patch.toString("utf8").split("\n").length - 1,
          artifactPath: patchPath,
          format: "git-diff",
        },
      },
    })}\n`,
  );
  await writeFile(recordPath, recordBytes, { mode: 0o600 });
  const plan = makePlan({
    runId,
    recordSha256: createHash("sha256").update(recordBytes).digest("hex"),
    revision,
    patch,
    changedFileCount: effectiveFiles.length,
    validationCommand: options.validationCommand ?? "node validate.cjs",
    authorityBasis: options.authorityBasis,
    documentationValidation: options.documentationValidation,
  });
  return {
    root,
    source,
    deliveryRoot,
    recordPath,
    patchPath,
    revision,
    plan,
    authorization: authorize(plan),
  };
}

function makePlan(input: {
  runId: string;
  recordSha256: string;
  revision: string;
  patch: Buffer;
  changedFileCount: number;
  validationCommand: string;
  authorityBasis?: LocalUserPublicationPlan["authorityBasis"];
  documentationValidation?: LocalUserPublicationPlan["documentationValidation"];
}): LocalUserPublicationPlan {
  const common = {
    kind: "docsfab-local-user-gitlab-publication-plan",
    deliveryMode: "local-user",
    authorityBasis: input.authorityBasis ?? "interactive-once",
    run: { id: input.runId, recordSha256: input.recordSha256 },
    project: { id: 42, host: "gitlab.example.test", path: "group/docs" },
    remote: { name: "origin", transport: "https" },
    identity: {
      git: "configured",
      gitIdentitySha256: localUserGitIdentitySha256("Maintainer", "maintainer@example.test"),
      gitlabUsername: "maintainer",
    },
    baseRevision: input.revision,
    targetBranch: { name: "main", protected: true },
    proposedSourceBranch: deterministicLocalUserSourceBranch(
      input.runId,
      input.revision,
      input.recordSha256,
      createHash("sha256").update(input.patch).digest("hex"),
    ),
    patch: {
      format: "git-diff",
      sha256: createHash("sha256").update(input.patch).digest("hex"),
      byteLength: input.patch.byteLength,
      changedFileCount: input.changedFileCount,
    },
    validationCommand: input.validationCommand,
    mergeRequest: { draft: true },
    fallback: { mode: "patch-only", preserved: true },
    checks: {
      repository: "passed",
      remote: "passed",
      revision: "current",
      gitIdentity: "configured",
      gitlabAuthentication: "authenticated",
      pushAccess: "allowed",
      sourceBranch: "unprotected",
    },
    sha256: "",
  } as const;
  return input.documentationValidation?.schemaVersion === 2
    ? redigest({
        ...common,
        schemaVersion: 2,
        documentationValidation: input.documentationValidation,
      })
    : redigest({
        ...common,
        schemaVersion: 1,
        ...(input.documentationValidation
          ? { documentationValidation: input.documentationValidation }
          : {}),
      });
}

function makePublishedTerminalCapability(fixture: Fixture, commitRevision: string) {
  const times = Array.from({ length: 6 }, (_value, index) =>
    new Date(Date.parse("2026-08-04T01:00:00.000Z") + index * 1000).toISOString(),
  );
  let record = createScmDeliveryRecord({
    plan: fixture.plan,
    authorization: fixture.authorization,
    createdAt: times[0]!,
  });
  const progress = (next: Parameters<typeof recordScmDeliveryProgress>[1]): void => {
    record = recordScmDeliveryProgress(record, next, fixture.plan, fixture.authorization);
  };
  progress({
    toState: "prepared",
    source: "executed",
    at: times[1]!,
    evidence: {
      workspaceKey: "e".repeat(64),
      baseRevision: fixture.plan.baseRevision,
    },
  });
  progress({
    toState: "validated",
    source: "executed",
    at: times[2]!,
    evidence: {
      commandSha256: createHash("sha256").update(fixture.plan.validationCommand).digest("hex"),
      summarySha256: "f".repeat(64),
      checkCount: 1,
    },
  });
  progress({
    toState: "committed",
    source: "executed",
    at: times[3]!,
    evidence: {
      sha: commitRevision,
    },
  });
  progress({
    toState: "pushed",
    source: "executed",
    at: times[4]!,
    evidence: {
      remoteRevision: commitRevision,
    },
  });
  progress({
    toState: "opened",
    source: "executed",
    at: times[5]!,
    evidence: {
      iid: 17,
      url: canonicalMergeRequestUrl(record, 17),
      state: "opened",
      draft: true,
      sourceBranch: fixture.plan.proposedSourceBranch,
      targetBranch: fixture.plan.targetBranch.name,
      headRevision: commitRevision,
    },
  });
  const observation = {
    schemaVersion: 1 as const,
    kind: "docsfab-scm-delivery-observation" as const,
    idempotencyKey: record.idempotencyKey,
    planSha256: record.planSha256,
    authentication: "available" as const,
    worktree: "matching" as const,
    validation: "passed" as const,
    localCommit: { status: "matching" as const, revision: commitRevision },
    remoteBranch: { status: "matching" as const, revision: commitRevision },
    mergeRequest: {
      status: "opened" as const,
      iid: 17,
      url: canonicalMergeRequestUrl(record, 17),
      draft: true as const,
      sourceBranch: fixture.plan.proposedSourceBranch,
      targetBranch: fixture.plan.targetBranch.name,
      headRevision: commitRevision,
    },
  };
  return issueScmPublishedTerminalCapability({
    record,
    plan: fixture.plan,
    authorization: fixture.authorization,
    replay: {
      observation,
      confirmation: confirmScmDeliveryObservation({
        record,
        observation,
        plan: fixture.plan,
        authorization: fixture.authorization,
      }),
    },
  });
}

function redigest(plan: LocalUserPublicationPlan): LocalUserPublicationPlan {
  return { ...plan, sha256: localUserPublicationPlanSha256(plan) };
}

function authorize(plan: LocalUserPublicationPlan) {
  return authorizeLocalUserPublication({
    plan,
    confirmedPlanSha256: plan.sha256,
    command: "publish",
  });
}

/** Preparation input bound to `fixture`; `overrides` carries each test's distinct options. */
function prepareInput(
  fixture: Fixture,
  overrides: Partial<Parameters<typeof prepareDeliveryWorktree>[0]> = {},
): Parameters<typeof prepareDeliveryWorktree>[0] {
  return {
    plan: fixture.plan,
    authorization: fixture.authorization,
    runRecordPath: fixture.recordPath,
    repositoryPath: fixture.source,
    deliveryRoot: fixture.deliveryRoot,
    ...overrides,
  };
}

function prepare(fixture: Fixture, runner?: DeliveryCommandRunner) {
  return prepareDeliveryWorktree(prepareInput(fixture), runner, async () => ({
    commandPrefix: [],
  }));
}

async function upgradeFixtureToSourceAwareV2(
  fixture: Fixture,
  changedPaths: readonly {
    path: string;
    status: "added" | "modified" | "deleted" | "renamed" | "copied";
  }[],
) {
  const candidate = join(fixture.root, "source-aware-candidate");
  await git(fixture.source, "worktree", "add", "--detach", candidate, fixture.revision);
  await exec("git", ["apply", fixture.patchPath], { cwd: candidate });
  try {
    const candidateInputTreeSha256 = documentationCandidateInputTreeSha256({
      baseRevision: fixture.plan.baseRevision,
      patchSha256: fixture.plan.patch.sha256,
    });
    const applicability = await deriveDocumentationSourceApplicability({
      candidateRoot: candidate,
      repositoryIdentitySha256: documentationRepositoryIdentitySha256({
        host: fixture.plan.project.host,
        path: fixture.plan.project.path,
        projectId: fixture.plan.project.id,
      }),
      baseRevision: fixture.plan.baseRevision,
      candidateInputTreeSha256,
      changedPaths,
    });
    await storeDocumentationSourceApplicability(
      new DurableArtifactStore(resolve(dirname(fixture.recordPath), "..", "artifacts")),
      applicability,
    );
    const selected = selectDocumentationValidationProfile({
      workflow: "site-bootstrap",
      changedPaths: changedPaths.map(({ path }) => path),
      hostPolicySha256: validationBackendPolicySha256(),
      applicabilitySha256: applicability.applicabilitySha256,
    });
    fixture.plan = redigest({
      ...(fixture.plan as LocalUserPublicationPlanV2),
      schemaVersion: 2,
      validationCommand: selected.entrypointCommand,
      documentationValidation: selected.binding,
    });
    fixture.authorization = authorize(fixture.plan);
    return selected;
  } finally {
    await git(fixture.source, "worktree", "remove", "--force", candidate);
  }
}

async function completeSourceSnapshot(source: string): Promise<string> {
  const [head, branch, status, staged, unstaged, untracked] = await Promise.all([
    gitBuffer(source, "rev-parse", "HEAD"),
    gitBuffer(source, "symbolic-ref", "HEAD"),
    gitBuffer(source, "status", "--porcelain=v2", "-z", "--untracked-files=all"),
    gitBuffer(source, "diff", "--binary", "--cached", "HEAD", "--"),
    gitBuffer(source, "diff", "--binary", "--"),
    gitBuffer(source, "ls-files", "--others", "--exclude-standard", "-z"),
  ]);
  const paths = untracked.toString("utf8").split("\0").filter(Boolean).sort();
  const contents = await Promise.all(paths.map(async (path) => readFile(join(source, path))));
  return createHash("sha256")
    .update(Buffer.concat([head, branch, status, staged, unstaged, untracked, ...contents]))
    .digest("hex");
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec("git", args, { cwd, maxBuffer: MAX_BUFFER });
}

async function gitText(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", args, { cwd, maxBuffer: MAX_BUFFER })).stdout.trim();
}

async function gitBuffer(cwd: string, ...args: string[]): Promise<Buffer> {
  const result = await exec("git", args, {
    cwd,
    encoding: "buffer",
    maxBuffer: MAX_BUFFER,
  });
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
}

const MAX_BUFFER = 4 * 1024 * 1024;

/**
 * The real plan-side selection (`preflightLocalUserGitLabPublication`, which
 * binds the default documentation validation) feeding the real delivery-side
 * binding check (`inspectReadyDeliveryWorktree`). Git runs for real; only the
 * GitLab API answers are fixed.
 */
class SeamGitLabCommands implements ReadOnlyCommandRunner {
  private readonly git = new ExecFileReadOnlyCommandRunner();

  public constructor(private readonly targetRevision: string) {}

  public async run(
    command: "git" | "glab" | "gh",
    args: readonly string[],
    cwd: string,
    options?: { env?: NodeJS.ProcessEnv },
  ): Promise<ReadOnlyCommandResult> {
    if (command === "gh") throw new Error("GitLab fixture does not support gh.");
    if (command === "git") return this.git.run(command, args, cwd, options);
    const key = args.join(" ");
    const host = "gitlab.example.test";
    const json = (value: unknown): ReadOnlyCommandResult => ({
      exitCode: 0,
      stdout: `${JSON.stringify(value)}\n`,
    });
    if (key === "version") return { exitCode: 0, stdout: "glab 1.0\n" };
    if (key === `auth status --hostname ${host}`) return { exitCode: 0, stdout: "" };
    if (key === `config get token --host ${host}`) return { exitCode: 0, stdout: "" };
    if (key === `api --hostname ${host} user`) {
      return json({ username: "maintainer", name: "Maintainer", email: "maintainer@example.test" });
    }
    if (args[0] === "api" && args[3] === "graphql") {
      return json({ data: { project: { id: "gid://gitlab/Project/42", fullPath: "group/docs" } } });
    }
    if (key === `api --hostname ${host} projects/42`) {
      return json({
        id: 42,
        path_with_namespace: "group/docs",
        default_branch: "main",
        permissions: { project_access: { access_level: 40 }, group_access: null },
      });
    }
    if (key === `api --hostname ${host} projects/42/repository/branches/main`) {
      return json({ name: "main", protected: true, commit: { id: this.targetRevision } });
    }
    if (key === `api --hostname ${host} projects/42/protected_branches?per_page=100`) {
      return json([{ name: "main" }]);
    }
    return { exitCode: 1, stdout: "", stderr: "" };
  }
}

/** `SeamGitLabCommands` that also records each call, in order. */
class RecordingCommands extends SeamGitLabCommands {
  public readonly calls: Array<{ command: "git" | "glab" | "gh"; args: readonly string[] }> = [];

  public override async run(
    command: "git" | "glab" | "gh",
    args: readonly string[],
    cwd: string,
    options?: { env?: NodeJS.ProcessEnv },
  ): Promise<ReadOnlyCommandResult> {
    this.calls.push({ command, args: [...args] });
    return super.run(command, args, cwd, options);
  }
}

describe("documentation validation binding from preflight to delivery (#2359)", {
  timeout: HEAVY_SUITE_TIMEOUT_MS,
}, () => {
  const guide = "# Guide\n\nStart from the [overview](index.md).\n";

  async function seamFixture(options: { patchCheckout?: boolean; badBase?: boolean } = {}) {
    const fixture = await createFixture(
      async (writer) => {
        await writeFile(join(writer, "docs", "guide.md"), guide);
        if (options.badBase) await writeFile(join(writer, "README.md"), "changed\n");
      },
      [
        ...(options.badBase ? [{ path: "README.md", status: "modified" as const }] : []),
        { path: "docs/guide.md", status: "added" },
      ],
      {
        ...(options.badBase ? { corruptContext: true } : {}),
        extraValidationScript: async (source) => {
          await mkdir(join(source, "docs"));
          await writeFile(join(source, "docs", "index.md"), "# Overview\n");
        },
      },
    );
    // Live-agent publication applies the saved patch to the checkout first.
    if (options.patchCheckout) await writeFile(join(fixture.source, "docs", "guide.md"), guide);
    return fixture;
  }

  function realPreflight(fixture: Fixture) {
    return preflightLocalUserGitLabPublication(
      {
        runId: "run-1",
        runRecordPath: fixture.recordPath,
        repositoryPath: fixture.source,
        draftMergeRequest: true,
      },
      new SeamGitLabCommands(fixture.revision),
    );
  }

  async function prepareAndInspect(fixture: Fixture, plan: LocalUserPublicationPlan) {
    const prepared = await prepareDeliveryWorktree(
      prepareInput(fixture, { plan, authorization: authorize(plan) }),
      undefined,
      async () => ({ commandPrefix: [] }),
    );
    expect(prepared.status, prepared.status === "failed" ? prepared.code : undefined).toBe("ready");
    if (prepared.status !== "ready") throw new Error("delivery worktree was not ready");
    return inspectReadyDeliveryWorktree(prepared.worktree);
  }

  /**
   * The copies under the state root. The directory must exist: preflight
   * creates it there, so a copy built anywhere else fails here instead of
   * reading as none.
   */
  async function candidateCopies(fixture: Fixture): Promise<string[]> {
    return readdir(join(fixture.root, "validation-candidates"));
  }

  function candidateInput(fixture: Fixture, patchBytes: Buffer) {
    return {
      repositoryPath: fixture.source,
      baseRevision: fixture.revision,
      patchBytes,
      parentDirectory: join(fixture.root, "validation-candidates"),
    };
  }

  function expectBinding(
    plan: LocalUserPublicationPlan,
    attestation: Awaited<ReturnType<typeof inspectReadyDeliveryWorktree>>,
  ) {
    const binding = plan.documentationValidation;
    expect(binding?.schemaVersion).toBe(2);
    expect(attestation.validation.applicabilitySha256).toBe(
      binding?.schemaVersion === 2 ? binding.applicabilitySha256 : undefined,
    );
  }

  it("delivers what preflight binds when the checkout lacks the patch (candidate tree)", async () => {
    const fixture = await seamFixture();
    const plan = await realPreflight(fixture);
    expect(plan.validationCommand).toBe(DOCUMENTATION_VALIDATION_ENTRYPOINT_COMMAND);
    const binding = plan.documentationValidation;
    expect(binding?.schemaVersion).toBe(2);
    const attestation = await prepareAndInspect(fixture, plan);
    expect(attestation.validation.profileId).toBe(binding?.profileId);
    expect(attestation.validation.applicabilitySha256).toBe(
      binding?.schemaVersion === 2 ? binding.applicabilitySha256 : undefined,
    );
    // The operator checkout never received the page, and no private copy remains.
    await expect(stat(join(fixture.source, "docs", "guide.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await candidateCopies(fixture)).toEqual([]);
  });

  it("delivers what preflight binds when the checkout already holds the patch (shared digests)", async () => {
    const fixture = await seamFixture({ patchCheckout: true });
    const plan = await realPreflight(fixture);
    const binding = plan.documentationValidation;
    expect(binding?.schemaVersion).toBe(2);
    const attestation = await prepareAndInspect(fixture, plan);
    expect(attestation.validation.selectorInputSha256).toBe(binding?.selectorInputSha256);
    expect(await candidateCopies(fixture)).toEqual([]);
  });

  it("refuses at delivery a binding derived over the unpatched checkout (negative control)", async () => {
    const fixture = await seamFixture();
    // The pre-#2359 tree with the shared digests, so only the candidate tree differs.
    const changedPaths = [{ path: "docs/guide.md", status: "added" as const }];
    const applicability = await deriveDocumentationSourceApplicability({
      candidateRoot: fixture.source,
      repositoryIdentitySha256: documentationRepositoryIdentitySha256({
        host: fixture.plan.project.host,
        path: fixture.plan.project.path,
        projectId: fixture.plan.project.id,
      }),
      baseRevision: fixture.plan.baseRevision,
      candidateInputTreeSha256: documentationCandidateInputTreeSha256({
        baseRevision: fixture.plan.baseRevision,
        patchSha256: fixture.plan.patch.sha256,
      }),
      changedPaths,
    });
    await storeDocumentationSourceApplicability(
      new DurableArtifactStore(resolve(dirname(fixture.recordPath), "..", "artifacts")),
      applicability,
    );
    const selected = selectDocumentationValidationProfile({
      workflow: "site-bootstrap",
      changedPaths: changedPaths.map(({ path }) => path),
      hostPolicySha256: validationBackendPolicySha256(),
      applicabilitySha256: applicability.applicabilitySha256,
    });
    const plan = redigest({
      ...(fixture.plan as LocalUserPublicationPlanV2),
      schemaVersion: 2,
      validationCommand: selected.entrypointCommand,
      documentationValidation: selected.binding,
    });
    await expect(prepareAndInspect(fixture, plan)).rejects.toMatchObject({
      code: "invalid-delivery-input",
    });
  });

  it("checks out raw blobs whatever the tree's attributes ask for (eol=crlf, ident)", async () => {
    const fixture = await createFixture(
      async (writer) => {
        await writeFile(join(writer, "docs", "guide.md"), guide);
      },
      [{ path: "docs/guide.md", status: "added" }],
      {
        extraValidationScript: async (source) => {
          await writeFile(join(source, ".gitattributes"), "*.md text eol=crlf ident\n");
          await mkdir(join(source, "docs"));
          await writeFile(join(source, "docs", "index.md"), "# Overview\n\n$Id$\n");
        },
      },
    );
    const plan = await realPreflight(fixture);
    expectBinding(plan, await prepareAndInspect(fixture, plan));
    expect(await candidateCopies(fixture)).toEqual([]);
  });

  it("builds the copy when the repository path holds a ':'", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-colon:path-"));
    temporaryDirectories.push(root);
    const fixture = await createFixture(
      async (writer) => {
        await writeFile(join(writer, "docs", "guide.md"), guide);
      },
      [{ path: "docs/guide.md", status: "added" }],
      {
        existingRoot: root,
        extraValidationScript: async (source) => {
          await mkdir(join(source, "docs"));
          await writeFile(join(source, "docs", "index.md"), "# Overview\n");
        },
      },
    );
    expect(fixture.source).toContain(":");
    const plan = await realPreflight(fixture);
    expectBinding(plan, await prepareAndInspect(fixture, plan));
    expect(await candidateCopies(fixture)).toEqual([]);
  });

  it("refuses with validation-candidate-unavailable when the copy cannot be built", async () => {
    const fixture = await seamFixture();
    // A file where the copies' directory belongs: no copy can be built there.
    await writeFile(join(fixture.root, "validation-candidates"), "not a directory\n");
    await expect(realPreflight(fixture)).rejects.toMatchObject({
      code: "validation-candidate-unavailable",
    });
  });

  it("refuses with the checkout limit when checking out the copy outlives it", async () => {
    const fixture = await seamFixture();
    vi.stubEnv("DOCSFAB_DELIVERY_VALIDATION_CANDIDATE_CHECKOUT_TIMEOUT_MS", "200");
    const real = new ExecFileDeliveryCommandRunner();
    const timeouts: (number | undefined)[] = [];
    // The real runner kills a command at its timeout and reports exit 1.
    const slowCheckout: DeliveryCommandRunner = {
      run: async (command, args, cwd, options) => {
        if (!args.includes("checkout-index")) return real.run(command, args, cwd, options);
        timeouts.push(options?.timeoutMs);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
        return { exitCode: 1, stdout: Buffer.alloc(0) };
      },
    };
    try {
      await expect(
        withDocumentationValidationCandidate(
          candidateInput(fixture, await readFile(fixture.patchPath)),
          async () => "unreachable",
          slowCheckout,
        ),
      ).rejects.toMatchObject({ code: "delivery-validation-candidate-checkout-timeout-ms-bound" });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(timeouts).toEqual([200]);
    expect(await candidateCopies(fixture)).toEqual([]);
  });

  it("leaves a copy it did not create in place", async () => {
    const fixture = await seamFixture();
    const leftover = join(fixture.root, "validation-candidates", "candidate-left-behind");
    await mkdir(join(leftover, "repository"), { recursive: true });
    await writeFile(join(leftover, "repository", "page.md"), "an interrupted copy\n");
    const plan = await realPreflight(fixture);
    expectBinding(plan, await prepareAndInspect(fixture, plan));
    expect(await candidateCopies(fixture)).toEqual(["candidate-left-behind"]);
    expect(await readFile(join(leftover, "repository", "page.md"), "utf8")).toBe(
      "an interrupted copy\n",
    );
  });

  it("refuses a symbolic link where the copies' directory belongs and never follows it", async () => {
    const fixture = await seamFixture();
    const elsewhere = join(fixture.root, "elsewhere");
    await mkdir(join(elsewhere, "candidate-notes"), { recursive: true });
    await writeFile(join(elsewhere, "candidate-notes", "important.md"), "keep me\n");
    await symlink(elsewhere, join(fixture.root, "validation-candidates"));
    await expect(realPreflight(fixture)).rejects.toMatchObject({
      code: "validation-candidate-unavailable",
    });
    expect(await readdir(elsewhere)).toEqual(["candidate-notes"]);
    expect(await readFile(join(elsewhere, "candidate-notes", "important.md"), "utf8")).toBe(
      "keep me\n",
    );
  });

  it("refuses, rather than falls back, when git apply --check fails with exit status 128", async () => {
    const fixture = await seamFixture();
    vi.stubEnv("DOCSFAB_DELIVERY_VALIDATION_CANDIDATE_CHECKOUT_TIMEOUT_MS", "4321");
    const real = new ExecFileDeliveryCommandRunner();
    const checkTimeouts: (number | undefined)[] = [];
    // A fatal Git error is not a patch that does not apply (exit status 1).
    const fatalCheck: DeliveryCommandRunner = {
      run: async (command, args, cwd, options) => {
        if (!(args.includes("apply") && args.includes("--check"))) {
          return real.run(command, args, cwd, options);
        }
        checkTimeouts.push(options?.timeoutMs);
        return { exitCode: 128, stdout: Buffer.alloc(0) };
      },
    };
    try {
      await expect(
        preflightLocalUserGitLabPublication(
          {
            runId: "run-1",
            runRecordPath: fixture.recordPath,
            repositoryPath: fixture.source,
            draftMergeRequest: true,
          },
          new SeamGitLabCommands(fixture.revision),
          {},
          {
            validationCandidate: (input, action) =>
              withDocumentationValidationCandidate(input, action, fatalCheck),
          },
        ),
      ).rejects.toMatchObject({ code: "validation-candidate-unavailable" });
    } finally {
      vi.unstubAllEnvs();
    }
    // The check runs under the catalog limit, not the runner's default.
    expect(checkTimeouts).toEqual([4321]);
    expect(await candidateCopies(fixture)).toEqual([]);
  });

  it("leaves a patch that does not apply to delivery's patch-conflict and removes the private copy", async () => {
    const fixture = await seamFixture({ badBase: true });
    const plan = await realPreflight(fixture);
    expect(await candidateCopies(fixture)).toEqual([]);
    const prepared = await prepareDeliveryWorktree(
      prepareInput(fixture, { plan, authorization: authorize(plan) }),
      undefined,
      async () => ({ commandPrefix: [] }),
    );
    expect(prepared).toMatchObject({ status: "failed", code: "patch-conflict" });
  });
});

/**
 * A remote for the real host Git publisher that keeps everything local: every
 * Git command runs for real except `ls-remote` and `push`, which this records
 * against one simulated branch. The identity and configuration checks the
 * publisher runs before each mutation are real Git reads.
 */
class SimulatedRemoteGit implements GitPublisherCommandRunner {
  private readonly git = new ExecFileGitPublisherCommandRunner();
  public readonly branches = new Map<string, string>();
  public pushes = 0;
  /** While set, a push fails the way a rejected or unreachable remote does. */
  public failPushes = false;

  public async run(
    command: "git",
    args: readonly string[],
    cwd: string,
    options: Parameters<GitPublisherCommandRunner["run"]>[3],
  ): Promise<GitPublisherCommandResult> {
    let index = 0;
    while (args[index] === "-c") index += 2;
    const call = args.slice(index);
    if (call[0] === "ls-remote") {
      const ref = call.at(-1)!;
      const sha = this.branches.get(ref);
      return { exitCode: 0, stdout: Buffer.from(sha ? `${sha}\t${ref}\n` : "") };
    }
    if (call[0] === "push") {
      if (this.failPushes) return { exitCode: 1, stdout: Buffer.from("") };
      const [sha, ref] = call.at(-1)!.split(":");
      this.branches.set(ref!, sha!);
      this.pushes += 1;
      return { exitCode: 0, stdout: Buffer.from("") };
    }
    return this.git.run(command, args, cwd, options);
  }
}

describe("Git identity and configuration from preflight to the publisher (#2362, #2363)", {
  timeout: HEAVY_SUITE_TIMEOUT_MS,
}, () => {
  const guide = "# Guide\n\nStart from the [overview](index.md).\n";
  // SeamGitLabCommands serves the GitLab profile "Maintainer <maintainer@example.test>".
  const globalIdentity = "[user]\n\tname = Operator Global\n\temail = operator@example.test\n";

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /**
   * A checkout with no repository identity and an operator HOME whose global
   * Git configuration names someone other than the GitLab profile, as on most
   * workstations.
   */
  async function identityFixture() {
    const fixture = await createFixture(
      async (writer) => {
        await writeFile(join(writer, "docs", "guide.md"), guide);
      },
      [{ path: "docs/guide.md", status: "added" }],
      {
        extraValidationScript: async (source) => {
          await mkdir(join(source, "docs"));
          await writeFile(join(source, "docs", "index.md"), "# Overview\n");
        },
      },
    );
    await git(fixture.source, "config", "--unset", "user.name");
    await git(fixture.source, "config", "--unset", "user.email");
    // Each test names the signing settings it depends on (#2363); none is set by default.
    await git(fixture.source, "config", "--unset", "commit.gpgsign");
    const home = join(fixture.root, "operator-home");
    await mkdir(home, { mode: 0o700 });
    await writeFile(join(home, ".gitconfig"), globalIdentity);
    vi.stubEnv("HOME", home);
    return { fixture, home };
  }

  function realPreflight(
    fixture: Fixture,
    commands: ReadOnlyCommandRunner = new SeamGitLabCommands(fixture.revision),
  ) {
    return preflightLocalUserGitLabPublication(
      {
        runId: "run-1",
        runRecordPath: fixture.recordPath,
        repositoryPath: fixture.source,
        draftMergeRequest: true,
      },
      commands,
    );
  }

  /** Real preflight, real worktree preparation and inspection, then the real publisher. */
  async function deliver(
    fixture: Fixture,
    plan: LocalUserPublicationPlan,
    options: { defaultGit?: boolean } = {},
  ) {
    const authorization = authorize(plan);
    const run = await loadVerifiedPublicationRun(fixture.recordPath, plan.run.id);
    const remote = new SimulatedRemoteGit();
    const requests: GitLabMergeRequest[] = [];
    const gitlab: GitLabPublisherAdapter = {
      inspectPolicy: async () => ({
        username: "maintainer",
        projectId: plan.project.id,
        projectPath: plan.project.path,
        accessLevel: 40,
        defaultBranch: "main",
        targetBranch: { name: "main", protected: true, revision: plan.baseRevision },
        sourceBranchProtected: false,
      }),
      findMergeRequests: async () => [...requests],
      openDraftMergeRequest: async (input) => {
        const request: GitLabMergeRequest = {
          iid: requests.length + 1,
          url: `https://gitlab.example.test/group/docs/-/merge_requests/${requests.length + 1}`,
          state: "opened",
          draft: true,
          sourceBranch: input.plan.proposedSourceBranch,
          targetBranch: input.plan.targetBranch.name,
          headRevision: input.headRevision,
          sourceProjectId: input.plan.project.id,
          targetProjectId: input.plan.project.id,
          title: input.title,
          description: input.description,
        };
        requests.push(request);
        return request;
      },
    };
    let stored: ScmDeliveryRecord | undefined;
    const receiptStore: ScmDeliveryReceiptStore = {
      load: async () => stored,
      claim: async (record) => {
        const created = stored === undefined;
        stored ??= record;
        return { record: stored, created };
      },
      compareAndSwap: async (expected, record) => {
        if (!stored || stored.sha256 !== expected) throw new Error("receipt conflict");
        stored = record;
        return record;
      },
    };
    /**
     * One publication attempt as publish-execute runs it: prepare and inspect
     * a delivery worktree, then publish with a host publisher that commits as
     * the identity resolved from the same environment its Git runs with.
     */
    async function attempt(
      deliveryRoot: string,
      sourceBranchMode?: "create-or-reuse" | "reuse-existing" | "rehydrate-published",
      expectedSourceRevision?: string,
    ) {
      const prepared = await prepareDeliveryWorktree(
        prepareInput(fixture, {
          plan,
          authorization,
          deliveryRoot,
          ...(sourceBranchMode ? { sourceBranchMode } : {}),
          ...(expectedSourceRevision ? { expectedSourceRevision } : {}),
        }),
        undefined,
        async () => ({ commandPrefix: [] }),
      );
      expect(prepared.status, prepared.status === "failed" ? prepared.code : undefined).toBe(
        "ready",
      );
      if (prepared.status !== "ready") throw new Error("delivery worktree was not ready");
      const readyAttestation = await inspectReadyDeliveryWorktree(prepared.worktree);
      return async () => {
        const identity = await resolveLocalUserGitIdentity(
          new SeamGitLabCommands(fixture.revision),
          fixture.source,
          plan.project.host,
          undefined,
          process.env,
        );
        return publishLocalUserGitLab(
          {
            plan,
            authorization,
            worktree: prepared.worktree,
            readyAttestation,
            receiptStore,
            workflowOutcome: run.workflowOutcome,
            changedPaths: run.changedFiles.map((file) => file.path),
          },
          options.defaultGit
            ? // The publisher the host builds when the caller supplies none.
              { gitlab }
            : {
                git: new DeterministicLocalGitPublisher(
                  remote,
                  {
                    ...process.env,
                    GIT_AUTHOR_NAME: identity.name,
                    GIT_AUTHOR_EMAIL: identity.email,
                    GIT_COMMITTER_NAME: identity.name,
                    GIT_COMMITTER_EMAIL: identity.email,
                  },
                  // As publish-execute builds it: the source checkout counts as repository content.
                  { repositoryRoots: [prepared.worktree.repositoryPath] },
                ),
                gitlab,
              },
        );
      };
    }
    const publish = await attempt(fixture.deliveryRoot);
    let retries = 0;
    /**
     * A retried publish after the operator changed the checkout: like
     * publish-execute, it prepares and inspects a fresh detached recovery
     * worktree, and the same receipt carries the publication.
     */
    const retry = () =>
      attempt(join(fixture.root, `retry-delivery-${++retries}`), "reuse-existing");
    /**
     * A retried publish after DocsFab committed: publish-execute rehydrates the
     * committed branch from the receipt's exact commit into a fresh worktree.
     */
    const retryCommitted = () =>
      attempt(
        join(fixture.root, `retry-delivery-${++retries}`),
        "rehydrate-published",
        stored?.evidence.commit?.sha,
      );
    return { publish, retry, retryCommitted, remote, requests, receipt: () => stored };
  }

  it("binds and commits a global identity that differs from the GitLab profile", async () => {
    const { fixture } = await identityFixture();
    const plan = await realPreflight(fixture);
    const { publish, remote, requests } = await deliver(fixture, plan);
    const result = await publish();
    // Before #2362 this publication stopped with remote-drift.
    expect(result.status, result.status === "failed" ? result.code : undefined).toBe("opened");
    expect(requests).toHaveLength(1);
    expect(plan.identity.gitIdentitySha256).toBe(
      localUserGitIdentitySha256("Operator Global", "operator@example.test"),
    );
    const head = remote.branches.get(`refs/heads/${plan.proposedSourceBranch}`);
    expect(await gitText(fixture.source, "show", "-s", "--format=%an <%ae>", head!)).toBe(
      "Operator Global <operator@example.test>",
    );
  });

  it("refuses an identity changed after the plan as git-identity-drift, then publishes once it is restored", async () => {
    const { fixture, home } = await identityFixture();
    const plan = await realPreflight(fixture);
    const { publish, remote, requests } = await deliver(fixture, plan);
    await writeFile(
      join(home, ".gitconfig"),
      "[user]\n\tname = Someone Else\n\temail = operator@example.test\n",
    );
    const drifted = await publish();
    expect(drifted).toMatchObject({
      status: "failed",
      code: "git-identity-drift",
      nextAction: "restore-git-identity",
    });
    expect(remote.pushes).toBe(0);
    expect(requests).toHaveLength(0);
    // Positive control: the restored identity lets the same publication proceed.
    await writeFile(join(home, ".gitconfig"), globalIdentity);
    const restored = await publish();
    expect(restored.status, restored.status === "failed" ? restored.code : undefined).toBe(
      "opened",
    );
    expect(requests).toHaveLength(1);
  });

  it("still refuses executable checkout configuration before reading an identity", async () => {
    const { fixture } = await identityFixture();
    const isIdentityRead = (call: { args: readonly string[] }) =>
      call.args.at(-2) === "--get" && ["user.name", "user.email"].includes(call.args.at(-1) ?? "");
    // Positive control: preflight of a clean checkout reads the identity, and only
    // after the check that refuses executable configuration.
    const clean = new RecordingCommands(fixture.revision);
    await realPreflight(fixture, clean);
    const check = clean.calls.findIndex(
      (call) => call.args.includes("--local") && call.args.includes("--list"),
    );
    expect(check).toBeGreaterThanOrEqual(0);
    expect(clean.calls.filter(isIdentityRead).map((call) => call.args.at(-1))).toEqual([
      "user.name",
      "user.email",
    ]);
    expect(clean.calls.findIndex(isIdentityRead)).toBeGreaterThan(check);

    await git(fixture.source, "config", "core.hooksPath", ".githooks");
    const refused = new RecordingCommands(fixture.revision);
    await expect(realPreflight(fixture, refused)).rejects.toMatchObject({
      code: "unsafe-git-configuration",
    });
    // The refusal came first: no identity was read from a checkout whose
    // configuration can run a command.
    expect(refused.calls.filter(isIdentityRead)).toEqual([]);
  });

  /** What the operator's global Git configuration says, on top of the identity every fixture has. */
  async function setGlobalConfiguration(home: string, extra: string): Promise<void> {
    await writeFile(join(home, ".gitconfig"), `${globalIdentity}${extra}`);
  }

  it.each([
    ["commit.gpgsign", "false"],
    ["commit.gpgsign", "False"],
    ["commit.gpgsign", "off"],
    ["tag.gpgsign", "false"],
    ["tag.gpgsign", "off"],
    ["tag.gpgsign", "0"],
  ] as const)(
    "delivers with %s=%s in the checkout's own configuration (#2363)",
    async (key, value) => {
      const { fixture } = await identityFixture();
      await git(fixture.source, "config", key, value);
      const plan = await realPreflight(fixture);
      const { publish, requests } = await deliver(fixture, plan);
      const result = await publish();
      // Before #2363 the publisher refused the setting, whatever its value.
      expect(result.status, result.status === "failed" ? result.code : undefined).toBe("opened");
      expect(requests).toHaveLength(1);
    },
  );

  it.each([
    ["core.sshCommand", "ssh -i /operator/.ssh/id_work"],
    ["core.askPass", "/usr/bin/ssh-askpass"],
  ] as const)(
    "delivers with %s in the operator's global Git configuration (#2363)",
    async (key, value) => {
      const { fixture, home } = await identityFixture();
      const [section, variable] = key.split(".") as [string, string];
      await setGlobalConfiguration(home, `[${section}]\n\t${variable} = ${value}\n`);
      const plan = await realPreflight(fixture);
      const { publish, requests } = await deliver(fixture, plan);
      const result = await publish();
      // Before #2363 the publisher refused these in any file, the operator's own included.
      expect(result.status, result.status === "failed" ? result.code : undefined).toBe("opened");
      expect(requests).toHaveLength(1);
    },
  );

  it.each([
    ["core.sshCommand", "ssh -i /tmp/key", "core.sshcommand"],
    ["core.askPass", "/tmp/askpass", "core.askpass"],
    ["commit.gpgsign", "true", "commit.gpgsign"],
    ["tag.gpgsign", "true", "tag.gpgsign"],
    ["gpg.program", "/tmp/gpg", "gpg.program"],
    ["user.signingkey", "ABCD", "user.signingkey"],
    ["http.https://gitlab.example.test/.extraheader", "X-Extra: 1", "http.*.extraheader"],
    ["http.https://gitlab.example.test/.proxy", "http://proxy.example.test", "http.*.proxy"],
    ["url.https://example.test/.insteadOf", "https://gitlab.example.test/", "url.*.insteadof"],
    ["remote.origin.pushoption", "ci.skip", "remote.*.pushoption"],
    ["push.pushoption", "ci.skip", "push.pushoption"],
    ["core.gitProxy", "ssh-proxy", "core.gitproxy"],
  ] as const)(
    "refuses %s in the checkout in preflight, naming the setting and its file, before any publication (#2363)",
    async (key, value, setting) => {
      const { fixture } = await identityFixture();
      await git(fixture.source, "config", key, value);
      const refused = await realPreflight(fixture).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(LocalUserPublicationPreflightError);
      expect(refused).toMatchObject({
        code: "git-configuration-refused",
        details: { configuration: { key: setting, origin: "file:.git/config" } },
      });
      expect((refused as Error).message).toContain(
        `The setting ${setting} comes from file:.git/config.`,
      );
      // The value is never in the message.
      expect((refused as Error).message).not.toContain(value);
      // Positive control: the same checkout without the setting passes preflight.
      await git(fixture.source, "config", "--unset", key);
      const plan = await realPreflight(fixture);
      expect(plan.project.path).toBe("group/docs");
    },
  );

  it.each([
    ["http.https://gitlab.example.test/.extraheader", "X-Extra: 1", "http.*.extraheader"],
    ["http.https://gitlab.example.test/.proxy", "http://proxy.example.test", "http.*.proxy"],
    ["core.hooksPath", "/operator/hooks", "core.hookspath"],
    ["core.fsmonitor", "true", "core.fsmonitor"],
    ["core.gitProxy", "ssh-proxy", "core.gitproxy"],
    ["remote.origin.pushoption", "ci.skip", "remote.*.pushoption"],
  ] as const)(
    "still refuses %s in the operator's global configuration, naming the file with ~ for the home directory (#2363)",
    async (key, value, setting) => {
      const { fixture, home } = await identityFixture();
      const [section, ...rest] = key.split(".");
      const variable = rest.pop()!;
      const subsection = rest.length > 0 ? ` "${rest.join(".")}"` : "";
      await setGlobalConfiguration(home, `[${section}${subsection}]\n\t${variable} = ${value}\n`);
      await expect(realPreflight(fixture)).rejects.toMatchObject({
        code: "git-configuration-refused",
        details: { configuration: { key: setting, origin: "file:~/.gitconfig" } },
      });
      // Positive control: the file without the setting passes.
      await setGlobalConfiguration(home, "");
      await expect(realPreflight(fixture)).resolves.toMatchObject({ run: { id: "run-1" } });
    },
  );

  it("refuses a core.sshCommand in a file the global configuration includes, which is not trusted (#2363)", async () => {
    const { fixture, home } = await identityFixture();
    await writeFile(join(home, "work.gitconfig"), "[core]\n\tsshCommand = ssh -i /tmp/key\n");
    await setGlobalConfiguration(home, "[include]\n\tpath = work.gitconfig\n");
    await expect(realPreflight(fixture)).rejects.toMatchObject({
      code: "git-configuration-refused",
      details: { configuration: { key: "core.sshcommand", origin: "file:~/work.gitconfig" } },
    });
    // Positive control: the same setting written in the global file itself is accepted.
    await setGlobalConfiguration(home, "[core]\n\tsshCommand = ssh -i /tmp/key\n");
    await expect(realPreflight(fixture)).resolves.toMatchObject({ run: { id: "run-1" } });
  });

  it("reports a setting added after the plan as git-configuration-refused, then publishes once it is removed", async () => {
    const { fixture, home } = await identityFixture();
    const plan = await realPreflight(fixture);
    const { publish, retry, remote, requests } = await deliver(fixture, plan);
    // Preflight passed; the operator then changed their global configuration.
    await setGlobalConfiguration(home, "[core]\n\thooksPath = /operator/hooks\n");
    const refused = await publish();
    expect(refused).toMatchObject({
      status: "failed",
      code: "git-configuration-refused",
      nextAction: "remove-unsafe-git-configuration",
    });
    expect(remote.pushes).toBe(0);
    expect(requests).toHaveLength(0);
    // Positive control: once the setting is removed, retrying the same
    // publication (a fresh recovery worktree, as a retried publish prepares)
    // opens the draft merge request.
    await setGlobalConfiguration(home, "");
    const opened = await (await retry())();
    expect(opened.status, opened.status === "failed" ? opened.code : undefined).toBe("opened");
    expect(requests).toHaveLength(1);
  });

  it("reports a configuration the publisher cannot read, a key with no value, as git-checkout-unverified, then publishes once it is removed (#2363)", async () => {
    const { fixture, home } = await identityFixture();
    const plan = await realPreflight(fixture);
    const { publish, retry, remote, requests } = await deliver(fixture, plan);
    // Preflight passed; the operator then added a key with no value, which Git
    // reads as true and the publisher cannot verify.
    await setGlobalConfiguration(home, "[core]\n\tfoo\n");
    const unverified = await publish();
    // Before #2363 this reported remote-drift and sent the operator to reconcile GitLab.
    expect(unverified).toMatchObject({
      status: "failed",
      code: "git-checkout-unverified",
      nextAction: "repair-git-checkout",
    });
    expect(remote.pushes).toBe(0);
    expect(requests).toHaveLength(0);
    // Positive control: with the key removed, the same publication proceeds.
    await setGlobalConfiguration(home, "");
    const opened = await (await retry())();
    expect(opened.status, opened.status === "failed" ? opened.code : undefined).toBe("opened");
    expect(requests).toHaveLength(1);
  });

  it("refuses a configuration the publisher cannot read in preflight as git-checkout-unverified (#2363)", async () => {
    const { fixture, home } = await identityFixture();
    await setGlobalConfiguration(home, "[core]\n\tfoo\n");
    await expect(realPreflight(fixture)).rejects.toMatchObject({
      code: "git-checkout-unverified",
    });
    await setGlobalConfiguration(home, "");
    await expect(realPreflight(fixture)).resolves.toMatchObject({ run: { id: "run-1" } });
  });

  it("reports a refused setting found on a retry after the commit as git-configuration-refused, and publishes once it is removed (#2393)", async () => {
    const { fixture } = await identityFixture();
    const plan = await realPreflight(fixture);
    const { publish, retryCommitted, remote, requests, receipt } = await deliver(fixture, plan);
    remote.failPushes = true;
    const pushFailed = await publish();
    expect(pushFailed).toMatchObject({
      status: "failed",
      code: "push-failed",
      lastConfirmedState: "committed",
    });
    expect(receipt()?.state).toBe("committed");

    // The operator adds a setting the host refuses, then retries.
    await git(fixture.source, "config", "core.sshCommand", "ssh -i /tmp/key");
    remote.failPushes = false;
    const refused = await (await retryCommitted())();
    // Before #2393 this reported receipt-drift and recovered the receipt to patch-only.
    expect(refused).toMatchObject({
      status: "failed",
      code: "git-configuration-refused",
      nextAction: "remove-unsafe-git-configuration",
      lastConfirmedState: "committed",
    });
    expect(receipt()?.disposition).toBe("failed");
    expect(receipt()?.recovery).toBeUndefined();
    expect(remote.pushes).toBe(0);
    expect(requests).toHaveLength(0);

    // Removing the setting and retrying publishes: the receipt was never recovered.
    await git(fixture.source, "config", "--unset", "core.sshCommand");
    const opened = await (await retryCommitted())();
    expect(opened.status, opened.status === "failed" ? opened.code : undefined).toBe("opened");
    expect(remote.pushes).toBe(1);
    expect(requests).toHaveLength(1);
  });

  /**
   * The bytes that `git config --includes --show-origin --null --list` prints in the checkout,
   * as the host runs it: the publisher's flags and Git environment.
   */
  async function listingBytes(fixture: Fixture): Promise<number> {
    const { stdout } = await exec(
      "git",
      [...HOST_GIT_CONFIG_FLAGS, ...GIT_CONFIGURATION_LIST_ARGS],
      {
        cwd: fixture.source,
        env: gitEnvironment(process.env),
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    return stdout.byteLength;
  }

  /**
   * Fill the operator's global configuration with `[alias]` settings, which no rule names, until
   * the listing is about `target` bytes; returns the size it reached.
   */
  async function growListing(fixture: Fixture, home: string, target: number): Promise<number> {
    const write = (count: number) =>
      setGlobalConfiguration(
        home,
        `[alias]\n${Array.from(
          { length: count },
          (_, index) => `\ta${String(index).padStart(6, "0")} = status\n`,
        ).join("")}`,
      );
    await write(1000);
    const perEntry = (await listingBytes(fixture)) / 1000;
    await write(Math.ceil(target / perEntry));
    return listingBytes(fixture);
  }

  /** The documented one-line setting that stops git config --list: a section header with no bracket. */
  const MALFORMED = "[core\n\tfoo = bar\n";

  it("passes preflight and publishes with about 0.6 MB of accepted settings (#2363 positive control)", async () => {
    const { fixture, home } = await identityFixture();
    const bytes = await growListing(fixture, home, 600_000);
    expect(bytes).toBeGreaterThan(500_000);
    const plan = await realPreflight(fixture);
    const { publish, requests } = await deliver(fixture, plan);
    const result = await publish();
    expect(result.status, result.status === "failed" ? result.code : undefined).toBe("opened");
    expect(requests).toHaveLength(1);
  });

  it("publishes what preflight passes: about 1.4 MB of accepted settings, over the publisher's former 1,000,000-byte cap (#2363)", async () => {
    const { fixture, home } = await identityFixture();
    const bytes = await growListing(fixture, home, 1_400_000);
    // The premise: over what the publisher used to read, under what preflight read.
    expect(bytes).toBeGreaterThan(1_000_000);
    expect(bytes).toBeLessThan(2 * 1024 * 1024);
    const plan = await realPreflight(fixture);
    const { publish, requests } = await deliver(fixture, plan);
    const result = await publish();
    // Before #2363 preflight passed, the model would have run, and the publisher then stopped
    // with remote-drift: two readers, two bounds.
    expect(result.status, result.status === "failed" ? result.code : undefined).toBe("opened");
    expect(requests).toHaveLength(1);
  });

  it("stops preflight and the publisher alike when the listing outgrows the declared bound, and names the limit in preflight (#2363)", async () => {
    const { fixture, home } = await identityFixture();
    const small = await listingBytes(fixture);
    // The bound sits a little above the small listing: the plan passes under it.
    vi.stubEnv("DOCSFAB_DELIVERY_GIT_CONFIGURATION_LISTING_MAX_BYTES", String(small + 5000));
    const plan = await realPreflight(fixture);
    const { publish, retry, remote, requests } = await deliver(fixture, plan);

    // The operator's configuration then grows past the bound.
    const grown = await growListing(fixture, home, small + 100_000);
    expect(grown).toBeGreaterThan(small + 5000);
    const stopped = await publish();
    expect(stopped).toMatchObject({
      status: "failed",
      code: "git-checkout-unverified",
      nextAction: "repair-git-checkout",
    });
    expect(remote.pushes).toBe(0);
    expect(requests).toHaveLength(0);
    // Preflight reads the same bound: it refuses the same listing, and says which limit.
    const commands = new RecordingCommands(fixture.revision);
    const refused = await realPreflight(fixture, commands).then(
      () => undefined,
      (error: unknown) => error as LocalUserPublicationPreflightError,
    );
    expect(refused).toMatchObject({ code: "git-checkout-unverified" });
    expect(refused?.details?.limitRefusal).toContain(
      "delivery-git-configuration-listing-max-bytes-bound",
    );
    expect(commands.calls.filter((call) => call.command === "glab")).toEqual([]);

    // Positive control: once the configuration is back under the bound, the same publication proceeds.
    await setGlobalConfiguration(home, "");
    await expect(realPreflight(fixture)).resolves.toMatchObject({ run: { id: "run-1" } });
    const opened = await (await retry())();
    expect(opened.status, opened.status === "failed" ? opened.code : undefined).toBe("opened");
    expect(requests).toHaveLength(1);
  });

  it("reports a global configuration file that is malformed after the plan as git-checkout-unverified, as preflight does, then publishes once it is fixed (#2363)", async () => {
    const { fixture, home } = await identityFixture();
    const plan = await realPreflight(fixture);
    const { publish, retry, remote, requests } = await deliver(fixture, plan);
    await setGlobalConfiguration(home, MALFORMED);
    const unverified = await publish();
    // Before #2363 this reported remote-drift and sent the operator to reconcile GitLab.
    expect(unverified).toMatchObject({
      status: "failed",
      code: "git-checkout-unverified",
      nextAction: "repair-git-checkout",
    });
    expect(remote.pushes).toBe(0);
    expect(requests).toHaveLength(0);
    // Preflight reports the same file with the same code.
    await expect(realPreflight(fixture)).rejects.toMatchObject({ code: "git-checkout-unverified" });
    // Positive control: with the file fixed, the same publication proceeds.
    await setGlobalConfiguration(home, "");
    const opened = await (await retry())();
    expect(opened.status, opened.status === "failed" ? opened.code : undefined).toBe("opened");
    expect(requests).toHaveLength(1);
  });

  it("keeps the receipt retryable when a malformed configuration file is found on a retry after the commit, and publishes once it is fixed (#2393)", async () => {
    const { fixture, home } = await identityFixture();
    const plan = await realPreflight(fixture);
    const { publish, retryCommitted, remote, requests, receipt } = await deliver(fixture, plan);
    remote.failPushes = true;
    expect(await publish()).toMatchObject({ status: "failed", code: "push-failed" });
    expect(receipt()?.state).toBe("committed");

    await setGlobalConfiguration(home, MALFORMED);
    remote.failPushes = false;
    const unverified = await (await retryCommitted())();
    // Before #2363 this was receipt-drift, and the receipt was recovered to patch-only: fixing
    // the file could no longer publish.
    expect(unverified).toMatchObject({
      status: "failed",
      code: "git-checkout-unverified",
      nextAction: "repair-git-checkout",
      lastConfirmedState: "committed",
    });
    expect(receipt()?.disposition).toBe("failed");
    expect(receipt()?.recovery).toBeUndefined();
    expect(remote.pushes).toBe(0);

    await setGlobalConfiguration(home, "");
    const opened = await (await retryCommitted())();
    expect(opened.status, opened.status === "failed" ? opened.code : undefined).toBe("opened");
    expect(remote.pushes).toBe(1);
    expect(requests).toHaveLength(1);
  });

  it("refuses a core.sshCommand in a global file that a relative HOME names inside the checkout, and says why (#2363)", async () => {
    const { fixture, home } = await identityFixture();
    // Git reads the global file of the relative HOME "~" as ./~/.gitconfig, a path in the checkout.
    await mkdir(join(fixture.source, "~"));
    const relative = join(fixture.source, "~", ".gitconfig");
    await writeFile(relative, `${globalIdentity}[core]\n\tsshCommand = ssh -i /tmp/key\n`);
    vi.stubEnv("HOME", "~");
    const refused = await realPreflight(fixture).then(
      () => undefined,
      (error: unknown) => error as LocalUserPublicationPreflightError,
    );
    expect(refused).toMatchObject({
      code: "git-configuration-refused",
      details: {
        configuration: {
          key: "core.sshcommand",
          origin: "file:~/.gitconfig",
          reason: "home-not-operator-owned",
        },
      },
    });
    expect(refused?.message).toContain("because HOME is not an absolute path outside the checkout");

    // The inert settings that file holds are accepted, as they were before: nothing runs.
    await writeFile(relative, `${globalIdentity}[commit]\n\tgpgsign = true\n`);
    await expect(realPreflight(fixture)).resolves.toMatchObject({ run: { id: "run-1" } });
    // Positive control: the same core.sshCommand in a global file under an absolute HOME passes.
    await setGlobalConfiguration(home, "[core]\n\tsshCommand = ssh -i /tmp/key\n");
    vi.stubEnv("HOME", home);
    await expect(realPreflight(fixture)).resolves.toMatchObject({ run: { id: "run-1" } });
  });

  it.each([
    ["the publisher the caller supplies", false],
    ["the publisher the host builds when the caller supplies none", true],
  ])(
    "refuses a core.sshCommand in a global file under a HOME inside the source checkout, in preflight and again at publication with %s (#2363)",
    async (_label, defaultGit) => {
      const { fixture, home } = await identityFixture();
      const inside = join(fixture.source, ".operator-home");
      await mkdir(inside, { mode: 0o700 });
      await writeFile(join(inside, ".gitconfig"), `${globalIdentity}[core]\n\tsshCommand = ssh\n`);
      vi.stubEnv("HOME", inside);
      await expect(realPreflight(fixture)).rejects.toMatchObject({
        code: "git-configuration-refused",
        details: { configuration: { key: "core.sshcommand", reason: "home-not-operator-owned" } },
      });

      // The publisher, told where the source checkout is, refuses the same file after the plan.
      vi.stubEnv("HOME", home);
      const plan = await realPreflight(fixture);
      const { publish, retry, remote, requests } = await deliver(fixture, plan, { defaultGit });
      vi.stubEnv("HOME", inside);
      const refused = await publish();
      expect(refused).toMatchObject({
        status: "failed",
        code: "git-configuration-refused",
        nextAction: "remove-unsafe-git-configuration",
      });
      expect(remote.pushes).toBe(0);
      expect(requests).toHaveLength(0);
      // Positive control: with HOME back outside the checkout, the same publication proceeds. The
      // publisher the host builds would push for real, so only the supplied one runs this step.
      if (!defaultGit) {
        vi.stubEnv("HOME", home);
        const opened = await (await retry())();
        expect(opened.status, opened.status === "failed" ? opened.code : undefined).toBe("opened");
        expect(requests).toHaveLength(1);
      }
    },
  );

  it.each([
    ["x", "an ASCII character"],
    ["\u2028", "U+2028"],
    ["\u2029", "U+2029"],
  ])(
    "refuses an includeIf whose condition holds %j (%s) in the checkout's own configuration (#2363)",
    async (character) => {
      const { fixture } = await identityFixture();
      const configPath = join(fixture.source, ".git", "config");
      const original = await readFile(configPath, "utf8");
      await appendFile(configPath, `[includeIf "gitdir:/${character}x/"]\n\tpath = /tmp/evil\n`);
      // The checkout's own configuration is where hooks, includes, and filters are refused.
      await expect(realPreflight(fixture)).rejects.toMatchObject({
        code: "unsafe-git-configuration",
      });
      // Positive control: the checkout without that include passes.
      await writeFile(configPath, original);
      await expect(realPreflight(fixture)).resolves.toMatchObject({ run: { id: "run-1" } });
    },
  );

  it("refuses an includeIf with U+2028 in a file the global configuration includes, which is not trusted (#2363)", async () => {
    const { fixture, home } = await identityFixture();
    await writeFile(
      join(home, "work.gitconfig"),
      `[includeIf "gitdir:/ x/"]\n\tpath = /tmp/evil\n`,
    );
    await setGlobalConfiguration(home, "[include]\n\tpath = work.gitconfig\n");
    await expect(realPreflight(fixture)).rejects.toMatchObject({
      code: "git-configuration-refused",
      details: { configuration: { key: "includeif.*.path", origin: "file:~/work.gitconfig" } },
    });
    // Positive control: the same file without the include passes.
    await writeFile(join(home, "work.gitconfig"), "[core]\n\teditor = vim\n");
    await expect(realPreflight(fixture)).resolves.toMatchObject({ run: { id: "run-1" } });
  });

  it("publishes on the retry after a failed push when no refused setting appears (#2393 positive control)", async () => {
    const { fixture } = await identityFixture();
    const plan = await realPreflight(fixture);
    const { publish, retryCommitted, remote, requests } = await deliver(fixture, plan);
    remote.failPushes = true;
    expect(await publish()).toMatchObject({ status: "failed", code: "push-failed" });
    remote.failPushes = false;
    const opened = await (await retryCommitted())();
    expect(opened.status, opened.status === "failed" ? opened.code : undefined).toBe("opened");
    expect(requests).toHaveLength(1);
  });
});
