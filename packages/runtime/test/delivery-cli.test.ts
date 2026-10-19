// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  createTaskLineageArtifacts,
  mintTaskLineageHostCapability,
  projectTaskLineage,
  type DecisionAttributionInputV1,
  type TaskLineageProjectionV1,
  type TaskOriginInputV1,
} from "../src/lineage/index.js";
import { internalCreateTaskLineageHostAuthority } from "../src/lineage/authority-internal.js";
import { buildCurrentTaskLineageFixture } from "./helpers/current-task-lineage.js";

import { usage } from "../src/cli/usage.js";
import {
  authorizeLocalUserPublication,
  buildDocsFabPublicationMetadata,
  createScmDeliveryRecord,
  DeliveryWorktreeError,
  FileScmDeliveryReceiptStore,
  localUserGitIdentitySha256,
  localUserPublicationPlanSha256,
  parseLocalUserPublishCliOptions,
  parseLocalUserPublishExecuteCliOptions,
  localUserPublishExecuteArgv,
  publicationMetadataInputDigests,
  recordScmDeliveryProgress,
  runLocalUserPublishCli,
  runLocalUserPublishExecuteCli,
  selectDocumentationValidationProfile,
  scmDeliveryIdempotencyKey,
  type DeliveryWorktreeReadyAttestation,
  type GitLabMergeRequest,
  type GitLabPublisherAdapter,
  type LocalGitPublisher,
  type LocalUserPublicationPlan,
  type LocalUserPublicationPlanV2,
  type PrepareDeliveryWorktreeInput,
  type ScmDeliveryRecord,
  type ScmDeliveryReceiptStore,
} from "../src/delivery/index.js";
import { documentationValidationKit } from "../src/delivery/validation-profile.js";
import { validationBackendPolicySha256 } from "../src/delivery/worktree/validation-backend.js";
import { resolveDocsFabPublicationRoots } from "../src/config/host-paths.js";

const execute = promisify(execFile);

describe("local-user publish CLI contract", () => {
  const dependencies = { cwd: "/workspace", stateDirectory: "/state/runs" };

  it("projects host state policy and honors explicit private-root overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-host-publication-roots-"));
    try {
      const configurationRoot = join(root, "config");
      const deliveryRoot = join(root, "private-delivery");
      const receiptRoot = join(root, "private-receipts");
      await mkdir(configurationRoot, { mode: 0o700 });
      await writeFile(
        join(configurationRoot, "host.yaml"),
        [
          "schemaVersion: 1",
          "kind: docsfab-host-config",
          "activePolicyProfile: profiles/policy.yaml",
          "paths:",
          "  stateDir: ./host-state/runs",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      expect(
        resolveDocsFabPublicationRoots({
          DOCSFAB_CONFIG_ROOT: configurationRoot,
          DOCSFAB_DELIVERY_ROOT: deliveryRoot,
          DOCSFAB_RECEIPT_ROOT: receiptRoot,
        }),
      ).toEqual({
        stateDirectory: join(configurationRoot, "host-state/runs"),
        deliveryRoot,
        receiptRoot,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("defaults this checkout and origin; --draft-mr remains accepted", () => {
    expect(parseLocalUserPublishCliOptions(["run-1", "--preflight"], dependencies)).toEqual({
      runId: "run-1",
      repositoryPath: "/workspace",
      stateDirectory: "/state/runs",
      remoteName: "origin",
    });
    expect(
      parseLocalUserPublishCliOptions(["run-1", "--repo", ".", "--draft-mr"], dependencies),
    ).toEqual({
      runId: "run-1",
      repositoryPath: "/workspace",
      stateDirectory: "/state/runs",
      remoteName: "origin",
    });
  });

  it("parses content-minimized plan inputs without accepting mutation options", () => {
    expect(
      parseLocalUserPublishCliOptions(
        [
          "run-1",
          "--repo",
          ".",
          "--draft-mr",
          "--preflight",
          "--remote",
          "origin",
          "--target-branch",
          "main",
          "--source-branch",
          "docsfab-run/run-1",
          "--validation-command",
          "npm run check",
        ],
        dependencies,
      ),
    ).toEqual({
      runId: "run-1",
      repositoryPath: "/workspace",
      stateDirectory: "/state/runs",
      remoteName: "origin",
      targetBranch: "main",
      proposedSourceBranch: "docsfab-run/run-1",
      validationCommand: "npm run check",
    });
    expect(
      parseLocalUserPublishCliOptions(
        ["run-1", "--repo", ".", "--draft-mr", "--preflight", "--validation-command", "true"],
        dependencies,
      ),
    ).toMatchObject({ validationCommand: "true" });
    expect(
      parseLocalUserPublishCliOptions(
        ["run-1", "--repo", ".", "--draft-mr", "--preflight", "--json"],
        dependencies,
      ),
    ).toMatchObject({ runId: "run-1", repositoryPath: "/workspace" });
    expect(() =>
      parseLocalUserPublishCliOptions(
        ["run-1", "--repo", ".", "--draft-mr", "--preflight", "--push"],
        dependencies,
      ),
    ).toThrow("Unknown publish option");
    expect(() =>
      parseLocalUserPublishCliOptions(
        ["run-1", "--repo", ".", "--draft-mr", "--preflight", "--isolate-validation"],
        dependencies,
      ),
    ).toThrow("Unknown publish option");
  });

  it("refuses combining --preflight with --execute", async () => {
    await expect(
      runLocalUserPublishCli(["run-1", "--repo", ".", "--draft-mr", "--preflight", "--execute"], {
        cwd: "/workspace",
        stateDirectory: "/state/runs",
        log: () => undefined,
      }),
    ).rejects.toThrow(/cannot include --preflight/u);
  });

  it("delegates one-shot draft publication through the delivery orchestrator", async () => {
    let submittedRunId: string | undefined;
    let submittedEnvelope: unknown;
    let submittedContext: { proposedSourceBranch?: string } | undefined;
    await runLocalUserPublishCli(
      ["run-1", "--repo", ".", "--draft-mr", "--source-branch", "docsfab/run-1"],
      {
        cwd: "/workspace",
        stateDirectory: "/state/runs",
        log: () => undefined,
        loadRun: async () =>
          ({
            id: "run-1",
            recordSha256: "record",
            revision: "revision",
            sourcePath: "/workspace",
            workflowOutcome: "Improve governed documentation",
            changedFiles: [{ path: "docs/guide.md", status: "modified" }],
            changedFileCount: 1,
            patch: { bytes: Buffer.from("patch") },
          }) as never,
        submit: async (run, envelope, context) => {
          submittedRunId = run.id;
          submittedEnvelope = envelope;
          submittedContext = context;
          return { mergeRequest: { url: "https://gitlab.example/mr/1" } } as never;
        },
      },
    );
    expect(submittedRunId).toBe("run-1");
    expect(submittedEnvelope).toMatchObject({ runId: "run-1", write: true, publish: "draft-mr" });
    expect(submittedContext).toMatchObject({ proposedSourceBranch: "docsfab/run-1" });
  });

  it("runs one-shot publication through the real submit boundary", async () => {
    const preflightInputs: Array<Record<string, unknown>> = [];
    let executeArgs: readonly string[] | undefined;
    let executeDependencies: Record<string, unknown> | undefined;
    const log: string[] = [];
    const stderr: string[] = [];
    const result = await runLocalUserPublishCli(
      [
        "run-1",
        "--repo",
        ".",
        "--draft-mr",
        "--remote",
        "upstream",
        "--target-branch",
        "release",
        "--source-branch",
        "docsfab/run-1",
        "--validation-command",
        "npm run check",
      ],
      {
        cwd: "/workspace",
        stateDirectory: "/state/runs",
        log: (message) => log.push(message),
        stderr: (message) => stderr.push(message),
        loadRun: async () =>
          ({
            id: "run-1",
            recordSha256: "record",
            revision: "revision",
            sourcePath: "/workspace",
            workflowOutcome: "Improve governed documentation",
            changedFiles: [{ path: "docs/guide.md", status: "modified" }],
            changedFileCount: 1,
            patch: { bytes: Buffer.from("patch"), byteLength: 5 },
          }) as never,
        preflight: async (input) => {
          preflightInputs.push(input as unknown as Record<string, unknown>);
          return { sha256: "a".repeat(64), validationCommand: "npm run check" } as never;
        },
        execute: async (args, dependencies) => {
          executeArgs = args;
          executeDependencies = dependencies as unknown as Record<string, unknown>;
          return { mergeRequest: { url: "https://gitlab.example/mr/1" } } as never;
        },
      },
    );
    expect(result).toMatchObject({ mergeRequest: { url: "https://gitlab.example/mr/1" } });
    expect(preflightInputs[0]).toMatchObject({
      remoteName: "upstream",
      targetBranch: "release",
      proposedSourceBranch: "docsfab/run-1",
      validationCommand: "npm run check",
      draftMergeRequest: true,
    });
    expect(executeArgs).toEqual(
      expect.arrayContaining([
        "--remote",
        "upstream",
        "--target-branch",
        "release",
        "--source-branch",
        "docsfab/run-1",
        "--validation-command",
        "npm run check",
      ]),
    );
    expect(executeDependencies).toMatchObject({ cwd: "/workspace", stateDirectory: "/state/runs" });
    expect(executeDependencies?.submit).toBeUndefined();
    expect(log).toContain("Draft merge request: https://gitlab.example/mr/1");
    expect(stderr).toEqual(["Note: prefer docsfab ship for interactive use."]);
  });

  it("builds execute argv from a host-bound plan digest", () => {
    const digest = "a".repeat(64);
    expect(
      localUserPublishExecuteArgv({
        runId: "run-1",
        repositoryPath: "/workspace/repository",
        stateDirectory: "/state/runs",
        confirmedPlanSha256: digest,
        validationCommand: "true",
        remoteName: "origin",
      }),
    ).toEqual([
      "run-1",
      "--repo",
      "/workspace/repository",
      "--draft-mr",
      "--execute",
      "--confirm-plan-sha256",
      digest,
      "--state-dir",
      "/state/runs",
      "--validation-command",
      "true",
      "--remote",
      "origin",
    ]);
  });

  it("requires an exact execute confirmation and disjoint absolute private roots", () => {
    const digest = "a".repeat(64);
    expect(
      parseLocalUserPublishExecuteCliOptions(
        executeArgs(
          "/workspace/repository",
          digest,
          "--delivery-root",
          "/private/delivery",
          "--receipt-root",
          "/private/receipts",
        ),
        dependencies,
      ),
    ).toMatchObject({
      runId: "run-1",
      repositoryPath: "/workspace/repository",
      confirmedPlanSha256: digest,
      deliveryRoot: "/private/delivery",
      receiptRoot: "/private/receipts",
    });
    for (const args of [
      ["run-1", "--repo", "/workspace/repository", "--draft-mr", "--execute"],
      executeArgs(
        "/workspace/repository",
        digest,
        "--delivery-root",
        "relative",
        "--receipt-root",
        "/private/receipts",
      ),
      executeArgs(
        "/workspace/repository",
        digest,
        "--delivery-root",
        "/workspace/repository/delivery",
        "--receipt-root",
        "/private/receipts",
      ),
    ]) {
      expect(() => parseLocalUserPublishExecuteCliOptions(args, dependencies)).toThrow();
    }
    expect(
      parseLocalUserPublishExecuteCliOptions(
        executeArgs("/workspace/repository", digest),
        dependencies,
      ),
    ).toEqual({
      runId: "run-1",
      repositoryPath: "/workspace/repository",
      stateDirectory: "/state/runs",
      confirmedPlanSha256: digest,
      remoteName: "origin",
    });
    expect(() =>
      parseLocalUserPublishExecuteCliOptions(
        [
          "run-1",
          "--repo",
          "/workspace/repository",
          "--draft-mr",
          "--execute",
          "--confirm-plan-sha256",
          digest,
          "--allow-factory-execute",
        ],
        dependencies,
      ),
    ).toThrow("Unknown publish option");
  });

  it("documents one-shot publish and optional two-phase recovery", () => {
    const text = usage();
    expect(text).toContain("docsfab publish <run-id> [--repo <path>] [--remote <name>]");
    expect(text).toContain("docsfab publish <run-id> [--repo <path>] --preflight");
    expect(text).toContain(
      "defaults: this checkout and origin; one-shot host preflight then execute; do not paste a plan digest",
    );
    expect(text).toContain("[--delivery-root <absolute-path>] [--receipt-root <absolute-path>]");
    expect(text).toContain("built-in documentation-validation profile");
    expect(text).toContain("never infers npm run check or true");
    expect(text).toContain("offline product smoke");
    expect(text).not.toContain("defaults to npm run check");
    expect(text).toContain("DocsFab itself is supported as a publication target");
    expect(text).not.toContain("cannot be an --execute target");
    expect(text).not.toContain("--allow-factory");
    expect(text).toContain("defaults: this checkout, origin, write and one draft MR");
    expect(text).toContain("two-phase recovery after reviewing --preflight JSON");
    expect(text).toMatch(
      /docsfab run create-documentation \[--repo <path>\] \[--revision <ref>\] \(--instruction <text> \| --resume-from <stopped-run-id> --canon-snapshot <json>\)/,
    );
  });

  it("resolves host-owned delivery and receipt roots when execute omits them", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-cli-init-roots-"));
    try {
      const repository = join(root, "repository");
      const stateDirectory = join(root, "state");
      const home = join(root, "home");
      const stateHome = join(root, "xdg-state");
      await Promise.all(
        [repository, stateDirectory, home, stateHome].map((path) => mkdir(path, { mode: 0o700 })),
      );
      const canonicalRepo = await realpath(repository);
      const canonicalHome = await realpath(home);
      const canonicalStateHome = await realpath(stateHome);
      await writeFile(
        join(canonicalRepo, ".docsfab.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          gitlab: { remote: "origin", defaultBranch: "main" },
          provider: { configuration: "host" },
          storage: { scope: "user-private" },
        })}\n`,
      );
      const expected = resolveDocsFabPublicationRoots(
        { XDG_STATE_HOME: canonicalStateHome },
        join(await realpath(root), "state"),
      );
      const plan = executePlan();
      const captured: string[] = [];
      let prepared = 0;
      await runLocalUserPublishExecuteCli(
        executeArgs(canonicalRepo, plan.sha256, "--state-dir", stateDirectory),
        {
          cwd: root,
          stateDirectory,
          environment: { XDG_STATE_HOME: canonicalStateHome },
          homeDirectory: canonicalHome,
          log: () => undefined,
          preflight: async () => plan,
          prepareWorktree: async (input) => {
            prepared += 1;
            captured.push(input.deliveryRoot);
            return {
              status: "ready",
              worktree: worktree(plan, join(input.deliveryRoot, "repository")),
            };
          },
          inspectReady: async (selected) => ready(plan, selected.worktreePath),
          loadRun: async () => loadedRun(plan, canonicalRepo),
          publisher: {
            git: replayGit(),
            gitlab: replayGitLab(plan),
            assertReady: async () => undefined,
          },
        },
      );
      expect(prepared).toBe(1);
      expect(captured[0]?.startsWith(join(expected.deliveryRoot, "attempts") + "/")).toBe(true);
      expect((await lstat(expected.deliveryRoot)).isDirectory()).toBe(true);
      expect((await lstat(expected.receiptRoot)).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["tech-docs/agents/docsfab", "Tech-Docs/Agents/DocsFab"])(
    "publishes an explicitly confirmed DocsFab run: %s",
    async (projectPath) => {
      const root = await mkdtemp(join(tmpdir(), "docsfab-cli-self-publish-"));
      try {
        const repository = join(root, "repository");
        const stateDirectory = join(root, "state");
        await Promise.all([mkdir(repository), mkdir(stateDirectory)]);
        const plan = executePlan({ projectPath });
        let prepared = 0;
        const result = await runLocalUserPublishExecuteCli(
          executeArgs(
            repository,
            plan.sha256,
            ...privateRootArgs(join(root, "delivery"), join(root, "receipts"), stateDirectory),
          ),
          {
            cwd: root,
            stateDirectory,
            log: () => undefined,
            preflight: async () => plan,
            prepareWorktree: async (input) => {
              prepared++;
              return {
                status: "ready",
                worktree: worktree(plan, join(input.deliveryRoot, "repository")),
              };
            },
            inspectReady: async (selected) => ready(plan, selected.worktreePath),
            loadRun: async () => loadedRun(plan, repository),
            publisher: {
              git: replayGit(),
              gitlab: replayGitLab(plan),
              assertReady: async () => undefined,
            },
          },
        );
        expect(prepared).toBe(1);
        expect(result?.mergeRequest).toMatchObject({ draft: true });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["names one", { HOME: "/operator-home", PATH: "/usr/bin" }],
    ["names none", undefined],
  ] as const)(
    "plans with the publisher's Git environment when the caller %s (#2393)",
    async (_label, environment) => {
      // The plan binds the identity and checks the Git configuration, so it reads them
      // with the environment the publisher's Git will run with, not the process's.
      const root = await mkdtemp(join(tmpdir(), "docsfab-cli-plan-environment-"));
      try {
        const repository = join(root, "repository");
        const stateDirectory = join(root, "state");
        await Promise.all([mkdir(repository), mkdir(stateDirectory)]);
        const plan = executePlan();
        let seenContext: Record<string, unknown> | undefined;
        await runLocalUserPublishExecuteCli(
          executeArgs(
            repository,
            plan.sha256,
            ...privateRootArgs(join(root, "delivery"), join(root, "receipts"), stateDirectory),
          ),
          {
            cwd: root,
            stateDirectory,
            ...(environment ? { environment } : {}),
            log: () => undefined,
            preflight: async (_input, _commands, _decodeOptions, context) => {
              seenContext = context as Record<string, unknown> | undefined;
              return plan;
            },
            prepareWorktree: async (input) => ({
              status: "ready",
              worktree: worktree(plan, join(input.deliveryRoot, "repository")),
            }),
            inspectReady: async (selected) => ready(plan, selected.worktreePath),
            loadRun: async () => loadedRun(plan, repository),
            publisher: {
              git: replayGit(),
              gitlab: replayGitLab(plan),
              assertReady: async () => undefined,
            },
          },
        );
        if (environment) expect(seenContext?.environment).toBe(environment);
        else expect(seenContext).not.toHaveProperty("environment");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    [
      "inside the source checkout",
      "refuses its core.sshCommand",
      true,
      "git-configuration-refused",
    ],
    ["beside the source checkout", "accepts its core.sshCommand", false, "remote-drift"],
  ] as const)(
    "builds a host Git publisher that, with a HOME %s, %s (#2363)",
    async (_where, _decision, inside, code) => {
      // The operator's global file sets core.sshCommand. Under a HOME inside the source checkout
      // the repository can supply that file, so the publisher refuses it; under a HOME beside the
      // checkout the setting is the operator's own and the check passes. This delivery has no Git
      // adapter in its dependencies, so the publisher is the one publish-execute builds.
      const root = await mkdtemp(join(tmpdir(), "docsfab-cli-home-"));
      try {
        const repository = join(await realpath(root), "repository");
        const stateDirectory = join(root, "state");
        await Promise.all([mkdir(repository), mkdir(stateDirectory)]);
        const home = inside
          ? join(repository, ".operator-home")
          : join(await realpath(root), "home");
        await mkdir(home, { recursive: true, mode: 0o700 });
        await writeFile(
          join(home, ".gitconfig"),
          "[user]\n\tname = Maintainer\n\temail = maintainer@example.test\n[core]\n\tsshCommand = ssh -i /tmp/key\n",
        );
        const plan = executePlan();
        await expect(
          runLocalUserPublishExecuteCli(
            executeArgs(
              repository,
              plan.sha256,
              ...privateRootArgs(join(root, "delivery"), join(root, "receipts"), stateDirectory),
            ),
            {
              cwd: root,
              stateDirectory,
              environment: { HOME: home, PATH: process.env.PATH },
              log: () => undefined,
              preflight: async () => plan,
              prepareWorktree: async (input) => {
                const path = join(input.deliveryRoot, "repository");
                await mkdir(path, { recursive: true });
                return {
                  status: "ready",
                  worktree: { ...worktree(plan, path), repositoryPath: repository },
                };
              },
              inspectReady: async (selected) => ready(plan, selected.worktreePath),
              loadRun: async () => loadedRun(plan, repository),
              publisher: { gitlab: replayGitLab(plan), assertReady: async () => undefined },
            },
          ),
        ).rejects.toMatchObject({ code });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("propagates the inspected validation evidence through the CLI receipt transition", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-cli-validation-evidence-"));
    try {
      const repository = join(root, "repository");
      const deliveryRoot = join(root, "delivery");
      const receiptRoot = join(root, "receipts");
      const stateDirectory = join(root, "state");
      await Promise.all([mkdir(repository), mkdir(stateDirectory)]);
      const selected = selectDocumentationValidationProfile({
        workflow: "site-bootstrap",
        changedPaths: ["docs/guide.md"],
        hostPolicySha256: validationBackendPolicySha256(),
        applicabilitySha256: "5".repeat(64),
      });
      const plan = executeCurrentDocumentationPlan(selected.binding);
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
      await runLocalUserPublishExecuteCli(
        executeArgs(
          repository,
          plan.sha256,
          ...privateRootArgs(deliveryRoot, receiptRoot, stateDirectory),
        ),
        {
          cwd: root,
          stateDirectory,
          log: () => undefined,
          preflight: async () => plan,
          prepareWorktree: async (input) => ({
            status: "ready" as const,
            worktree: worktree(plan, join(input.deliveryRoot, "repository")),
          }),
          inspectReady: async (selectedWorktree) => ready(plan, selectedWorktree.worktreePath),
          loadRun: async () => loadedRun(plan, repository),
          receiptStore,
          publisher: {
            git: replayGit(),
            gitlab: replayGitLab(plan),
            assertReady: async () => undefined,
          },
        },
      );
      expect(stored?.evidence.validation).toMatchObject({
        profileVersion: selected.binding.profileVersion,
        checkIds: [...selected.binding.checkIds],
        candidateTreeSha256: "3".repeat(64),
        resultSha256: documentationResultSha256(
          selected.binding,
          selected.binding.checkIds.map((id) => ({ id, status: "passed" as const })),
        ),
        results: selected.binding.checkIds.map((id) => ({ id, status: "passed" })),
        checkCount: selected.binding.checkIds.length,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("derives host-owned roots when project config is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-cli-missing-config-roots-"));
    try {
      const repository = join(root, "repository");
      const stateDirectory = join(root, "state");
      const home = join(root, "home");
      const stateHome = join(root, "xdg-state");
      await Promise.all(
        [repository, stateDirectory, home, stateHome].map((path) => mkdir(path, { mode: 0o700 })),
      );
      const canonicalRepo = await realpath(repository);
      const canonicalHome = await realpath(home);
      const canonicalStateHome = await realpath(stateHome);
      const expected = resolveDocsFabPublicationRoots(
        { XDG_STATE_HOME: canonicalStateHome },
        join(await realpath(root), "state"),
      );
      const plan = executePlan();
      const captured: string[] = [];
      let prepared = 0;
      await runLocalUserPublishExecuteCli(
        executeArgs(canonicalRepo, plan.sha256, "--state-dir", stateDirectory),
        {
          cwd: root,
          stateDirectory,
          environment: { XDG_STATE_HOME: canonicalStateHome },
          homeDirectory: canonicalHome,
          log: () => undefined,
          preflight: async () => plan,
          prepareWorktree: async (input) => {
            prepared += 1;
            captured.push(input.deliveryRoot);
            return {
              status: "ready",
              worktree: worktree(plan, join(input.deliveryRoot, "repository")),
            };
          },
          inspectReady: async (selected) => ready(plan, selected.worktreePath),
          loadRun: async () => loadedRun(plan, canonicalRepo),
          publisher: {
            git: replayGit(),
            gitlab: replayGitLab(plan),
            assertReady: async () => undefined,
          },
        },
      );
      expect(prepared).toBe(1);
      expect(captured[0]?.startsWith(join(expected.deliveryRoot, "attempts") + "/")).toBe(true);
      expect((await lstat(expected.deliveryRoot)).isDirectory()).toBe(true);
      expect((await lstat(expected.receiptRoot)).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("derives host-owned roots when leftover project config is untracked", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-cli-untracked-config-"));
    try {
      const repository = join(root, "repository");
      const stateDirectory = join(root, "state");
      const home = join(root, "home");
      const stateHome = join(root, "xdg-state");
      await Promise.all(
        [repository, stateDirectory, home, stateHome].map((path) => mkdir(path, { mode: 0o700 })),
      );
      await execute("git", ["init", "-q", "-b", "main"], { cwd: repository });
      await execute("git", ["config", "user.email", "docsfab@example.test"], { cwd: repository });
      await execute("git", ["config", "user.name", "DocsFab"], { cwd: repository });
      await execute("git", ["config", "commit.gpgsign", "false"], { cwd: repository });
      await writeFile(join(repository, "README.md"), "# fixture\n");
      await execute("git", ["add", "README.md"], { cwd: repository });
      await execute("git", ["commit", "-qm", "fixture"], { cwd: repository });
      await writeFile(
        join(repository, ".docsfab.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          gitlab: { remote: "origin", defaultBranch: "main" },
          provider: { configuration: "host" },
          storage: { scope: "user-private" },
        })}\n`,
        { mode: 0o600 },
      );
      const canonicalRepo = await realpath(repository);
      const canonicalHome = await realpath(home);
      const canonicalStateHome = await realpath(stateHome);
      const expected = resolveDocsFabPublicationRoots(
        { XDG_STATE_HOME: canonicalStateHome },
        join(await realpath(root), "state"),
      );
      const plan = executePlan();
      const captured: string[] = [];
      await runLocalUserPublishExecuteCli(
        executeArgs(canonicalRepo, plan.sha256, "--state-dir", stateDirectory),
        {
          cwd: root,
          stateDirectory,
          environment: { XDG_STATE_HOME: canonicalStateHome },
          homeDirectory: canonicalHome,
          log: () => undefined,
          preflight: async () => plan,
          prepareWorktree: async (input) => {
            captured.push(input.deliveryRoot);
            return {
              status: "ready",
              worktree: worktree(plan, join(input.deliveryRoot, "repository")),
            };
          },
          inspectReady: async (selected) => ready(plan, selected.worktreePath),
          loadRun: async () => loadedRun(plan, canonicalRepo),
          publisher: {
            git: replayGit(),
            gitlab: replayGitLab(plan),
            assertReady: async () => undefined,
          },
        },
      );
      expect(captured[0]?.startsWith(join(expected.deliveryRoot, "attempts") + "/")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when tracked project config is invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-cli-invalid-tracked-"));
    try {
      const repository = join(root, "repository");
      const stateDirectory = join(root, "state");
      const home = join(root, "home");
      await Promise.all(
        [repository, stateDirectory, home].map((path) => mkdir(path, { mode: 0o700 })),
      );
      await execute("git", ["init", "-q", "-b", "main"], { cwd: repository });
      await execute("git", ["config", "user.email", "docsfab@example.test"], { cwd: repository });
      await execute("git", ["config", "user.name", "DocsFab"], { cwd: repository });
      await execute("git", ["config", "commit.gpgsign", "false"], { cwd: repository });
      await writeFile(join(repository, "README.md"), "# fixture\n");
      await writeFile(join(repository, ".docsfab.json"), "{not-valid-project-config}\n", {
        mode: 0o600,
      });
      await execute("git", ["add", "."], { cwd: repository });
      await execute("git", ["commit", "-qm", "invalid config"], { cwd: repository });
      const plan = executePlan();
      await expect(
        runLocalUserPublishExecuteCli(
          executeArgs(repository, plan.sha256, "--state-dir", stateDirectory),
          {
            cwd: root,
            stateDirectory,
            homeDirectory: home,
            log: () => undefined,
            preflight: async () => plan,
          },
        ),
      ).rejects.toThrow("Existing DocsFab project configuration is invalid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replays a second execute invocation through a fresh detached recovery worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-cli-replay-"));
    try {
      const repository = join(root, "repository");
      const deliveryRoot = join(root, "delivery");
      const receiptRoot = join(root, "receipts");
      const stateDirectory = join(root, "state");
      await Promise.all([mkdir(repository), mkdir(stateDirectory)]);
      const plan = executePlan();
      const modes: Array<NonNullable<PrepareDeliveryWorktreeInput["sourceBranchMode"]>> = [];
      const expectedRevisions: Array<string | undefined> = [];
      let preflights = 0;
      const logs: string[] = [];
      const git = replayGit();
      const gitlab = replayGitLab(plan);
      const args = executeArgs(
        repository,
        plan.sha256,
        ...privateRootArgs(deliveryRoot, receiptRoot, stateDirectory),
      );
      const invoke = () =>
        runLocalUserPublishExecuteCli(args, {
          cwd: root,
          stateDirectory,
          log: (message) => logs.push(message),
          preflight: async () => {
            preflights += 1;
            if (preflights > 1) throw new Error("mutable preflight must not block receipt replay");
            return plan;
          },
          prepareWorktree: async (input) => {
            modes.push(input.sourceBranchMode ?? "create");
            expectedRevisions.push(input.expectedSourceRevision);
            return {
              status: "ready",
              worktree: worktree(plan, join(input.deliveryRoot, "repository")),
            };
          },
          inspectReady: async (selected) => ready(plan, selected.worktreePath),
          loadRun: async () => loadedRun(plan, repository),
          publisher: { git, gitlab, assertReady: async () => undefined },
        });

      await invoke();
      await invoke();

      expect(modes).toEqual(["create-or-reuse", "rehydrate-published"]);
      expect(expectedRevisions).toEqual([undefined, "c".repeat(40)]);
      expect(preflights).toBe(1);
      expect(gitlab.creates).toBe(1);
      expect(logs).toHaveLength(2);
      expect(JSON.parse(logs[1]!)).toMatchObject({ status: "opened", state: "opened" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resumes a planned receipt after crashing before worktree creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-cli-planned-replay-"));
    try {
      const repository = join(root, "repository");
      const deliveryRoot = join(root, "delivery");
      const receiptRoot = join(root, "receipts");
      const stateDirectory = join(root, "state");
      await Promise.all([mkdir(repository), mkdir(stateDirectory)]);
      const plan = executePlan();
      const modes: Array<NonNullable<PrepareDeliveryWorktreeInput["sourceBranchMode"]>> = [];
      let attempts = 0;
      let preflights = 0;
      const args = executeArgs(
        repository,
        plan.sha256,
        ...privateRootArgs(deliveryRoot, receiptRoot, stateDirectory),
      );
      const invoke = () =>
        runLocalUserPublishExecuteCli(args, {
          cwd: root,
          stateDirectory,
          log: () => undefined,
          preflight: async () => {
            preflights += 1;
            return plan;
          },
          prepareWorktree: async (input) => {
            modes.push(input.sourceBranchMode ?? "create");
            if (++attempts === 1) throw new Error("crash-before-worktree");
            return {
              status: "ready",
              worktree: worktree(plan, join(input.deliveryRoot, "repository")),
            };
          },
          inspectReady: async (selected) => ready(plan, selected.worktreePath),
          loadRun: async () => loadedRun(plan, repository),
          publisher: {
            git: replayGit(),
            gitlab: replayGitLab(plan),
            assertReady: async () => undefined,
          },
        });
      await expect(invoke()).rejects.toMatchObject({
        name: "DeliveryWorktreeError",
        code: "worktree-creation-failed",
      });
      await expect(invoke()).resolves.toMatchObject({
        mergeRequest: {
          iid: 7,
          url: "https://gitlab.example.test/group/docs/-/merge_requests/7",
          draft: true,
        },
      });
      expect(modes).toEqual(["create-or-reuse", "create-or-reuse"]);
      expect(preflights).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["committed", "pushed", "opened"] as const)(
    "rehydrates an exact durable %s receipt before reconciliation",
    async (state) => {
      const root = await mkdtemp(join(tmpdir(), `docsfab-cli-${state}-replay-`));
      try {
        const repository = join(root, "repository");
        const deliveryRoot = join(root, "delivery");
        const receiptRoot = join(root, "receipts");
        const stateDirectory = join(root, "state");
        await Promise.all([mkdir(repository), mkdir(stateDirectory)]);
        const plan = executePlan();
        const commit = "c".repeat(40);
        const authorization = authorizeLocalUserPublication({
          plan,
          confirmedPlanSha256: plan.sha256,
          command: "publish",
        });
        let receipt = createScmDeliveryRecord({
          plan,
          authorization,
          createdAt: new Date().toISOString(),
        });
        const advance = (
          toState: "prepared" | "validated" | "committed" | "pushed" | "opened",
          evidence: never,
        ): void => {
          receipt = recordScmDeliveryProgress(
            receipt,
            {
              toState,
              source: "executed",
              at: new Date(Date.parse(receipt.updatedAt) + 1).toISOString(),
              evidence,
            } as never,
            plan,
            authorization,
          );
        };
        advance("prepared", {
          workspaceKey: "9".repeat(64),
          baseRevision: plan.baseRevision,
        } as never);
        advance("validated", {
          commandSha256: createHash("sha256").update(plan.validationCommand).digest("hex"),
          summarySha256: "2".repeat(64),
          checkCount: 1,
        } as never);
        advance("committed", { sha: commit } as never);
        if (state === "pushed" || state === "opened") {
          advance("pushed", { remoteRevision: commit } as never);
        }
        if (state === "opened") {
          advance("opened", {
            iid: 7,
            url: "https://gitlab.example.test/group/docs/-/merge_requests/7",
            state: "opened",
            draft: true,
            sourceBranch: plan.proposedSourceBranch,
            targetBranch: plan.targetBranch.name,
            headRevision: commit,
          } as never);
        }
        let stored: ScmDeliveryRecord = receipt;
        const receiptStore: ScmDeliveryReceiptStore = {
          loadPlan: async () => plan,
          load: async () => stored,
          claim: async () => ({ record: stored, created: false }),
          compareAndSwap: async (expected, next) => {
            if (stored.sha256 !== expected) throw new Error("receipt conflict");
            stored = next;
            return stored;
          },
        };
        let selectedMode: string | undefined;
        let selectedRevision: string | undefined;
        const git = replayGit(commit, state === "committed" ? undefined : commit);
        const gitlab = replayGitLab(plan, state === "opened" ? commit : undefined);
        await runLocalUserPublishExecuteCli(
          executeArgs(
            repository,
            plan.sha256,
            ...privateRootArgs(deliveryRoot, receiptRoot, stateDirectory),
          ),
          {
            cwd: root,
            stateDirectory,
            log: () => undefined,
            receiptStore,
            prepareWorktree: async (input) => {
              selectedMode = input.sourceBranchMode;
              selectedRevision = input.expectedSourceRevision;
              return {
                status: "ready",
                worktree: worktree(plan, join(input.deliveryRoot, "repository")),
              };
            },
            inspectReady: async (selected) => ready(plan, selected.worktreePath),
            loadRun: async () => loadedRun(plan, repository),
            publisher: { git, gitlab, assertReady: async () => undefined },
          },
        );
        expect(selectedMode).toBe("rehydrate-published");
        expect(selectedRevision).toBe(commit);
        expect(stored).toMatchObject({ state: "opened", disposition: "succeeded" });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["committed", "pushed", "opened"] as const)(
    "reports a revalidation exception from durable %s without corrupting prior slots",
    async (state) => {
      const root = await mkdtemp(join(tmpdir(), `docsfab-cli-${state}-revalidation-`));
      try {
        const repository = join(root, "repository");
        const deliveryRoot = join(root, "delivery");
        const receiptRoot = join(root, "receipts");
        const stateDirectory = join(root, "state");
        await Promise.all([mkdir(repository), mkdir(stateDirectory)]);
        const plan = executePlan();
        const commit = "c".repeat(40);
        const authorization = authorizeLocalUserPublication({
          plan,
          confirmedPlanSha256: plan.sha256,
          command: "publish",
        });
        let receipt = createScmDeliveryRecord({
          plan,
          authorization,
          createdAt: new Date().toISOString(),
        });
        const advance = (
          toState: "prepared" | "validated" | "committed" | "pushed" | "opened",
          evidence: never,
        ): void => {
          receipt = recordScmDeliveryProgress(
            receipt,
            {
              toState,
              source: "executed",
              at: new Date(Date.parse(receipt.updatedAt) + 1).toISOString(),
              evidence,
            } as never,
            plan,
            authorization,
          );
        };
        advance("prepared", {
          workspaceKey: "9".repeat(64),
          baseRevision: plan.baseRevision,
        } as never);
        advance("validated", {
          commandSha256: createHash("sha256").update(plan.validationCommand).digest("hex"),
          summarySha256: "2".repeat(64),
          checkCount: 1,
        } as never);
        advance("committed", { sha: commit } as never);
        if (state === "pushed" || state === "opened") {
          advance("pushed", { remoteRevision: commit } as never);
        }
        if (state === "opened") {
          advance("opened", {
            iid: 7,
            url: "https://gitlab.example.test/group/docs/-/merge_requests/7",
            state: "opened",
            draft: true,
            sourceBranch: plan.proposedSourceBranch,
            targetBranch: plan.targetBranch.name,
            headRevision: commit,
          } as never);
        }
        const durableBefore = structuredClone(receipt);
        let stored: ScmDeliveryRecord = receipt;
        const receiptStore: ScmDeliveryReceiptStore = {
          loadPlan: async () => plan,
          load: async () => stored,
          claim: async () => ({ record: stored, created: false }),
          compareAndSwap: async (expected, next) => {
            expect(stored.sha256).toBe(expected);
            stored = next;
            return stored;
          },
        };
        const logs: string[] = [];
        await expect(
          runLocalUserPublishExecuteCli(
            executeArgs(
              repository,
              plan.sha256,
              ...privateRootArgs(deliveryRoot, receiptRoot, stateDirectory),
            ),
            {
              cwd: root,
              stateDirectory,
              log: (message) => logs.push(message),
              receiptStore,
              prepareWorktree: async (input) => ({
                status: "ready",
                worktree: worktree(plan, join(input.deliveryRoot, "repository")),
              }),
              inspectReady: async () => {
                throw new Error("validator failed at /private/host/worktree");
              },
              loadRun: async () => {
                throw new Error("publication must not start");
              },
            },
          ),
        ).rejects.toMatchObject({
          name: "DeliveryWorktreeError",
          code: "validation-failed",
        });
        const projected = JSON.parse(logs.at(-1)!);
        expect(projected).toMatchObject({
          status: "failed",
          state,
          disposition: state === "opened" ? "succeeded" : "failed",
          failureCode: "validation-failed",
          failurePersistence: state === "opened" ? "failed" : "stored",
          validationFailure: { reasonCode: "validation-exception" },
        });
        expect(JSON.stringify(projected)).not.toContain("/private/host/worktree");
        if (state === "opened") {
          expect(projected).toMatchObject({
            persistenceFailureCode: "receipt-write-failed",
            lastDurableReceiptSha256: durableBefore.sha256,
          });
          expect(projected).not.toHaveProperty("receiptSha256");
          expect(stored).toEqual(durableBefore);
        } else {
          expect(projected.receiptSha256).toBe(stored.sha256);
          expect(stored.attempts.slice(0, durableBefore.attempts.length)).toEqual(
            durableBefore.attempts,
          );
          expect(stored.attempts).toHaveLength(durableBefore.attempts.length + 1);
          expect(stored.evidence).toEqual(durableBefore.evidence);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("emits a fully scoped recovery command and rejects failed execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-cli-failure-"));
    try {
      const repository = join(root, "repository");
      const deliveryRoot = join(root, "delivery");
      const receiptRoot = join(root, "receipts");
      const stateDirectory = join(root, "state");
      await Promise.all([mkdir(repository), mkdir(stateDirectory)]);
      const plan = executePlan();
      const logs: string[] = [];
      const git = replayGit();
      git.ensurePush = async () => {
        throw new Error("push rejected");
      };
      const args = executeArgs(
        repository,
        plan.sha256,
        ...privateRootArgs(deliveryRoot, receiptRoot, stateDirectory),
      );
      await expect(
        runLocalUserPublishExecuteCli(args, {
          cwd: root,
          stateDirectory,
          log: (message) => logs.push(message),
          preflight: async () => plan,
          prepareWorktree: async (input) => ({
            status: "ready",
            worktree: worktree(plan, join(input.deliveryRoot, "repository")),
          }),
          inspectReady: async (selected) => ready(plan, selected.worktreePath),
          loadRun: async () => loadedRun(plan, repository),
          publisher: {
            git,
            gitlab: replayGitLab(plan),
            assertReady: async () => undefined,
          },
        }),
      ).rejects.toMatchObject({ name: "LocalUserGitLabPublisherError", code: "push-failed" });
      const result = JSON.parse(logs.at(-1)!);
      expect(result).toMatchObject({ status: "failed", failureCode: "push-failed" });
      for (const option of ["--repo", "--state-dir", "--delivery-root", "--receipt-root"]) {
        expect(result.recoveryCommand).toContain(option);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("durably records prepared before a validation failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-cli-validation-"));
    try {
      const repository = join(root, "repository");
      const deliveryRoot = join(root, "delivery");
      const receiptRoot = join(root, "receipts");
      const stateDirectory = join(root, "state");
      await Promise.all([mkdir(repository), mkdir(stateDirectory)]);
      const plan = executePlan();
      const logs: string[] = [];
      await expect(
        runLocalUserPublishExecuteCli(
          executeArgs(
            repository,
            plan.sha256,
            ...privateRootArgs(deliveryRoot, receiptRoot, stateDirectory),
          ),
          {
            cwd: root,
            stateDirectory,
            log: (message) => logs.push(message),
            preflight: async () => plan,
            prepareWorktree: async (input) => {
              await input.onPrepared?.({
                workspaceKey: "9".repeat(64),
                baseRevision: plan.baseRevision,
              });
              return {
                status: "failed",
                code: "validation-failed",
                worktree: {
                  ...worktree(plan, join(input.deliveryRoot, "repository")),
                  state: "failed",
                },
              };
            },
          },
        ),
      ).rejects.toMatchObject({ name: "DeliveryWorktreeError", code: "validation-failed" });
      expect(JSON.parse(logs.at(-1)!)).toMatchObject({
        status: "failed",
        state: "prepared",
        disposition: "failed",
        failureCode: "validation-failed",
        failurePersistence: "stored",
        runId: plan.run.id,
        runRecordSha256: plan.run.recordSha256,
        patchSha256: plan.patch.sha256,
        validationFailure: {
          reasonCode: "validation-command-failed",
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers the retained failed attempt idempotently without duplicate SCM effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-cli-validation-recovery-"));
    try {
      const repository = join(root, "repository");
      const deliveryRoot = join(root, "delivery");
      const receiptRoot = join(root, "receipts");
      const stateDirectory = join(root, "state");
      await Promise.all([mkdir(repository), mkdir(stateDirectory)]);
      const plan = executePlan();
      const git = replayGit();
      const gitlab = replayGitLab(plan);
      let preflights = 0;
      let preparations = 0;
      const modes: string[] = [];
      const args = executeArgs(
        repository,
        plan.sha256,
        ...privateRootArgs(deliveryRoot, receiptRoot, stateDirectory),
      );
      const invoke = () =>
        runLocalUserPublishExecuteCli(args, {
          cwd: root,
          stateDirectory,
          log: () => undefined,
          preflight: async () => {
            preflights += 1;
            return plan;
          },
          prepareWorktree: async (input) => {
            preparations += 1;
            modes.push(input.sourceBranchMode ?? "create");
            await input.onPrepared?.({
              workspaceKey: "9".repeat(64),
              baseRevision: plan.baseRevision,
            });
            if (preparations === 1) {
              return {
                status: "failed" as const,
                code: "validation-failed" as const,
                worktree: {
                  ...worktree(plan, join(input.deliveryRoot, "repository")),
                  state: "failed" as const,
                },
              };
            }
            return {
              status: "ready" as const,
              worktree: worktree(plan, join(input.deliveryRoot, "repository")),
            };
          },
          inspectReady: async (selected) => ready(plan, selected.worktreePath),
          loadRun: async () => loadedRun(plan, repository),
          publisher: { git, gitlab, assertReady: async () => undefined },
        });

      await expect(invoke()).rejects.toMatchObject({ code: "validation-failed" });
      const failed = await new FileScmDeliveryReceiptStore(receiptRoot).load(
        scmDeliveryIdempotencyKey(plan),
      );
      expect(failed).toMatchObject({ state: "prepared", disposition: "failed" });
      const failedAttempts = structuredClone(failed!.attempts);

      await expect(invoke()).resolves.toMatchObject({ mergeRequest: { iid: 7 } });
      await expect(invoke()).resolves.toMatchObject({ mergeRequest: { iid: 7 } });

      const recovered = await new FileScmDeliveryReceiptStore(receiptRoot).load(
        scmDeliveryIdempotencyKey(plan),
      );
      expect(recovered).toMatchObject({ state: "opened", disposition: "succeeded" });
      expect(recovered!.attempts.slice(0, failedAttempts.length)).toEqual(failedAttempts);
      expect(modes).toEqual(["create-or-reuse", "reuse-existing", "rehydrate-published"]);
      expect(preflights).toBe(1);
      expect(git.commits).toBe(1);
      expect(git.pushes).toBe(1);
      expect(gitlab.creates).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves isolation unavailability through the receipt and CLI result", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-cli-isolation-unavailable-"));
    try {
      const repository = join(root, "repository");
      const deliveryRoot = join(root, "delivery");
      const receiptRoot = join(root, "receipts");
      const stateDirectory = join(root, "state");
      await Promise.all([mkdir(repository), mkdir(stateDirectory)]);
      const plan = executePlan();
      const logs: string[] = [];
      await expect(
        runLocalUserPublishExecuteCli(
          executeArgs(
            repository,
            plan.sha256,
            ...privateRootArgs(deliveryRoot, receiptRoot, stateDirectory),
          ),
          {
            cwd: root,
            stateDirectory,
            log: (message) => logs.push(message),
            preflight: async () => plan,
            prepareWorktree: async (input) => {
              await input.onPrepared?.({
                workspaceKey: "9".repeat(64),
                baseRevision: plan.baseRevision,
              });
              return {
                status: "failed",
                code: "validation-isolation-unavailable",
                worktree: {
                  ...worktree(plan, join(input.deliveryRoot, "repository")),
                  state: "failed",
                },
              };
            },
          },
        ),
      ).rejects.toMatchObject({
        name: "DeliveryWorktreeError",
        code: "validation-isolation-unavailable",
      });
      expect(JSON.parse(logs.at(-1)!)).toMatchObject({
        status: "failed",
        state: "prepared",
        disposition: "failed",
        failureCode: "validation-isolation-unavailable",
        failurePersistence: "stored",
        validationFailure: {
          reasonCode: "validation-backend-unavailable",
        },
        nextAction: "configure-validation-isolation",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not project unsafe host detail from operator-supervised validation fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-cli-supervised-fallback-"));
    try {
      const repository = join(root, "repository");
      const deliveryRoot = join(root, "delivery");
      const receiptRoot = join(root, "receipts");
      const stateDirectory = join(root, "state");
      await Promise.all([mkdir(repository), mkdir(stateDirectory)]);
      const plan = executePlan();
      const logs: string[] = [];
      const unsafe = `glpat-${"A".repeat(20)} at /tmp/private-validator`;
      await expect(
        runLocalUserPublishExecuteCli(
          executeArgs(
            repository,
            plan.sha256,
            ...privateRootArgs(deliveryRoot, receiptRoot, stateDirectory),
          ),
          {
            cwd: root,
            stateDirectory,
            log: (message) => logs.push(message),
            preflight: async () => plan,
            prepareWorktree: async (input) => {
              input.onValidationIsolationUnavailable?.(unsafe);
              await input.onPrepared?.({
                workspaceKey: "9".repeat(64),
                baseRevision: plan.baseRevision,
              });
              return {
                status: "failed",
                code: "validation-failed",
                worktree: {
                  ...worktree(plan, join(input.deliveryRoot, "repository")),
                  state: "failed",
                },
              };
            },
          },
        ),
      ).rejects.toMatchObject({ code: "validation-failed" });
      expect(logs[0]).toBe(
        "Warning: the delivery-worktree confinement check was unavailable. This eligible interactive execution proceeds with operator-supervised validation; configure Docker Desktop (macOS) or Bubblewrap (Linux) before unattended publish.",
      );
      expect(logs.join("\n")).not.toContain(unsafe);
      expect(logs.join("\n")).not.toContain("/tmp/private-validator");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["prepare", "inspect"] as const)(
    "retains a safe failed attempt when %s throws after preparation",
    async (failurePoint) => {
      const root = await mkdtemp(join(tmpdir(), `docsfab-cli-thrown-${failurePoint}-`));
      try {
        const repository = join(root, "repository");
        const deliveryRoot = join(root, "delivery");
        const receiptRoot = join(root, "receipts");
        const stateDirectory = join(root, "state");
        await Promise.all([mkdir(repository), mkdir(stateDirectory)]);
        const plan = executePlan();
        const logs: string[] = [];
        await expect(
          runLocalUserPublishExecuteCli(
            executeArgs(
              repository,
              plan.sha256,
              ...privateRootArgs(deliveryRoot, receiptRoot, stateDirectory),
            ),
            {
              cwd: root,
              stateDirectory,
              log: (message) => logs.push(message),
              preflight: async () => plan,
              prepareWorktree: async (input) => {
                await input.onPrepared?.({
                  workspaceKey: "9".repeat(64),
                  baseRevision: plan.baseRevision,
                });
                if (failurePoint === "prepare") {
                  throw new DeliveryWorktreeError("validation-failed");
                }
                return {
                  status: "ready",
                  worktree: worktree(plan, join(input.deliveryRoot, "repository")),
                };
              },
              inspectReady: async (selected) => {
                if (failurePoint === "inspect") {
                  throw new Error("private validation output at /tmp/secret");
                }
                return ready(plan, selected.worktreePath);
              },
            },
          ),
        ).rejects.toMatchObject({
          name: "DeliveryWorktreeError",
          code: "validation-failed",
          validation: { reasonCode: "validation-exception" },
        });
        const projected = JSON.parse(logs.at(-1)!);
        expect(projected).toMatchObject({
          status: "failed",
          planSha256: plan.sha256,
          runId: plan.run.id,
          runRecordSha256: plan.run.recordSha256,
          patchSha256: plan.patch.sha256,
          state: "prepared",
          disposition: "failed",
          failureCode: "validation-failed",
          failurePersistence: "stored",
          validationFailure: { reasonCode: "validation-exception" },
        });
        expect(JSON.stringify(projected)).not.toContain("/tmp/secret");
        const stored = await new FileScmDeliveryReceiptStore(receiptRoot).load(
          scmDeliveryIdempotencyKey(plan),
        );
        expect(stored).toMatchObject({
          run: plan.run,
          planSha256: plan.sha256,
          patch: { sha256: plan.patch.sha256, preserved: true },
          state: "prepared",
          disposition: "failed",
          failure: {
            code: "validation-failed",
            validation: { reasonCode: "validation-exception" },
          },
        });
        expect(stored?.attempts.at(-1)).toMatchObject({
          outcome: "failed",
          failureCode: "validation-failed",
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("reports a failed-attempt store write without claiming the failure was retained", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-cli-failure-store-"));
    try {
      const repository = join(root, "repository");
      const deliveryRoot = join(root, "delivery");
      const receiptRoot = join(root, "receipts");
      const stateDirectory = join(root, "state");
      await Promise.all([mkdir(repository), mkdir(stateDirectory)]);
      const plan = executePlan();
      let stored: ScmDeliveryRecord | undefined;
      const store: ScmDeliveryReceiptStore = {
        load: async () => stored,
        loadPlan: async () => undefined,
        claim: async (record, _boundPlan, assertAuthorized) => {
          assertAuthorized?.();
          stored = record;
          return { record, created: true };
        },
        compareAndSwap: async (expected, record, assertAuthorized) => {
          if (record.disposition === "failed") {
            throw new Error("receipt write failed at /tmp/private-store");
          }
          assertAuthorized?.();
          expect(stored?.sha256).toBe(expected);
          stored = record;
          return record;
        },
      };
      const logs: string[] = [];
      await expect(
        runLocalUserPublishExecuteCli(
          executeArgs(
            repository,
            plan.sha256,
            ...privateRootArgs(deliveryRoot, receiptRoot, stateDirectory),
          ),
          {
            cwd: root,
            stateDirectory,
            log: (message) => logs.push(message),
            receiptStore: store,
            preflight: async () => plan,
            prepareWorktree: async (input) => {
              await input.onPrepared?.({
                workspaceKey: "9".repeat(64),
                baseRevision: plan.baseRevision,
              });
              return {
                status: "failed",
                code: "validation-failed",
                worktree: {
                  ...worktree(plan, join(input.deliveryRoot, "repository")),
                  state: "failed",
                },
              };
            },
          },
        ),
      ).rejects.toMatchObject({ code: "validation-failed" });
      const projected = JSON.parse(logs.at(-1)!);
      expect(projected).toMatchObject({
        status: "failed",
        state: "prepared",
        disposition: "active",
        failurePersistence: "failed",
        persistenceFailureCode: "receipt-write-failed",
        lastDurableReceiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      expect(projected).not.toHaveProperty("receiptSha256");
      expect(JSON.stringify(projected)).not.toContain("/tmp/private-store");
      expect(stored).toMatchObject({
        state: "prepared",
        disposition: "active",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("downgrades externally supplied stale candidate diagnostics to an identity-free exception", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-cli-untrusted-validation-"));
    try {
      const repository = join(root, "repository");
      const deliveryRoot = join(root, "delivery");
      const receiptRoot = join(root, "receipts");
      const stateDirectory = join(root, "state");
      await Promise.all([mkdir(repository), mkdir(stateDirectory)]);
      const documentationValidation = selectDocumentationValidationProfile({
        workflow: "update-documentation",
        changedPaths: ["docs/guide.md"],
        hostPolicySha256: validationBackendPolicySha256(),
        applicabilitySha256: "5".repeat(64),
      }).binding;
      const plan = executePlan({ documentationValidation });
      const staleCandidate = "b".repeat(64);
      const logs: string[] = [];
      await expect(
        runLocalUserPublishExecuteCli(
          executeArgs(
            repository,
            plan.sha256,
            ...privateRootArgs(deliveryRoot, receiptRoot, stateDirectory),
          ),
          {
            cwd: root,
            stateDirectory,
            log: (message) => logs.push(message),
            preflight: async () => plan,
            prepareWorktree: async (input) => {
              await input.onPrepared?.({
                workspaceKey: "9".repeat(64),
                baseRevision: plan.baseRevision,
              });
              return {
                status: "ready",
                worktree: worktree(plan, join(input.deliveryRoot, "repository")),
              };
            },
            inspectReady: async () => {
              throw new DeliveryWorktreeError("validation-failed", {
                reasonCode: "validation-check-failed",
                planSha256: plan.sha256,
                runId: plan.run.id,
                runRecordSha256: plan.run.recordSha256,
                patchSha256: plan.patch.sha256,
                workspaceKey: "9".repeat(64),
                candidateTreeSha256: staleCandidate,
                profileId: plan.documentationValidation!.profileId,
                profileVersion: plan.documentationValidation!.profileVersion,
                checkIds: [...plan.documentationValidation!.checkIds],
                selectorInputSha256: plan.documentationValidation!.selectorInputSha256,
                validatorIdentity: plan.documentationValidation!.validatorIdentity,
                applicabilitySha256: plan.documentationValidation!.applicabilitySha256,
                checkSetSha256: plan.documentationValidation!.checkSetSha256,
                results: [{ id: "documentation-relative-links", status: "failed" }],
              });
            },
          },
        ),
      ).rejects.toMatchObject({ code: "validation-failed" });
      const projected = JSON.parse(logs.at(-1)!);
      expect(projected.validationFailure).toEqual({ reasonCode: "validation-exception" });
      expect(JSON.stringify(projected)).not.toContain(staleCandidate);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires current authority immediately before publication-root creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-cli-root-expiry-"));
    try {
      const repository = join(root, "repository");
      const deliveryRoot = join(root, "delivery");
      const receiptRoot = join(root, "receipts");
      const stateDirectory = join(root, "state");
      await Promise.all([mkdir(repository), mkdir(stateDirectory)]);
      const plan = executePlan();
      let checks = 0;
      await expect(
        runLocalUserPublishExecuteCli(
          executeArgs(
            repository,
            plan.sha256,
            ...privateRootArgs(deliveryRoot, receiptRoot, stateDirectory),
          ),
          {
            cwd: root,
            stateDirectory,
            log: () => undefined,
            preflight: async () => plan,
            clock: () =>
              new Date(++checks === 1 ? "2026-08-04T12:00:00.000Z" : "2026-08-04T13:00:00.000Z"),
          },
        ),
      ).rejects.toBeDefined();
      await expect(lstat(deliveryRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(receiptRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rechecks current authority inside the prepared receipt CAS boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-cli-prepared-cas-expiry-"));
    try {
      const repository = join(root, "repository");
      const deliveryRoot = join(root, "delivery");
      const receiptRoot = join(root, "receipts");
      const stateDirectory = join(root, "state");
      await Promise.all([mkdir(repository), mkdir(stateDirectory)]);
      const plan = executePlan();
      let current = new Date("2026-08-04T12:00:00.000Z");
      let stored: ScmDeliveryRecord | undefined;
      let persisted = false;
      const receiptStore: ScmDeliveryReceiptStore = {
        loadPlan: async () => undefined,
        load: async () => stored,
        claim: async (record, _plan, assertAuthorized) => {
          assertAuthorized?.();
          stored = record;
          return { record, created: true };
        },
        compareAndSwap: async (_expected, record, assertAuthorized) => {
          current = new Date("2026-08-04T13:00:00.000Z");
          assertAuthorized?.();
          persisted = true;
          stored = record;
          return record;
        },
      };
      await expect(
        runLocalUserPublishExecuteCli(
          executeArgs(
            repository,
            plan.sha256,
            ...privateRootArgs(deliveryRoot, receiptRoot, stateDirectory),
          ),
          {
            cwd: root,
            stateDirectory,
            log: () => undefined,
            receiptStore,
            preflight: async () => plan,
            clock: () => current,
            prepareWorktree: async (input) => {
              await input.onPrepared?.({
                workspaceKey: "9".repeat(64),
                baseRevision: plan.baseRevision,
              });
              return {
                status: "ready",
                worktree: worktree(plan, join(input.deliveryRoot, "repository")),
              };
            },
          },
        ),
      ).rejects.toBeDefined();
      expect(persisted).toBe(false);
      expect(stored).toMatchObject({ state: "planned", disposition: "active" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("local-user publish CLI evidence narrative wiring (#129)", () => {
  it("renders the evidence-aware draft-MR narrative from run-record task lineage", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-cli-evidence-"));
    try {
      const repository = join(root, "repository");
      const deliveryRoot = join(root, "delivery");
      const receiptRoot = join(root, "receipts");
      const stateDirectory = join(root, "state");
      await Promise.all([mkdir(repository), mkdir(stateDirectory)]);
      const plan = evidencePlan();
      const taskLineage = await operatorDirectedProjection();
      const git = replayGit(EVIDENCE_BASE);
      const opened: string[] = [];
      const gitlab = echoingGitLab(plan, opened);
      await runLocalUserPublishExecuteCli(
        executeArgs(
          repository,
          plan.sha256,
          ...privateRootArgs(deliveryRoot, receiptRoot, stateDirectory),
        ),
        {
          cwd: root,
          stateDirectory,
          log: () => undefined,
          preflight: async () => plan,
          prepareWorktree: async (input) => ({
            status: "ready",
            worktree: worktree(plan, join(input.deliveryRoot, "repository")),
          }),
          inspectReady: async (selected) => ready(plan, selected.worktreePath),
          loadRun: async () => loadedRun(plan, repository, { taskLineage }),
          publisher: { git, gitlab, assertReady: async () => undefined },
        },
      );

      // A real publish cycle emitted the evidence-aware narrative into the MR body.
      expect(opened).toHaveLength(1);
      const description = opened[0]!;
      expect(description).toContain("### Provenance evidence");
      expect(description).toContain("**Task origin:** `operator-directed`");
      expect(description).toContain("A maintainer directed this task");
      expect(description).not.toMatch(/glpat-|PRIVATE-TOKEN/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("local-user publish CLI Result from workflowOutcome (#246)", () => {
  it("forwards sealed productOutcome into draft-MR Result metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-cli-result-outcome-"));
    try {
      const repository = join(root, "repository");
      const deliveryRoot = join(root, "delivery");
      const receiptRoot = join(root, "receipts");
      const stateDirectory = join(root, "state");
      await Promise.all([mkdir(repository), mkdir(stateDirectory)]);
      const plan = executePlan();
      const catalog = "Improve governed documentation";
      const productOutcome = {
        schemaVersion: 1,
        kind: "docsfab-workflow-outcome",
        disposition: "inconclusive",
        findings: [
          {
            id: "finding:structured-product-evidence-unavailable",
            kind: "evidence-limitation",
            severity: "warning",
            code: "structured-product-evidence-unavailable",
            evidenceIds: ["step:apply"],
          },
        ],
        evidence: [{ id: "step:apply", kind: "step", stepId: "apply", sha256: "a".repeat(64) }],
        limitations: ["structured-product-evidence-unavailable"],
        openDecisions: [],
        producedArtifacts: [],
        outcomeSha256: "b".repeat(64),
      } as const;
      const opened: string[] = [];
      const titles: string[] = [];
      const git = replayGit();
      const gitlab = echoingGitLab(plan, opened, titles);
      await runLocalUserPublishExecuteCli(
        executeArgs(
          repository,
          plan.sha256,
          ...privateRootArgs(deliveryRoot, receiptRoot, stateDirectory),
        ),
        {
          cwd: root,
          stateDirectory,
          log: () => undefined,
          preflight: async () => plan,
          prepareWorktree: async (input) => ({
            status: "ready",
            worktree: worktree(plan, join(input.deliveryRoot, "repository")),
          }),
          inspectReady: async (selected) => ready(plan, selected.worktreePath),
          loadRun: async () =>
            loadedRun(plan, repository, {
              workflowOutcome: catalog,
              taskLineage: null,
              productOutcome,
            }),
          publisher: { git, gitlab, assertReady: async () => undefined },
        },
      );

      expect(opened).toHaveLength(1);
      expect(opened[0]).toContain("**Product disposition:** `inconclusive`");
      expect(opened[0]).toContain("structured-product-evidence-unavailable");
      expect(opened[0]).toContain(`**Catalog outcome (subtitle):** *${catalog}*`);
      expect(titles[0]).toBe(
        "Draft: [DocsFab Run] inconclusive — structured-product-evidence-unavailable",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("local-user publish CLI required-check notes (#1918)", () => {
  it("forwards the run's required-check lines into the draft-MR Notes", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-cli-required-check-"));
    try {
      const repository = join(root, "repository");
      const deliveryRoot = join(root, "delivery");
      const receiptRoot = join(root, "receipts");
      const stateDirectory = join(root, "state");
      await Promise.all([mkdir(repository), mkdir(stateDirectory)]);
      const plan = executePlan();
      const line =
        "required check could not run: `ruff format .` (unsupported check form). Next action: run this command from the repository root, as `AGENTS.md` requires, before you merge this change.";
      const opened: string[] = [];
      const gitlab = echoingGitLab(plan, opened);
      await runLocalUserPublishExecuteCli(
        executeArgs(
          repository,
          plan.sha256,
          ...privateRootArgs(deliveryRoot, receiptRoot, stateDirectory),
        ),
        {
          cwd: root,
          stateDirectory,
          log: () => undefined,
          preflight: async () => plan,
          prepareWorktree: async (input) => ({
            status: "ready",
            worktree: worktree(plan, join(input.deliveryRoot, "repository")),
          }),
          inspectReady: async (selected) => ready(plan, selected.worktreePath),
          loadRun: async () =>
            loadedRun(plan, repository, { taskLineage: null, requiredCheckLimitations: [line] }),
          publisher: { git: replayGit(), gitlab, assertReady: async () => undefined },
        },
      );

      expect(opened).toHaveLength(1);
      expect(opened[0]).toContain(`## Notes\n\n- ${line}\n`);
      expect(opened[0]).toContain("- **Limitations:** `required-check-not-run`");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const EVIDENCE_BASE = "2".repeat(40);

const evidenceLineageFixture = buildCurrentTaskLineageFixture();

function evidencePlan(): LocalUserPublicationPlanV2 {
  const base = executePlan();
  const candidate = { ...base, baseRevision: EVIDENCE_BASE } as Omit<
    LocalUserPublicationPlanV2,
    "sha256"
  >;
  return { ...candidate, sha256: localUserPublicationPlanSha256(candidate as never) };
}

async function operatorDirectedProjection(): Promise<TaskLineageProjectionV1> {
  const origin: TaskOriginInputV1 = {
    lineageId: "lineage:operator-directed",
    repository: structuredClone(evidenceLineageFixture.repository),
    request: structuredClone(evidenceLineageFixture.request),
    origin: "operator-directed",
    selectedBy: "operator",
    approval: structuredClone(evidenceLineageFixture.approval),
    recommendation: null,
    autonomousSelection: null,
  };
  const taskDecision: DecisionAttributionInputV1 = {
    id: "decision:task",
    domain: "task",
    actor: "operator",
    effect: "authoritative",
    outcomeSha256: evidenceLineageFixture.request.taskSha256!,
    authoritySource: "operator-approval",
    authoritySha256: evidenceLineageFixture.approval.approvalSha256,
    evidenceSha256s: [evidenceLineageFixture.request.requestSha256!],
    boundedByDecisionIds: [],
    reasonCode: "operator-directed",
  };
  const capability = await mintTaskLineageHostCapability(
    {
      origin,
      lineage: {
        lineageId: "lineage:operator-directed",
        candidates: structuredClone(evidenceLineageFixture.candidates),
        selectedCandidateSha256: evidenceLineageFixture.selectedCandidateSha256,
        selectedSourceAutoCandidateSha256: null,
        rejectedAlternatives: structuredClone(evidenceLineageFixture.rejectedAlternatives),
        decisions: [taskDecision, ...structuredClone(evidenceLineageFixture.sharedDecisions)],
      },
    },
    internalCreateTaskLineageHostAuthority({
      async verifyCurrent(challenge) {
        return {
          status: "current" as const,
          challengeSha256: challenge.challengeSha256,
          observedAt: "2026-08-05T18:00:00.000Z",
          authorityReceiptSha256: "a".repeat(64),
        };
      },
    }),
  );
  const artifacts = createTaskLineageArtifacts(capability);
  return projectTaskLineage(artifacts.origin, artifacts.lineage);
}

function echoingGitLab(
  plan: LocalUserPublicationPlan,
  opened: string[],
  titles: string[] = [],
): GitLabPublisherAdapter & { creates: number } {
  let request: GitLabMergeRequest | undefined;
  const adapter: GitLabPublisherAdapter & { creates: number } = {
    creates: 0,
    inspectPolicy: async () => ({
      username: "maintainer",
      projectId: plan.project.id,
      projectPath: plan.project.path,
      accessLevel: 30,
      defaultBranch: "main",
      targetBranch: {
        name: plan.targetBranch.name,
        protected: plan.targetBranch.protected,
        revision: plan.baseRevision,
      },
      sourceBranchProtected: false,
    }),
    findMergeRequests: async () => (request ? [request] : []),
    openDraftMergeRequest: async ({ headRevision, description, title }) => {
      adapter.creates += 1;
      opened.push(description);
      titles.push(title);
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
        title,
        description,
      };
      return request;
    },
  };
  return adapter;
}

/** Execute-phase publish argv; per-test options follow the shared confirmation prefix. */
function executeArgs(repository: string, planSha256: string, ...options: string[]): string[] {
  return [
    "run-1",
    "--repo",
    repository,
    "--draft-mr",
    "--execute",
    "--confirm-plan-sha256",
    planSha256,
    ...options,
  ];
}

function privateRootArgs(deliveryRoot: string, receiptRoot: string, stateDirectory: string) {
  return [
    "--delivery-root",
    deliveryRoot,
    "--receipt-root",
    receiptRoot,
    "--state-dir",
    stateDirectory,
  ];
}

/** Saved run loaded for `plan`; `extra` adds or replaces fields per test. */
function loadedRun(
  plan: LocalUserPublicationPlan,
  sourcePath: string,
  extra: Record<string, unknown> = {},
): never {
  return {
    id: plan.run.id,
    recordSha256: plan.run.recordSha256,
    revision: plan.baseRevision,
    sourcePath,
    workflowOutcome: "Improve governed documentation",
    changedFiles: [{ path: "docs/guide.md", status: "modified" }],
    changedFileCount: 1,
    patch: { ...plan.patch, bytes: Buffer.from("patch") },
    ...extra,
  } as never;
}

function executePlan(
  overrides: {
    projectPath?: string;
    documentationValidation?: LocalUserPublicationPlanV2["documentationValidation"];
  } = {},
): LocalUserPublicationPlanV2 {
  const candidate = {
    schemaVersion: 2 as const,
    kind: "docsfab-local-user-gitlab-publication-plan" as const,
    deliveryMode: "local-user" as const,
    authorityBasis: "interactive-once" as const,
    run: { id: "run-1", recordSha256: "d".repeat(64) },
    project: {
      id: 42,
      host: "gitlab.example.test",
      path: overrides.projectPath ?? "group/docs",
    },
    remote: { name: "origin", transport: "ssh" as const },
    identity: {
      git: "configured" as const,
      gitIdentitySha256: localUserGitIdentitySha256("Maintainer", "maintainer@example.test"),
      gitlabUsername: "maintainer",
    },
    baseRevision: "a".repeat(40),
    targetBranch: { name: "main", protected: true },
    proposedSourceBranch: "docsfab-run/run-1",
    patch: {
      format: "git-diff" as const,
      sha256: createHash("sha256").update("patch").digest("hex"),
      byteLength: 5,
      changedFileCount: 1,
    },
    validationCommand: overrides.documentationValidation ? "test -d ." : "npm run check",
    ...(overrides.documentationValidation
      ? { documentationValidation: overrides.documentationValidation }
      : {}),
    mergeRequest: { draft: true as const },
    fallback: { mode: "patch-only" as const, preserved: true as const },
    checks: {
      repository: "passed" as const,
      remote: "passed" as const,
      revision: "current" as const,
      gitIdentity: "configured" as const,
      gitlabAuthentication: "authenticated" as const,
      pushAccess: "allowed" as const,
      sourceBranch: "unprotected" as const,
    },
  };
  return { ...candidate, sha256: localUserPublicationPlanSha256(candidate) };
}

function executeCurrentDocumentationPlan(
  documentationValidation: NonNullable<LocalUserPublicationPlanV2["documentationValidation"]>,
): LocalUserPublicationPlanV2 {
  const { schemaVersion: _schemaVersion, sha256: _sha256, ...legacy } = executePlan();
  const candidate = {
    ...legacy,
    schemaVersion: 2 as const,
    validationCommand: "test -d .",
    documentationValidation,
  };
  return { ...candidate, sha256: localUserPublicationPlanSha256(candidate) };
}

function worktree(plan: LocalUserPublicationPlan, path: string) {
  return {
    schemaVersion: 1 as const,
    kind: "docsfab-delivery-worktree-capability" as const,
    runId: plan.run.id,
    planSha256: plan.sha256,
    repositoryPath: "/source",
    capsulePath: join(path, ".."),
    worktreePath: path,
    patchPath: join(path, "..", "patch.diff"),
    branch: plan.proposedSourceBranch,
    baseRevision: plan.baseRevision,
    patchSha256: plan.patch.sha256,
    changedFilesSha256: "8".repeat(64),
    state: "ready" as const,
  };
}

function ready(plan: LocalUserPublicationPlan, path: string): DeliveryWorktreeReadyAttestation {
  const results = plan.documentationValidation?.checkIds.map((id) => ({
    id,
    status: "passed" as const,
  }));
  return {
    schemaVersion: 1,
    kind: "docsfab-delivery-worktree-ready-attestation",
    runId: plan.run.id,
    planSha256: plan.sha256,
    worktreePath: path,
    baseRevision: plan.baseRevision,
    tree: "b".repeat(40),
    workspaceKey: "9".repeat(64),
    patch: { sha256: plan.patch.sha256, byteLength: plan.patch.byteLength },
    validation: {
      commandSha256: createHash("sha256").update(plan.validationCommand).digest("hex"),
      stateSha256: "2".repeat(64),
      ...(plan.documentationValidation
        ? {
            profileId: plan.documentationValidation.profileId,
            profileVersion: plan.documentationValidation.profileVersion,
            checkIds: [...plan.documentationValidation.checkIds],
            selectorInputSha256: plan.documentationValidation.selectorInputSha256,
            validatorIdentity: plan.documentationValidation.validatorIdentity,
            ...(plan.documentationValidation.schemaVersion === 2
              ? { applicabilitySha256: plan.documentationValidation.applicabilitySha256 }
              : {}),
            candidateTreeSha256: "3".repeat(64),
            checkSetSha256: plan.documentationValidation.checkSetSha256,
            resultSha256: documentationResultSha256(plan.documentationValidation, results!),
            results,
          }
        : {}),
    },
    metadata: publicationMetadataInputDigests("Improve governed documentation", ["docs/guide.md"]),
  };
}

function documentationResultSha256(
  binding: NonNullable<LocalUserPublicationPlan["documentationValidation"]>,
  results: readonly { id: string; status: "passed" }[],
  stateSha256 = "2".repeat(64),
  candidateTreeSha256 = "3".repeat(64),
): string {
  return documentationValidationKit.canonicalDigest({
    results,
    stateSha256,
    checkSetSha256: binding.checkSetSha256,
    candidateTreeSha256,
    ...(binding.schemaVersion === 2 ? { applicabilitySha256: binding.applicabilitySha256 } : {}),
  });
}

function replayGit(
  initialLocal = "a".repeat(40),
  initialRemote?: string,
): LocalGitPublisher & { local: string; remote?: string; commits: number; pushes: number } {
  const adapter = {
    local: initialLocal,
    remote: initialRemote,
    commits: 0,
    pushes: 0,
    assertConfiguredIdentity: async () => undefined,
    localBranchRevision: async () => adapter.local,
    remoteBranchRevision: async () => adapter.remote,
    ensureCommit: async () => {
      adapter.commits += 1;
      adapter.local = "c".repeat(40);
      return adapter.local;
    },
    ensurePush: async () => {
      adapter.pushes += 1;
      adapter.remote = adapter.local;
      return adapter.remote;
    },
    assertCommit: async ({ commitRevision }: { commitRevision: string }) => {
      if (commitRevision !== adapter.local) throw new Error("commit mismatch");
    },
  };
  return adapter;
}

function replayGitLab(
  plan: LocalUserPublicationPlan,
  existingHeadRevision?: string,
): GitLabPublisherAdapter & { creates: number } {
  const metadata = buildDocsFabPublicationMetadata({
    plan,
    workflowOutcome: "Improve governed documentation",
    changedPaths: ["docs/guide.md"],
  });
  const mergeRequest = (headRevision: string): GitLabMergeRequest => ({
    iid: 7,
    url: `https://${plan.project.host}/${plan.project.path}/-/merge_requests/7`,
    state: "opened",
    draft: true,
    sourceBranch: plan.proposedSourceBranch,
    targetBranch: plan.targetBranch.name,
    headRevision,
    sourceProjectId: plan.project.id,
    targetProjectId: plan.project.id,
    title: metadata.mergeRequestTitle,
    description: metadata.mergeRequestDescription,
  });
  let request = existingHeadRevision ? mergeRequest(existingHeadRevision) : undefined;
  const adapter: GitLabPublisherAdapter & { creates: number } = {
    creates: 0,
    inspectPolicy: async () => ({
      username: "maintainer",
      projectId: plan.project.id,
      projectPath: plan.project.path,
      accessLevel: 30,
      defaultBranch: "main",
      targetBranch: {
        name: plan.targetBranch.name,
        protected: plan.targetBranch.protected,
        revision: plan.baseRevision,
      },
      sourceBranchProtected: false,
    }),
    findMergeRequests: async () => (request ? [request] : []),
    openDraftMergeRequest: async ({ headRevision }) => {
      adapter.creates += 1;
      request = mergeRequest(headRevision);
      return request;
    },
  };
  return adapter;
}
