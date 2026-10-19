// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { limit } from "../src/config/limits.js";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildDocsFabPublicationMetadata,
  authorizeLocalUserPublication,
  createScmDeliveryRecord,
  decodeLocalUserGitLabPublicationResult,
  failScmDeliveryRecord,
  FileScmDeliveryReceiptStore,
  localUserGitIdentitySha256,
  localUserPublicationPlanSha256,
  publicationMetadataInputDigests,
  recordScmDeliveryProgress,
  runLocalUserPublishExecuteCli,
  scmDeliveryIdempotencyKey,
  scmDeliveryRecordSha256,
  type DeliveryWorktreeReadyAttestation,
  type GitLabMergeRequest,
  type GitLabPublisherAdapter,
  type LocalGitPublisher,
  type LocalUserPublicationPlan,
  type LocalUserPublicationPlanV2,
  type ScmDeliveryRecord,
} from "../src/delivery/index.js";
import {
  findMergeRequestDelivery,
  findMergeRequestDeliveryByPath,
  findRunDelivery,
  listMergeRequestDeliveries,
  lookupSavedRunDelivery,
  parseMergeRequestUrl,
  recordRunDelivery,
  RunDeliveryIndexContractError,
  runDeliveryMergeRequestKey,
  runDeliveryMergeRequestPathKey,
  runDeliveryRunKey,
  type RunDeliveryIndexKeySpace,
  type RunDeliveryLookup,
} from "../src/delivery/run-delivery-index.js";
import {
  applyRunDeliveryDeletion,
  countRemainingRunDeliveryTargets,
  inventoryRunDelivery,
  recordRunDeliveryAttemptLocation,
} from "../src/delivery/run-deletion-adapter.js";
import { deliveryCapsuleName } from "../src/delivery/worktree/materialize.js";
import {
  inspectRunDeliveryWorktree,
  worktreeCleanupEvidenceDigest,
} from "../src/delivery/worktree/run-deletion-cleanup.js";
import {
  createProductionManagedPublish,
  submitAfterSucceededRun,
} from "../src/autonomy/managed-publish-host.js";
import { decodeFailedPublicationOutcome } from "../src/cli/run/delivery.js";
import { handleRunsCommand } from "../src/cli/commands/runs.js";
import {
  buildRunResultV1,
  collectRunResultNextSteps,
  decodeRunResultV1,
  defaultRunRecordPath,
  formatRunSummary,
  type RunSummaryContext,
} from "../src/operator/index.js";
import { canonicalizeJsonEvidence, parseJsonEvidence } from "../src/json-evidence.js";
import type { RunRecord } from "../src/records/contracts.js";
import { FileRunStore } from "../src/records/file-store.js";
import { applyRunDeletion, previewRunDeletion } from "../src/records/run-deletion.js";
import { authoringReviewFindingsRecord } from "./helpers/authoring-review-record.js";
import {
  interactiveWorkflowOutcomePolicy,
  workflowOutcomeExitCode,
} from "../src/workflow-contracts/outcome.js";

const roots: string[] = [];
const HOST = "gitlab.example.test";
const PATCH = Buffer.from("patch");
const ENTRY_MAX_BYTES = "DOCSFAB_DELIVERY_RUN_DELIVERY_INDEX_ENTRY_MAX_BYTES";
const ENTRIES_PER_KEY = "DOCSFAB_DELIVERY_RUN_DELIVERY_INDEX_ENTRIES_PER_KEY";

// Each case drives the real local-user publish execute path on a shared host.
vi.setConfig({ testTimeout: 120_000 });

afterEach(async () => {
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Layout {
  root: string;
  repository: string;
  stateDirectory: string;
  deliveryRoot: string;
  /** `resolveDocsFabPublicationRoots(env, stateDirectory).receiptRoot`. */
  canonicalReceiptRoot: string;
}

async function layout(): Promise<Layout> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-run-index-")));
  roots.push(root);
  const repository = join(root, "repository");
  const stateDirectory = join(root, "state");
  await Promise.all([mkdir(repository), mkdir(stateDirectory)]);
  return {
    root,
    repository,
    stateDirectory,
    deliveryRoot: join(root, "delivery"),
    canonicalReceiptRoot: join(root, "receipts"),
  };
}

async function observationSnapshot(root: string): Promise<unknown[]> {
  const entries: unknown[] = [];
  const visit = async (path: string): Promise<void> => {
    const current = await lstat(path);
    const identity = { path, mode: current.mode };
    if (current.isSymbolicLink()) {
      entries.push({ ...identity, target: await readlink(path) });
    } else if (current.isDirectory()) {
      entries.push(identity);
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    } else {
      entries.push({
        ...identity,
        sha256: createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      });
    }
  };
  await visit(root);
  return entries;
}

interface Delivery {
  plan: LocalUserPublicationPlanV2;
  iid: number;
  git: ReturnType<typeof fakeGit>;
  gitlab: ReturnType<typeof fakeGitLab>;
}

function delivery(
  options: {
    runId?: string;
    projectId?: number;
    host?: string;
    path?: string;
    iid?: number;
    commit?: string;
    failOpen?: boolean;
    recordSha256?: string;
    baseRevision?: string;
    patchBytes?: Buffer;
  } = {},
): Delivery {
  const plan = makePlan(options);
  const iid = options.iid ?? 7;
  return {
    plan,
    iid,
    git: fakeGit(options.commit ?? "c".repeat(40)),
    gitlab: fakeGitLab(plan, iid, options.failOpen === true),
  };
}

/** Publish through the real execute CLI, publisher and file receipt store; forge and git are fakes. */
async function publish(
  where: Layout,
  target: Delivery,
  options: { receiptRoot?: string; environment?: NodeJS.ProcessEnv } = {},
): Promise<{ logs: string[]; error?: unknown }> {
  const logs: string[] = [];
  const { plan } = target;
  try {
    await runLocalUserPublishExecuteCli(
      [
        plan.run.id,
        "--repo",
        where.repository,
        "--draft-mr",
        "--execute",
        "--confirm-plan-sha256",
        plan.sha256,
        "--delivery-root",
        where.deliveryRoot,
        "--receipt-root",
        options.receiptRoot ?? where.canonicalReceiptRoot,
        "--state-dir",
        where.stateDirectory,
      ],
      executeDependencies(where, target, logs, options.environment),
    );
    return { logs };
  } catch (error) {
    return { logs, error };
  }
}

function executeDependencies(
  where: Layout,
  target: Delivery,
  logs: string[],
  environment: NodeJS.ProcessEnv = { ...process.env },
) {
  const { plan } = target;
  return {
    cwd: where.root,
    stateDirectory: where.stateDirectory,
    environment,
    log: (message: string) => logs.push(message),
    preflight: async () => plan,
    prepareWorktree: async (input: { deliveryRoot: string }) => ({
      status: "ready" as const,
      worktree: worktree(plan, join(input.deliveryRoot, "repository")),
    }),
    inspectReady: async (selected: { worktreePath: string }) => ready(plan, selected.worktreePath),
    loadRun: async () => loadedRun(plan, where.repository),
    publisher: {
      git: target.git,
      gitlab: target.gitlab,
      assertReady: async () => undefined,
    },
  };
}

function lastLine(logs: readonly string[]): Record<string, unknown> {
  return JSON.parse(logs.at(-1)!) as Record<string, unknown>;
}

async function receiptFor(receiptRoot: string, plan: LocalUserPublicationPlan) {
  const receipt = await new FileScmDeliveryReceiptStore(await realpath(receiptRoot)).load(
    scmDeliveryIdempotencyKey(plan),
  );
  expect(receipt?.state).toBe("opened");
  return receipt!;
}

function keyDirectory(where: Layout, space: RunDeliveryIndexKeySpace, key: string): string {
  return join(
    where.canonicalReceiptRoot,
    "run-index",
    space,
    createHash("sha256").update(key).digest("hex"),
  );
}

async function entryNames(where: Layout, space: RunDeliveryIndexKeySpace, key: string) {
  return (await readdir(keyDirectory(where, space, key)).catch(() => [] as string[])).sort();
}

function mrKey(target: Delivery): string {
  return runDeliveryMergeRequestKey({
    provider: "gitlab",
    host: target.plan.project.host,
    projectId: target.plan.project.id,
    mergeRequestIid: target.iid,
  });
}

/** Rewrite one entry file; `resign` recomputes its digest so only the mutated field disagrees. */
async function rewriteEntry(
  path: string,
  mutate: (entry: Record<string, unknown>) => void,
  resign = true,
): Promise<void> {
  const entry = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  mutate(entry);
  if (resign) {
    const { sha256: _old, ...body } = entry;
    entry.sha256 = createHash("sha256")
      .update(canonicalizeJsonEvidence(body as never))
      .digest("hex");
  }
  await writeFile(path, canonicalizeJsonEvidence(entry as never), {
    mode: 0o600,
  });
}

async function runsShow(where: Layout, runId: string) {
  const human = await captureIo(() =>
    handleRunsCommand(["show", runId, "--state-dir", where.stateDirectory]),
  );
  const humanExitCode = process.exitCode ?? 0;
  process.exitCode = undefined;
  const json = await captureIo(() =>
    handleRunsCommand(["show", runId, "--json", "--state-dir", where.stateDirectory]),
  );
  process.exitCode = undefined;
  return {
    lines: human.stdout.split("\n"),
    stdout: human.stdout,
    humanExitCode,
    result: decodeRunResultV1(parseJsonEvidence(json.stdout)),
    jsonText: json.stdout,
  };
}

/** The PUBLICATION section body lines, without indentation. */
function publicationSection(lines: readonly string[]): string[] | undefined {
  const start = lines.findIndex((line) => line.trim() === "PUBLICATION");
  if (start < 0) return undefined;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith(" ")) break;
    body.push(line.trim());
  }
  return body;
}

describe("run delivery index journey", () => {
  it("previews physical receipt, plan, and all three validated index keyspaces for a legacy run", async () => {
    const where = await layout();
    const target = delivery({ runId: "run-preview" });
    expect((await publish(where, target)).error).toBeUndefined();
    const inventory = await inventoryRunDelivery({
      stateDirectory: where.stateDirectory,
      runId: target.plan.run.id,
      recordSha256: target.plan.run.recordSha256,
    });
    expect(inventory.receipts).toHaveLength(1);
    expect(inventory.plans).toHaveLength(1);
    expect(inventory.index.affected.map((chain) => chain.space).sort()).toEqual([
      "by-mr",
      "by-mr-path",
      "by-run",
    ]);
    for (const chain of inventory.index.affected) {
      expect(chain.slots).toHaveLength(1);
      expect((await readFile(chain.slots[0]!.path)).byteLength).toBe(chain.slots[0]!.size);
    }
    expect(inventory.unresolved).toEqual([]);
    expect(inventory.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      (await findRunDelivery({ indexRoot: where.canonicalReceiptRoot, runId: target.plan.run.id }))
        .status,
    ).toBe("found");
  });

  it("physically removes a legacy run's delivery while retained lookup chains remain valid", async () => {
    const where = await layout();
    const target = delivery({ runId: "run-delete", iid: 7 });
    const retained = delivery({ runId: "run-retain", iid: 7, commit: "d".repeat(40) });
    expect((await publish(where, target)).error).toBeUndefined();
    expect((await publish(where, retained)).error).toBeUndefined();
    const inventory = await inventoryRunDelivery({
      stateDirectory: where.stateDirectory,
      runId: target.plan.run.id,
      recordSha256: target.plan.run.recordSha256,
    });
    const targetPaths = [
      ...inventory.receipts.flatMap((receipt) => receipt.entries.map((entry) => entry.path)),
      ...inventory.plans.map((plan) => plan.entry.path),
    ];
    const result = await applyRunDeliveryDeletion(inventory);
    expect(result.unresolved).toEqual([]);
    for (const path of targetPaths)
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await findRunDelivery({ indexRoot: where.canonicalReceiptRoot, runId: target.plan.run.id }))
        .status,
    ).toBe("absent");
    expect(
      (
        await findRunDelivery({
          indexRoot: where.canonicalReceiptRoot,
          runId: retained.plan.run.id,
        })
      ).status,
    ).toBe("found");
    expect(
      (
        await findMergeRequestDelivery({
          indexRoot: where.canonicalReceiptRoot,
          provider: "gitlab",
          host: HOST,
          projectId: 42,
          mergeRequestIid: 7,
        })
      ).status,
    ).toBe("found");
    expect(
      (
        await new FileScmDeliveryReceiptStore(where.canonicalReceiptRoot).load(
          scmDeliveryIdempotencyKey(retained.plan),
        )
      )?.run.id,
    ).toBe(retained.plan.run.id);
  });

  it("deletes a completed run through the coordinator across records, receipts, plans, and all delivery indexes", async () => {
    const where = await layout();
    const record = authoringReviewFindingsRecord();
    const retained = { ...record, id: `${record.id}-retained` };
    await new FileRunStore(where.stateDirectory).save(record);
    await new FileRunStore(where.stateDirectory).save(retained);
    const digest = createHash("sha256")
      .update(await readFile(join(where.stateDirectory, `${record.id}.json`)))
      .digest("hex");
    const target = delivery({ runId: record.id, recordSha256: digest });
    expect((await publish(where, target)).error).toBeUndefined();
    const preview = await previewRunDeletion(where.stateDirectory, record.id);
    expect(preview.deliveryIndexRows).toBe(3);
    const result = await applyRunDeletion(where.stateDirectory, record.id, preview.confirmation);
    expect(result.complete, JSON.stringify(result)).toBe(true);
    await expect(readFile(join(where.stateDirectory, `${record.id}.json`))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      new FileScmDeliveryReceiptStore(where.canonicalReceiptRoot).load(
        scmDeliveryIdempotencyKey(target.plan),
      ),
    ).resolves.toBeUndefined();
    expect(
      (await findRunDelivery({ indexRoot: where.canonicalReceiptRoot, runId: record.id })).status,
    ).toBe("absent");
    expect((await new FileRunStore(where.stateDirectory).get(retained.id)).id).toBe(retained.id);
  });

  it("deletes a real clean registered worktree belonging to a completed publication", async () => {
    const where = await layout();
    execFileSync("git", ["init", "-b", "main"], { cwd: where.repository });
    execFileSync("git", ["config", "user.name", "Maintainer"], { cwd: where.repository });
    execFileSync("git", ["config", "user.email", "maintainer@example.test"], {
      cwd: where.repository,
    });
    execFileSync("git", ["remote", "add", "origin", "git@gitlab.example.test:group/docs.git"], {
      cwd: where.repository,
    });
    await writeFile(join(where.repository, "README.md"), "base\n");
    execFileSync("git", ["add", "README.md"], { cwd: where.repository });
    execFileSync("git", ["commit", "-m", "base"], { cwd: where.repository });
    const baseRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: where.repository })
      .toString("utf8")
      .trim();
    const original = authoringReviewFindingsRecord();
    const record = {
      ...original,
      repository: {
        sourcePath: where.repository,
        requestedRevision: "HEAD",
        revision: baseRevision,
      },
    };
    await new FileRunStore(where.stateDirectory).save(record);
    const recordSha256 = createHash("sha256")
      .update(await readFile(join(where.stateDirectory, `${record.id}.json`)))
      .digest("hex");
    const provisional = delivery({ runId: record.id, recordSha256, baseRevision });
    await mkdir(where.deliveryRoot, { mode: 0o700 });
    await mkdir(join(where.deliveryRoot, "attempts"), { mode: 0o700 });
    const attemptPath = join(where.deliveryRoot, "attempts", "completed");
    const worktreePath = join(attemptPath, deliveryCapsuleName(provisional.plan), "repository");
    await mkdir(join(attemptPath, deliveryCapsuleName(provisional.plan)), {
      recursive: true,
      mode: 0o700,
    });
    execFileSync(
      "git",
      ["worktree", "add", "-b", provisional.plan.proposedSourceBranch, worktreePath, baseRevision],
      { cwd: where.repository },
    );
    await writeFile(join(worktreePath, "README.md"), "published\n");
    execFileSync("git", ["add", "README.md"], { cwd: worktreePath });
    execFileSync("git", ["commit", "-m", "published"], { cwd: worktreePath });
    const committed = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath })
      .toString("utf8")
      .trim();
    const target = delivery({ runId: record.id, recordSha256, baseRevision, commit: committed });
    expect(target.plan.sha256).toBe(provisional.plan.sha256);
    expect((await publish(where, target)).error).toBeUndefined();
    await recordRunDeliveryAttemptLocation({
      schemaVersion: 1,
      kind: "docsfab-run-delivery-attempt-location",
      stateDirectory: where.stateDirectory,
      runId: record.id,
      recordSha256,
      deliveryRoot: where.deliveryRoot,
      attemptPath,
      planSha256: target.plan.sha256,
    });
    const deliveryInventory = await inventoryRunDelivery({
      stateDirectory: where.stateDirectory,
      runId: record.id,
      recordSha256,
      deliveryRoots: [where.deliveryRoot],
      receiptRoots: [where.canonicalReceiptRoot],
    });
    const attempt = deliveryInventory.attempts[0]!;
    const adminDirectory = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
      cwd: worktreePath,
    })
      .toString("utf8")
      .trim();
    const backpointer = join(adminDirectory, "gitdir");
    const savedBackpointer = join(adminDirectory, "gitdir.saved");
    await rename(backpointer, savedBackpointer);
    try {
      await symlink(savedBackpointer, backpointer);
      await expect(inspectRunDeliveryWorktree(deliveryInventory, attempt, record)).rejects.toThrow(
        /Unsafe Git cleanup identity/u,
      );
    } finally {
      await rm(backpointer);
      await rename(savedBackpointer, backpointer);
    }
    const headPath = join(adminDirectory, "HEAD");
    const originalHead = await readFile(headPath);
    await writeFile(headPath, "ref: refs/heads/main\n");
    try {
      await expect(inspectRunDeliveryWorktree(deliveryInventory, attempt, record)).rejects.toThrow(
        /branch or commit changed/u,
      );
    } finally {
      await writeFile(headPath, originalHead);
    }
    execFileSync("git", ["remote", "set-url", "origin", "git@gitlab.example.test:other/docs.git"], {
      cwd: where.repository,
    });
    try {
      await expect(inspectRunDeliveryWorktree(deliveryInventory, attempt, record)).rejects.toThrow(
        /remote no longer matches/u,
      );
    } finally {
      execFileSync(
        "git",
        ["remote", "set-url", "origin", "git@gitlab.example.test:group/docs.git"],
        {
          cwd: where.repository,
        },
      );
    }
    await expect(
      inspectRunDeliveryWorktree(deliveryInventory, attempt, {
        ...record,
        repository: { ...record.repository, revision: committed },
      }),
    ).rejects.toThrow(/Receipt or plan/u);
    const indexPath = execFileSync("git", ["rev-parse", "--git-path", "index"], {
      cwd: worktreePath,
    })
      .toString("utf8")
      .trim();
    const beforeIndex = {
      bytes: await readFile(indexPath),
      mtimeMs: (await stat(indexPath)).mtimeMs,
    };
    const clearance = await inspectRunDeliveryWorktree(deliveryInventory, attempt, record);
    expect(await readFile(indexPath)).toEqual(beforeIndex.bytes);
    expect((await stat(indexPath)).mtimeMs).toBe(beforeIndex.mtimeMs);
    const { digest: _digest, ...forgedBody } = {
      ...clearance,
      adminDirectory: join(where.root, "forged-admin"),
    };
    await expect(
      applyRunDeliveryDeletion(deliveryInventory, {
        clearedWorktrees: [{ ...forgedBody, digest: worktreeCleanupEvidenceDigest(forgedBody) }],
      }),
    ).rejects.toThrow(/clearance|registration/u);
    await expect(
      applyRunDeliveryDeletion(deliveryInventory, {
        clearedWorktrees: [clearance],
      }),
    ).rejects.toThrow(/remains/u);
    expect(
      (await findRunDelivery({ indexRoot: where.canonicalReceiptRoot, runId: record.id })).status,
    ).toBe("found");
    const preview = await previewRunDeletion(where.stateDirectory, record.id);
    expect(await readFile(indexPath)).toEqual(beforeIndex.bytes);
    expect((await stat(indexPath)).mtimeMs).toBe(beforeIndex.mtimeMs);
    const result = await applyRunDeletion(where.stateDirectory, record.id, preview.confirmation);
    expect(result.complete, JSON.stringify(result)).toBe(true);
    expect(
      execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: where.repository }).toString(
        "utf8",
      ),
    ).not.toContain(worktreePath);
    await expect(readFile(join(worktreePath, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    const forgedRemaining = await countRemainingRunDeliveryTargets(deliveryInventory, [
      { ...forgedBody, digest: worktreeCleanupEvidenceDigest(forgedBody) },
    ]);
    expect(forgedRemaining.unresolved).toEqual(
      expect.arrayContaining([expect.stringMatching(/clearance|registration/u)]),
    );
  });

  it("deletes a terminal failed attempt with only its exact staged approved patch", async () => {
    const where = await layout();
    execFileSync("git", ["init", "-b", "main"], { cwd: where.repository });
    execFileSync("git", ["config", "user.name", "Maintainer"], { cwd: where.repository });
    execFileSync("git", ["config", "user.email", "maintainer@example.test"], {
      cwd: where.repository,
    });
    execFileSync("git", ["remote", "add", "origin", "git@gitlab.example.test:group/docs.git"], {
      cwd: where.repository,
    });
    await writeFile(join(where.repository, "README.md"), "base\n");
    execFileSync("git", ["add", "README.md"], { cwd: where.repository });
    execFileSync("git", ["commit", "-m", "base"], { cwd: where.repository });
    const baseRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: where.repository })
      .toString("utf8")
      .trim();
    await writeFile(join(where.repository, "README.md"), "approved patch\n");
    execFileSync("git", ["add", "README.md"], { cwd: where.repository });
    const patchBytes = execFileSync(
      "git",
      [
        "diff",
        "--cached",
        "--binary",
        "--full-index",
        "--find-renames",
        "--find-copies",
        "--find-copies-harder",
        "--",
      ],
      { cwd: where.repository },
    );
    execFileSync("git", ["reset", "--hard", baseRevision], { cwd: where.repository });
    const original = authoringReviewFindingsRecord();
    const record = {
      ...original,
      repository: {
        sourcePath: where.repository,
        requestedRevision: "HEAD",
        revision: baseRevision,
      },
    };
    await new FileRunStore(where.stateDirectory).save(record);
    const recordSha256 = createHash("sha256")
      .update(await readFile(join(where.stateDirectory, `${record.id}.json`)))
      .digest("hex");
    const plan = makePlan({ runId: record.id, recordSha256, baseRevision, patchBytes });
    await mkdir(where.deliveryRoot, { mode: 0o700 });
    await mkdir(join(where.deliveryRoot, "attempts"), { mode: 0o700 });
    const attemptPath = join(where.deliveryRoot, "attempts", "failed-patch");
    const capsulePath = join(attemptPath, deliveryCapsuleName(plan));
    const worktreePath = join(capsulePath, "repository");
    await mkdir(capsulePath, { recursive: true, mode: 0o700 });
    await writeFile(join(capsulePath, "verified.patch"), patchBytes, { mode: 0o600 });
    execFileSync(
      "git",
      ["worktree", "add", "-b", plan.proposedSourceBranch, worktreePath, baseRevision],
      { cwd: where.repository },
    );
    await writeFile(join(worktreePath, "README.md"), "approved patch\n");
    execFileSync("git", ["add", "README.md"], { cwd: worktreePath });
    const authorization = authorizeLocalUserPublication({
      plan,
      confirmedPlanSha256: plan.sha256,
      command: "publish",
    });
    const store = new FileScmDeliveryReceiptStore(where.canonicalReceiptRoot);
    const initial = createScmDeliveryRecord({
      plan,
      authorization,
      createdAt: "2026-10-09T12:00:00.000Z",
    });
    await store.claim(initial, plan);
    const prepared = recordScmDeliveryProgress(
      initial,
      {
        toState: "prepared",
        source: "executed",
        at: "2026-10-09T12:01:00.000Z",
        evidence: { workspaceKey: "e".repeat(64), baseRevision },
      },
      plan,
      authorization,
    );
    await store.compareAndSwap(initial.sha256, prepared);
    const failed = failScmDeliveryRecord(
      prepared,
      { code: "validation-failed", at: "2026-10-09T12:02:00.000Z" },
      plan,
    );
    await store.compareAndSwap(prepared.sha256, failed);
    await recordRunDeliveryAttemptLocation({
      schemaVersion: 1,
      kind: "docsfab-run-delivery-attempt-location",
      stateDirectory: where.stateDirectory,
      runId: record.id,
      recordSha256,
      deliveryRoot: where.deliveryRoot,
      attemptPath,
      planSha256: plan.sha256,
    });
    const roots = {
      deliveryRoots: [where.deliveryRoot],
      receiptRoots: [where.canonicalReceiptRoot],
    };
    const indexPath = execFileSync("git", ["rev-parse", "--git-path", "index"], {
      cwd: worktreePath,
    })
      .toString("utf8")
      .trim();
    const beforeIndex = {
      bytes: await readFile(indexPath),
      mtimeMs: (await stat(indexPath)).mtimeMs,
    };
    await writeFile(join(where.repository, ".git", "info", "exclude"), "unexpected.log\n");
    await writeFile(join(worktreePath, "unexpected.log"), "unapproved\n");
    const blockedPreview = await previewRunDeletion(where.stateDirectory, record.id, roots);
    expect(await readFile(indexPath)).toEqual(beforeIndex.bytes);
    expect((await stat(indexPath)).mtimeMs).toBe(beforeIndex.mtimeMs);
    expect(blockedPreview.unresolved).toBeGreaterThan(0);
    const blocked = await applyRunDeletion(
      where.stateDirectory,
      record.id,
      blockedPreview.confirmation,
      {},
      roots,
    );
    expect(blocked.complete).toBe(false);
    expect(await readFile(join(worktreePath, "unexpected.log"), "utf8")).toBe("unapproved\n");
    await rm(join(worktreePath, "unexpected.log"));
    const preview = await previewRunDeletion(where.stateDirectory, record.id, roots);
    expect(await readFile(indexPath)).toEqual(beforeIndex.bytes);
    expect((await stat(indexPath)).mtimeMs).toBe(beforeIndex.mtimeMs);
    const result = await applyRunDeletion(
      where.stateDirectory,
      record.id,
      preview.confirmation,
      {},
      roots,
    );
    expect(result.complete, JSON.stringify(result)).toBe(true);
    expect(
      execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: where.repository }).toString(
        "utf8",
      ),
    ).not.toContain(worktreePath);
    await expect(readFile(join(worktreePath, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses all readers during an interrupted keyspace rebuild and resumes the approved inventory", async () => {
    const where = await layout();
    const target = delivery({ runId: "run-interrupted", iid: 7 });
    const retained = delivery({ runId: "run-survivor", iid: 7, commit: "d".repeat(40) });
    expect((await publish(where, target)).error).toBeUndefined();
    expect((await publish(where, retained)).error).toBeUndefined();
    const inventory = await inventoryRunDelivery({
      stateDirectory: where.stateDirectory,
      runId: target.plan.run.id,
      recordSha256: target.plan.run.recordSha256,
    });
    let interrupted = false;
    await expect(
      applyRunDeliveryDeletion(inventory, {
        afterIndexKeyspace: () => {
          if (!interrupted) {
            interrupted = true;
            throw new Error("fixture-interruption");
          }
        },
      }),
    ).rejects.toThrow("fixture-interruption");
    expect(
      (
        await findRunDelivery({
          indexRoot: where.canonicalReceiptRoot,
          runId: retained.plan.run.id,
        })
      ).status,
    ).toBe("refused");
    const later = openedRecord("run-after-interruption", "a".repeat(64));
    await expect(
      recordRunDelivery({
        indexRoot: where.canonicalReceiptRoot,
        record: later,
        receiptRoot: where.canonicalReceiptRoot,
      }),
    ).rejects.toThrow(/interrupted run deletion/u);
    const resumed = await applyRunDeliveryDeletion(inventory);
    expect(resumed.unresolved).toEqual([]);
    expect(
      (
        await findRunDelivery({
          indexRoot: where.canonicalReceiptRoot,
          runId: retained.plan.run.id,
        })
      ).status,
    ).toBe("found");
    expect(
      (
        await recordRunDelivery({
          indexRoot: where.canonicalReceiptRoot,
          record: later,
          receiptRoot: where.canonicalReceiptRoot,
        })
      ).appended,
    ).toEqual(["by-run", "by-mr", "by-mr-path"]);
    expect(await readdir(join(where.canonicalReceiptRoot, "run-index"))).not.toContain(
      ".deletion-in-progress",
    );
    for (const chain of inventory.index.affected) {
      expect(
        await readdir(join(where.canonicalReceiptRoot, "run-index", chain.space)),
      ).not.toContain(`${chain.directory.split("/").at(-1)}.deletion-backup`);
    }
  });

  it("finds a published draft MR by run id, MR iid, and MR URL, and runs show prints it", async () => {
    const where = await layout();
    const target = delivery({ runId: "run-journey" });
    await writeSavedWriteRun(where, target.plan.run.id);

    const published = await publish(where, target);
    expect(published.error).toBeUndefined();
    // The opened publication result stays the terminal log line.
    const terminal = decodeLocalUserGitLabPublicationResult(lastLine(published.logs));
    const receipt = await receiptFor(where.canonicalReceiptRoot, target.plan);

    const byRun = await findRunDelivery({
      indexRoot: where.canonicalReceiptRoot,
      runId: target.plan.run.id,
    });
    const byMr = await findMergeRequestDelivery({
      indexRoot: where.canonicalReceiptRoot,
      provider: "gitlab",
      host: HOST,
      projectId: 42,
      mergeRequestIid: 7,
    });
    const reference = parseMergeRequestUrl(`https://${HOST}/group/docs/-/merge_requests/7`);
    expect(reference).toEqual({
      provider: "gitlab",
      host: HOST,
      path: "group/docs",
      mergeRequestIid: 7,
    });
    const byUrl = await findMergeRequestDeliveryByPath({
      indexRoot: where.canonicalReceiptRoot,
      ...reference!,
    });
    for (const lookup of [byRun, byMr, byUrl]) {
      expect(lookup.status).toBe("found");
      const found = lookup as Extract<RunDeliveryLookup, { status: "found" }>;
      expect(found.receiptSha256Current).toBe(receipt.sha256);
      expect(found.receiptSha256AtOpen).toBe(receipt.sha256);
      expect(found.disposition).toBe("succeeded");
      expect(found.entry).toMatchObject({
        runId: "run-journey",
        idempotencyKey: receipt.idempotencyKey,
        receiptRoot: where.canonicalReceiptRoot,
        mergeRequestIid: 7,
        mergeRequestUrl: receipt.evidence.mergeRequest!.url,
        headRevision: receipt.evidence.mergeRequest!.headRevision,
        commitRevision: receipt.evidence.commit!.sha,
        sourceBranch: receipt.sourceBranch,
      });
    }
    expect((byRun as { entry: unknown }).entry).toEqual((byMr as { entry: unknown }).entry);
    expect(terminal.mergeRequest.url).toBe(receipt.evidence.mergeRequest!.url);

    const beforeShow = await observationSnapshot(where.root);
    const shown = await runsShow(where, target.plan.run.id);
    expect(publicationSection(shown.lines)).toEqual([
      "Status: draft merge request opened",
      `Merge request: https://${HOST}/group/docs/-/merge_requests/7`,
      `Source branch: ${receipt.sourceBranch}`,
      `Head: ${"c".repeat(40)}`,
    ]);
    expect(shown.result.publication).toEqual({
      status: "found",
      mergeRequestIid: 7,
      mergeRequestUrl: receipt.evidence.mergeRequest!.url,
      sourceBranch: receipt.sourceBranch,
      targetBranch: receipt.targetBranch,
      headRevision: receipt.evidence.mergeRequest!.headRevision,
      disposition: "succeeded",
      receiptSha256AtOpen: receipt.sha256,
      receiptSha256Current: receipt.sha256,
    });
    expect(shown.result).not.toHaveProperty("retainedDelivery");
    expect(await observationSnapshot(where.root)).toEqual(beforeShow);
  });

  it("finds a delivery published under an explicit --receipt-root from the state directory alone", async () => {
    const where = await layout();
    const explicit = join(where.root, "explicit-receipts");
    const target = delivery({ runId: "run-explicit" });
    await writeSavedWriteRun(where, target.plan.run.id);

    expect((await publish(where, target, { receiptRoot: explicit })).error).toBeUndefined();
    const receipt = await receiptFor(explicit, target.plan);
    const found = await findRunDelivery({
      indexRoot: where.canonicalReceiptRoot,
      runId: "run-explicit",
    });
    expect(found).toMatchObject({
      status: "found",
      entry: { receiptRoot: await realpath(explicit) },
      receiptSha256Current: receipt.sha256,
    });
    // The canonical root holds the index only; the receipt stayed under --receipt-root.
    expect(
      await new FileScmDeliveryReceiptStore(where.canonicalReceiptRoot).load(
        receipt.idempotencyKey,
      ),
    ).toBeUndefined();
    const shown = await runsShow(where, "run-explicit");
    expect(shown.result.publication).toMatchObject({
      status: "found",
      mergeRequestIid: 7,
    });
  });

  it("finds a managed cycle delivery published under a per-cycle receipt root", async () => {
    const where = await layout();
    const configRoot = join(where.root, "config");
    const cycleRoots = {
      deliveryRoot: join(configRoot, ".docsfab", "managed-deliveries", "cycle_1", "delivery"),
      receiptRoot: join(configRoot, ".docsfab", "managed-deliveries", "cycle_1", "receipts"),
    };
    const target = delivery({ runId: "run-managed" });
    await writeSavedWriteRun(where, "run-managed");
    const attempt = await managedPublish(where, target, cycleRoots);

    expect(attempt.status).toBe("opened");
    const found = await findRunDelivery({
      indexRoot: where.canonicalReceiptRoot,
      runId: "run-managed",
    });
    expect(found).toMatchObject({
      status: "found",
      entry: { receiptRoot: await realpath(cycleRoots.receiptRoot) },
    });
    expect((await runsShow(where, "run-managed")).result.publication).toMatchObject({
      status: "found",
      mergeRequestUrl: `https://${HOST}/group/docs/-/merge_requests/7`,
    });
  });
});

describe("run delivery index keys", () => {
  it("records one entry per key on an opened replay, and replaying an older delivery keeps the newer one newest", async () => {
    const where = await layout();
    const first = delivery({ runId: "run-a" });
    const second = delivery({ runId: "run-b", commit: "e".repeat(40) });

    expect((await publish(where, first)).error).toBeUndefined();
    expect((await publish(where, first)).error).toBeUndefined();
    expect(await entryNames(where, "by-run", runDeliveryRunKey("run-a"))).toEqual(["000001.json"]);
    expect(await entryNames(where, "by-mr", mrKey(first))).toEqual(["000001.json"]);

    expect((await publish(where, second)).error).toBeUndefined();
    expect((await publish(where, first)).error).toBeUndefined();
    expect(await entryNames(where, "by-mr", mrKey(first))).toEqual(["000001.json", "000002.json"]);
    expect(
      await entryNames(
        where,
        "by-mr-path",
        runDeliveryMergeRequestPathKey({
          provider: "gitlab",
          host: HOST,
          path: "group/docs",
          mergeRequestIid: 7,
        }),
      ),
    ).toEqual(["000001.json", "000002.json"]);

    const newest = await findMergeRequestDelivery({
      indexRoot: where.canonicalReceiptRoot,
      provider: "gitlab",
      host: HOST,
      projectId: 42,
      mergeRequestIid: 7,
    });
    expect(newest).toMatchObject({
      status: "found",
      entry: { runId: "run-b", sequence: 2 },
    });
    const listed = await listMergeRequestDeliveries({
      indexRoot: where.canonicalReceiptRoot,
      provider: "gitlab",
      host: HOST,
      projectId: 42,
      mergeRequestIid: 7,
    });
    expect(listed.status).toBe("listed");
    expect(
      (listed as { entries: { runId: string; sequence: number }[] }).entries.map((entry) => [
        entry.runId,
        entry.sequence,
      ]),
    ).toEqual([
      ["run-a", 1],
      ["run-b", 2],
    ]);
  });

  it("keeps the same iid in another project or on another host apart", async () => {
    const where = await layout();
    const base = delivery({ runId: "run-p42" });
    const otherProject = delivery({
      runId: "run-p43",
      projectId: 43,
      path: "group/other",
    });
    const otherHost = delivery({ runId: "run-h2", host: "gitlab.other.test" });
    for (const target of [base, otherProject, otherHost]) {
      expect((await publish(where, target)).error).toBeUndefined();
    }
    const lookups = await Promise.all([
      findMergeRequestDelivery({
        indexRoot: where.canonicalReceiptRoot,
        provider: "gitlab",
        host: HOST,
        projectId: 42,
        mergeRequestIid: 7,
      }),
      findMergeRequestDelivery({
        indexRoot: where.canonicalReceiptRoot,
        provider: "gitlab",
        host: HOST,
        projectId: 43,
        mergeRequestIid: 7,
      }),
      findMergeRequestDelivery({
        indexRoot: where.canonicalReceiptRoot,
        provider: "gitlab",
        host: "gitlab.other.test",
        projectId: 42,
        mergeRequestIid: 7,
      }),
    ]);
    expect(lookups.map((lookup) => (lookup as { entry: { runId: string } }).entry.runId)).toEqual([
      "run-p42",
      "run-p43",
      "run-h2",
    ]);
    for (const key of [mrKey(base), mrKey(otherProject), mrKey(otherHost)]) {
      expect(await entryNames(where, "by-mr", key)).toEqual(["000001.json"]);
    }
  });

  it("refuses a pasted URL whose path the project no longer uses, and resolves its current path", async () => {
    const where = await layout();
    const before = delivery({ runId: "run-old-path" });
    const after = delivery({
      runId: "run-new-path",
      path: "group/renamed",
      commit: "e".repeat(40),
    });
    expect((await publish(where, before)).error).toBeUndefined();

    const control = await findMergeRequestDeliveryByPath({
      indexRoot: where.canonicalReceiptRoot,
      ...parseMergeRequestUrl(`https://${HOST}/group/docs/-/merge_requests/7`)!,
    });
    expect(control).toMatchObject({
      status: "found",
      entry: { runId: "run-old-path" },
    });

    expect((await publish(where, after)).error).toBeUndefined();
    const stale = await findMergeRequestDeliveryByPath({
      indexRoot: where.canonicalReceiptRoot,
      ...parseMergeRequestUrl(`https://${HOST}/group/docs/-/merge_requests/7`)!,
    });
    expect(stale).toMatchObject({
      status: "refused",
      code: "run-delivery-index-invalid",
    });
    expect((stale as { detail: string }).detail).toMatch(/^path-project-mismatch: /u);
    const current = await findMergeRequestDeliveryByPath({
      indexRoot: where.canonicalReceiptRoot,
      ...parseMergeRequestUrl(`https://${HOST}/group/renamed/-/merge_requests/7`)!,
    });
    expect(current).toMatchObject({
      status: "found",
      entry: { runId: "run-new-path" },
    });
  });

  it("uses numeric MR history after an older path-key append is repaired late", async () => {
    const where = await layout();
    const first = delivery({ runId: "run-partial-old" });
    const second = delivery({ runId: "run-partial-new", commit: "e".repeat(40) });
    const pathSpace = join(where.canonicalReceiptRoot, "run-index", "by-mr-path");
    await mkdir(join(where.canonicalReceiptRoot, "run-index"), { recursive: true, mode: 0o700 });
    await writeFile(pathSpace, "blocked", { mode: 0o600 });
    expect((await publish(where, first)).error).toBeInstanceOf(RunDeliveryIndexContractError);
    await rm(pathSpace);
    expect((await publish(where, second)).error).toBeUndefined();
    expect((await publish(where, first)).error).toBeUndefined();
    for (const target of [first, second]) {
      expect((await publish(where, target)).error).toBeUndefined();
    }
    expect(await entryNames(where, "by-mr", mrKey(first))).toEqual(["000001.json", "000002.json"]);
    expect(
      await findMergeRequestDelivery({
        indexRoot: where.canonicalReceiptRoot,
        provider: "gitlab",
        host: HOST,
        projectId: 42,
        mergeRequestIid: 7,
      }),
    ).toMatchObject({ status: "found", entry: { runId: second.plan.run.id } });
    expect(
      await findMergeRequestDeliveryByPath({
        indexRoot: where.canonicalReceiptRoot,
        ...parseMergeRequestUrl(`https://${HOST}/group/docs/-/merge_requests/7`)!,
      }),
    ).toMatchObject({ status: "found", entry: { runId: second.plan.run.id } });
  });

  it("refuses a URL while its newest numeric MR delivery is missing from the path key", async () => {
    const where = await layout();
    const first = delivery({ runId: "run-path-complete" });
    const second = delivery({ runId: "run-path-missing", commit: "e".repeat(40) });
    expect((await publish(where, first)).error).toBeUndefined();
    const pathSpace = join(where.canonicalReceiptRoot, "run-index", "by-mr-path");
    await chmod(pathSpace, 0o700);
    const pathKey = runDeliveryMergeRequestPathKey({
      provider: "gitlab",
      host: HOST,
      path: "group/docs",
      mergeRequestIid: 7,
    });
    const blockedKey = keyDirectory(where, "by-mr-path", pathKey);
    await chmod(blockedKey, 0o500);
    expect((await publish(where, second)).error).toBeInstanceOf(RunDeliveryIndexContractError);
    await chmod(blockedKey, 0o700);
    const byUrl = await findMergeRequestDeliveryByPath({
      indexRoot: where.canonicalReceiptRoot,
      ...parseMergeRequestUrl(`https://${HOST}/group/docs/-/merge_requests/7`)!,
    });
    expect(byUrl).toMatchObject({ status: "refused", code: "run-delivery-index-invalid" });
  });

  it("retains the newer opening after interruptions at the run and MR keys", async () => {
    for (const blockedSpace of ["by-run", "by-mr"] as const) {
      const where = await layout();
      const first = delivery({ runId: `run-${blockedSpace}-old` });
      const second = delivery({ runId: `run-${blockedSpace}-new`, commit: "e".repeat(40) });
      const blocked = join(where.canonicalReceiptRoot, "run-index", blockedSpace);
      await mkdir(join(where.canonicalReceiptRoot, "run-index"), { recursive: true, mode: 0o700 });
      await writeFile(blocked, "blocked", { mode: 0o600 });
      expect((await publish(where, first)).error).toBeInstanceOf(RunDeliveryIndexContractError);
      await rm(blocked);
      expect((await publish(where, second)).error).toBeUndefined();
      expect((await publish(where, first)).error).toBeUndefined();
      for (const target of [first, second]) {
        expect((await publish(where, target)).error).toBeUndefined();
      }
      const byId = await findMergeRequestDelivery({
        indexRoot: where.canonicalReceiptRoot,
        provider: "gitlab",
        host: HOST,
        projectId: 42,
        mergeRequestIid: 7,
      });
      const byPath = await findMergeRequestDeliveryByPath({
        indexRoot: where.canonicalReceiptRoot,
        ...parseMergeRequestUrl(`https://${HOST}/group/docs/-/merge_requests/7`)!,
      });
      expect(byId).toMatchObject({ status: "found", entry: { runId: second.plan.run.id } });
      expect(byPath).toMatchObject({ status: "found", entry: { runId: second.plan.run.id } });
      const listed = await listMergeRequestDeliveries({
        indexRoot: where.canonicalReceiptRoot,
        provider: "gitlab",
        host: HOST,
        projectId: 42,
        mergeRequestIid: 7,
      });
      expect(listed).toMatchObject({
        status: "listed",
        entries: [{ runId: first.plan.run.id }, { runId: second.plan.run.id }],
      });
    }
  });

  it("refuses equal opened times instead of guessing MR recency", async () => {
    const where = await layout();
    const first = delivery({ runId: "run-equal-first" });
    const second = delivery({ runId: "run-equal-second", commit: "e".repeat(40) });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T16:00:00.000Z"));
    try {
      expect((await publish(where, first)).error).toBeUndefined();
      expect((await publish(where, second)).error).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    for (const lookup of [
      await findMergeRequestDelivery({
        indexRoot: where.canonicalReceiptRoot,
        provider: "gitlab",
        host: HOST,
        projectId: 42,
        mergeRequestIid: 7,
      }),
      await findMergeRequestDeliveryByPath({
        indexRoot: where.canonicalReceiptRoot,
        ...parseMergeRequestUrl(`https://${HOST}/group/docs/-/merge_requests/7`)!,
      }),
    ]) {
      expect(lookup).toMatchObject({ status: "refused", code: "run-delivery-index-invalid" });
      expect((lookup as { detail: string }).detail).toContain("opened-at-ambiguous");
      expect((lookup as { detail: string }).detail).toContain("Look up each run id");
    }
    expect(
      await findRunDelivery({
        indexRoot: where.canonicalReceiptRoot,
        runId: first.plan.run.id,
      }),
    ).toMatchObject({ status: "found" });
  });

  it("finds a later MR opening despite an equal-time historical pair", async () => {
    const where = await layout();
    const first = delivery({ runId: "run-old-equal-one" });
    const second = delivery({ runId: "run-old-equal-two", commit: "e".repeat(40) });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T16:00:00.000Z"));
    try {
      expect((await publish(where, first)).error).toBeUndefined();
      expect((await publish(where, second)).error).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    const third = delivery({ runId: "run-later", commit: "f".repeat(40) });
    expect((await publish(where, third)).error).toBeUndefined();
    expect(
      await findMergeRequestDelivery({
        indexRoot: where.canonicalReceiptRoot,
        provider: "gitlab",
        host: HOST,
        projectId: 42,
        mergeRequestIid: 7,
      }),
    ).toMatchObject({ status: "found", entry: { runId: third.plan.run.id } });
    expect(
      await findMergeRequestDeliveryByPath({
        indexRoot: where.canonicalReceiptRoot,
        ...parseMergeRequestUrl(`https://${HOST}/group/docs/-/merge_requests/7`)!,
      }),
    ).toMatchObject({ status: "found", entry: { runId: third.plan.run.id } });
    expect(
      await listMergeRequestDeliveries({
        indexRoot: where.canonicalReceiptRoot,
        provider: "gitlab",
        host: HOST,
        projectId: 42,
        mergeRequestIid: 7,
      }),
    ).toMatchObject({ status: "refused", code: "run-delivery-index-invalid" });
  });

  it("keeps runs show on the newer plan when an older run-key append is repaired late", async () => {
    const where = await layout();
    const first = delivery({ runId: "run-two-plans" });
    const second = delivery({ runId: "run-two-plans", projectId: 43, path: "group/other" });
    await writeSavedWriteRun(where, first.plan.run.id);
    const runSpace = join(where.canonicalReceiptRoot, "run-index", "by-run");
    await mkdir(join(where.canonicalReceiptRoot, "run-index"), { recursive: true, mode: 0o700 });
    await writeFile(runSpace, "blocked", { mode: 0o600 });
    expect((await publish(where, first)).error).toBeInstanceOf(RunDeliveryIndexContractError);
    await rm(runSpace);
    expect((await publish(where, second)).error).toBeUndefined();
    expect((await publish(where, first)).error).toBeUndefined();
    expect(
      await findRunDelivery({
        indexRoot: where.canonicalReceiptRoot,
        runId: first.plan.run.id,
      }),
    ).toMatchObject({ status: "found", entry: { projectId: 43 } });
    expect((await runsShow(where, first.plan.run.id)).result.publication).toMatchObject({
      status: "found",
      mergeRequestUrl: `https://${HOST}/group/other/-/merge_requests/7`,
    });
  });

  it.each(["missing", "corrupt"] as const)(
    "refuses MR ordering when an older indexed receipt is %s",
    async (damage) => {
      const where = await layout();
      const first = delivery({ runId: "run-history-first" });
      const second = delivery({ runId: "run-history-second", commit: "e".repeat(40) });
      expect((await publish(where, first)).error).toBeUndefined();
      expect((await publish(where, second)).error).toBeUndefined();
      const journal = join(where.canonicalReceiptRoot, scmDeliveryIdempotencyKey(first.plan));
      if (damage === "missing") await rm(journal, { recursive: true, force: true });
      else await writeFile(join(journal, "000000.json"), "{}");
      const code =
        damage === "missing" ? "run-delivery-receipt-missing" : "run-delivery-receipt-invalid";
      expect(
        await findMergeRequestDelivery({
          indexRoot: where.canonicalReceiptRoot,
          provider: "gitlab",
          host: HOST,
          projectId: 42,
          mergeRequestIid: 7,
        }),
      ).toMatchObject({ status: "refused", code });
      expect(
        await findMergeRequestDeliveryByPath({
          indexRoot: where.canonicalReceiptRoot,
          ...parseMergeRequestUrl(`https://${HOST}/group/docs/-/merge_requests/7`)!,
        }),
      ).toMatchObject({ status: "refused", code });
    },
  );

  it("refuses a reused path when two project IDs have current deliveries for the same URL", async () => {
    const where = await layout();
    expect((await publish(where, delivery({ runId: "run-project-42" }))).error).toBeUndefined();
    expect(
      (await publish(where, delivery({ runId: "run-project-43", projectId: 43 }))).error,
    ).toBeUndefined();
    expect(
      await findMergeRequestDeliveryByPath({
        indexRoot: where.canonicalReceiptRoot,
        ...parseMergeRequestUrl(`https://${HOST}/group/docs/-/merge_requests/7`)!,
      }),
    ).toMatchObject({ status: "refused", code: "run-delivery-index-invalid" });
  });

  it("parses only canonical merge-request URLs", () => {
    expect(parseMergeRequestUrl(`https://${HOST}/a/b/c/-/merge_requests/12`)).toEqual({
      provider: "gitlab",
      host: HOST,
      path: "a/b/c",
      mergeRequestIid: 12,
    });
    expect(parseMergeRequestUrl("https://github.com/o/r/pull/3")).toEqual({
      provider: "github",
      host: "github.com",
      path: "o/r",
      mergeRequestIid: 3,
    });
    // Adjacent conditions: an unparseable string, and parseable URLs that are not MR references.
    expect(parseMergeRequestUrl("not a url")).toBeUndefined();
    expect(parseMergeRequestUrl(`https://${HOST}/a/b/-/issues/12`)).toBeUndefined();
    expect(parseMergeRequestUrl(`http://${HOST}/a/b/-/merge_requests/12`)).toBeUndefined();
    expect(parseMergeRequestUrl(`https://${HOST}/a/b/-/merge_requests/12?x=1`)).toBeUndefined();
    expect(parseMergeRequestUrl(`https://${HOST}/a/b/-/merge_requests/0`)).toBeUndefined();
  });

  it("serializes two writers racing on one key into a valid chain", async () => {
    const where = await layout();
    await mkdir(where.canonicalReceiptRoot, { mode: 0o700 });
    const records = [
      openedRecord("run-race-a", "1".repeat(64)),
      openedRecord("run-race-b", "2".repeat(64)),
    ];
    const results = await Promise.all(
      records.map((record) =>
        recordRunDelivery({
          indexRoot: where.canonicalReceiptRoot,
          record,
          receiptRoot: where.canonicalReceiptRoot,
        }),
      ),
    );
    expect(results.map((result) => result.appended)).toEqual([
      ["by-run", "by-mr", "by-mr-path"],
      ["by-run", "by-mr", "by-mr-path"],
    ]);
    // This race fixture writes index entries directly, without receipt journals.
    // Inspect the immutable key chain itself; receipt-backed list behavior is
    // covered by the publication journeys above.
    const directory = keyDirectory(where, "by-mr", mrKey(delivery()));
    const entries = await Promise.all(
      (await readdir(directory)).sort().map(
        async (name) =>
          JSON.parse(await readFile(join(directory, name), "utf8")) as {
            sequence: number;
            previousEntrySha256: unknown;
            sha256: string;
          },
      ),
    );
    expect(entries.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(entries[1]!.previousEntrySha256).toBe((entries[0] as { sha256?: string }).sha256);
  });
});

describe("run delivery index refusals", () => {
  async function publishedRun(where: Layout, runId = "run-refusal") {
    const target = delivery({ runId });
    await writeSavedWriteRun(where, runId);
    expect((await publish(where, target)).error).toBeUndefined();
    const entry = join(keyDirectory(where, "by-run", runDeliveryRunKey(runId)), "000001.json");
    return { target, entry };
  }

  async function lookup(where: Layout, runId = "run-refusal") {
    return findRunDelivery({ indexRoot: where.canonicalReceiptRoot, runId });
  }

  /** Every refusal also reaches runs show as its code, never as the not-recorded line. */
  async function expectShownRefusal(where: Layout, code: string, runId = "run-refusal") {
    const shown = await runsShow(where, runId);
    expect(shown.result.publication).toMatchObject({ status: "refused", code });
    expect(publicationSection(shown.lines)?.[0]).toBe(`Status: lookup refused (${code})`);
    expect(shown.stdout).not.toContain("run-delivery-not-recorded");
  }

  it.each([
    ["corrupt bytes", async (path: string) => writeFile(path, "\u0000garbage")],
    [
      "truncated JSON",
      async (path: string) => {
        const text = await readFile(path, "utf8");
        await writeFile(path, text.slice(0, text.length / 2));
      },
    ],
    [
      "a wrong sha256",
      async (path: string) =>
        rewriteEntry(path, (entry) => (entry.headRevision = "f".repeat(40)), false),
    ],
    [
      "an unexpected field",
      async (path: string) => rewriteEntry(path, (entry) => (entry.extra = "x")),
    ],
  ])("refuses an entry with %s as run-delivery-index-invalid", async (_label, corrupt) => {
    const where = await layout();
    const { entry } = await publishedRun(where);
    expect((await lookup(where)).status).toBe("found");
    await corrupt(entry);
    expect(await lookup(where)).toMatchObject({
      status: "refused",
      code: "run-delivery-index-invalid",
    });
    await expectShownRefusal(where, "run-delivery-index-invalid");
  });

  it("refuses an entry whose receipt is gone, or whose receipt root is gone", async () => {
    const where = await layout();
    const { entry } = await publishedRun(where);
    const empty = join(where.root, "empty-receipts");
    await mkdir(empty, { mode: 0o700 });
    await rewriteEntry(entry, (value) => (value.receiptRoot = empty));
    expect(await lookup(where)).toMatchObject({
      status: "refused",
      code: "run-delivery-receipt-missing",
    });
    await expectShownRefusal(where, "run-delivery-receipt-missing");
    await rewriteEntry(entry, (value) => (value.receiptRoot = join(where.root, "no-such-root")));
    expect(await lookup(where)).toMatchObject({
      status: "refused",
      code: "run-delivery-receipt-missing",
    });
  });

  it("refuses an entry that names another delivery's receipt as run-delivery-receipt-mismatch", async () => {
    const where = await layout();
    const { entry } = await publishedRun(where);
    const other = delivery({
      runId: "run-other",
      projectId: 43,
      path: "group/other",
    });
    expect((await publish(where, other)).error).toBeUndefined();
    expect((await lookup(where)).status).toBe("found");
    await rewriteEntry(
      entry,
      (value) => (value.idempotencyKey = scmDeliveryIdempotencyKey(other.plan)),
    );
    const refused = await lookup(where);
    expect(refused).toMatchObject({
      status: "refused",
      code: "run-delivery-receipt-mismatch",
    });
    expect((refused as { detail: string }).detail).toContain("planSha256");
    await expectShownRefusal(where, "run-delivery-receipt-mismatch");
  });

  it("matches a receipt by identity, not by digest, and an opened receipt cannot move to recovered", async () => {
    const where = await layout();
    const { target, entry } = await publishedRun(where);
    const store = new FileScmDeliveryReceiptStore(where.canonicalReceiptRoot);
    const opened = await receiptFor(where.canonicalReceiptRoot, target.plan);
    // The store refuses a recovered disposition on an opened receipt, so on this
    // tree an opened receipt keeps its digest; identity is what the lookup checks.
    await expect(store.compareAndSwap(opened.sha256, recoveredCopy(opened))).rejects.toMatchObject({
      code: "receipt-invalid",
    });
    const atOpen = "9".repeat(64);
    await rewriteEntry(entry, (value) => (value.receiptSha256 = atOpen));
    const found = await lookup(where);
    expect(found).toMatchObject({
      status: "found",
      receiptSha256AtOpen: atOpen,
      receiptSha256Current: opened.sha256,
      disposition: "succeeded",
    });
    expect((await runsShow(where, "run-refusal")).result.publication).toMatchObject({
      status: "found",
      receiptSha256AtOpen: atOpen,
      receiptSha256Current: opened.sha256,
    });
  });

  it("refuses a symlinked run-index, and treats a missing one as not recorded", async () => {
    const where = await layout();
    await publishedRun(where);
    const index = join(where.canonicalReceiptRoot, "run-index");
    const moved = join(where.root, "moved-index");
    await rename(index, moved);
    expect(await lookup(where)).toMatchObject({
      status: "absent",
      code: "run-delivery-not-recorded",
    });
    await symlink(moved, index);
    expect(await lookup(where)).toMatchObject({
      status: "refused",
      code: "run-delivery-index-invalid",
    });
    await expectShownRefusal(where, "run-delivery-index-invalid");
  });

  it("refuses a symlinked or non-private recorded receipt root", async () => {
    const where = await layout();
    const { entry } = await publishedRun(where);
    const alias = join(where.root, "receipts-alias");
    await symlink(where.canonicalReceiptRoot, alias);
    await rewriteEntry(entry, (value) => (value.receiptRoot = alias));
    expect(await lookup(where)).toMatchObject({
      status: "refused",
      code: "run-delivery-index-invalid",
    });
    await rewriteEntry(entry, (value) => (value.receiptRoot = where.canonicalReceiptRoot));
    expect((await lookup(where)).status).toBe("found");
    const shared = join(where.root, "shared-receipts");
    await mkdir(shared, { mode: 0o700 });
    await chmod(shared, 0o755);
    await rewriteEntry(entry, (value) => (value.receiptRoot = shared));
    expect(await lookup(where)).toMatchObject({
      status: "refused",
      code: "run-delivery-index-invalid",
    });
  });

  it("refuses a symlinked entry as invalid and an unreadable entry as unavailable", async () => {
    const where = await layout();
    const { entry } = await publishedRun(where);
    const copy = join(where.root, "entry-copy.json");
    await writeFile(copy, await readFile(entry), { mode: 0o600 });
    await chmod(entry, 0o000);
    expect(await lookup(where)).toMatchObject({
      status: "refused",
      code: "run-delivery-index-unavailable",
    });
    await rm(entry);
    await symlink(copy, entry);
    expect(await lookup(where)).toMatchObject({
      status: "refused",
      code: "run-delivery-index-invalid",
    });
  });

  it("refuses a FIFO entry in both runs show formats and on replay without a writer", async () => {
    const where = await layout();
    const target = delivery({ runId: "run-fifo" });
    await writeSavedWriteRun(where, target.plan.run.id);
    expect((await publish(where, target)).error).toBeUndefined();
    const entry = join(
      keyDirectory(where, "by-run", runDeliveryRunKey(target.plan.run.id)),
      "000001.json",
    );
    await rm(entry);
    execFileSync("mkfifo", ["-m", "600", entry]);
    async function observed<T>(action: () => Promise<T>): Promise<T> {
      const pending = action();
      const status = await Promise.race([
        pending.then(
          () => "settled",
          () => "settled",
        ),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("blocked"), limit("test.localTimeoutMs").value),
        ),
      ]);
      if (status === "blocked") {
        const writer = await open(entry, "w");
        await writer.close();
      }
      const result = await pending;
      expect(status, "the FIFO read required an unrelated writer").toBe("settled");
      return result;
    }
    for (const json of [false, true]) {
      const output = await observed(() =>
        captureIo(() =>
          handleRunsCommand([
            "show",
            target.plan.run.id,
            ...(json ? ["--json"] : []),
            "--state-dir",
            where.stateDirectory,
          ]),
        ),
      );
      if (json) {
        expect(decodeRunResultV1(parseJsonEvidence(output.stdout)).publication).toMatchObject({
          status: "refused",
          code: "run-delivery-index-invalid",
        });
      } else {
        expect(output.stdout).toContain("Status: lookup refused (run-delivery-index-invalid)");
      }
      process.exitCode = undefined;
    }
    const replay = await observed(() => publish(where, target));
    expect(replay.error).toBeInstanceOf(RunDeliveryIndexContractError);
    expect((replay.error as Error).message).toContain("unsafe-entry");
  });

  it("refuses an entry above delivery.runDeliveryIndexEntryMaxBytes and reads one at the bound", async () => {
    const where = await layout();
    const { entry } = await publishedRun(where);
    const size = (await readFile(entry)).byteLength;
    vi.stubEnv(ENTRY_MAX_BYTES, String(size));
    expect(
      await findRunDelivery({
        indexRoot: where.canonicalReceiptRoot,
        runId: "run-refusal",
        environment: process.env,
      }),
    ).toMatchObject({ status: "found" });
    vi.stubEnv(ENTRY_MAX_BYTES, String(size - 1));
    const refused = await findRunDelivery({
      indexRoot: where.canonicalReceiptRoot,
      runId: "run-refusal",
      environment: process.env,
    });
    expect(refused).toMatchObject({
      status: "refused",
      code: "delivery-run-delivery-index-entry-max-bytes-bound",
    });
    expect((refused as { detail: string }).detail).toContain(
      `${size} exceeds delivery.runDeliveryIndexEntryMaxBytes = ${size - 1} bytes`,
    );
    await expectShownRefusal(where, "delivery-run-delivery-index-entry-max-bytes-bound");
  });

  it("refuses a write past delivery.runDeliveryIndexEntriesPerKey without dropping an entry, and a read past it", async () => {
    const where = await layout();
    const first = delivery({ runId: "run-limit-a" });
    const second = delivery({ runId: "run-limit-b", commit: "e".repeat(40) });
    const third = delivery({ runId: "run-limit-c", commit: "f".repeat(40) });
    const environment = { ...process.env, [ENTRIES_PER_KEY]: "2" };
    expect((await publish(where, first, { environment })).error).toBeUndefined();
    expect((await publish(where, second, { environment })).error).toBeUndefined();
    const atLimit = await findMergeRequestDelivery({
      indexRoot: where.canonicalReceiptRoot,
      provider: "gitlab",
      host: HOST,
      projectId: 42,
      mergeRequestIid: 7,
      environment,
    });
    expect(atLimit).toMatchObject({
      status: "found",
      entry: { runId: "run-limit-b" },
    });

    const overflow = await publish(where, third, { environment });
    expect(overflow.error).toBeInstanceOf(RunDeliveryIndexContractError);
    expect((overflow.error as Error).message).toContain(
      "delivery-run-delivery-index-entries-per-key-bound: 3 exceeds delivery.runDeliveryIndexEntriesPerKey = 2 count",
    );
    expect(lastLine(overflow.logs)).toMatchObject({
      status: "failed",
      failureCode: "run-delivery-index-write-failed",
    });
    expect(await entryNames(where, "by-mr", mrKey(first))).toEqual(["000001.json", "000002.json"]);

    const lowered = await findMergeRequestDelivery({
      indexRoot: where.canonicalReceiptRoot,
      provider: "gitlab",
      host: HOST,
      projectId: 42,
      mergeRequestIid: 7,
      environment: { ...process.env, [ENTRIES_PER_KEY]: "1" },
    });
    expect(lowered).toMatchObject({
      status: "refused",
      code: "delivery-run-delivery-index-entries-per-key-bound",
    });
    expect((lowered as { detail: string }).detail).toContain(
      "2 exceeds delivery.runDeliveryIndexEntriesPerKey = 1 count",
    );
  });

  it("reports a fresh host, a never-published run, and a missing run-index as not recorded", async () => {
    const where = await layout();
    await writeSavedWriteRun(where, "run-never");
    // Fresh host: no receipt root at all.
    expect(await lookup(where, "run-never")).toEqual({
      status: "absent",
      code: "run-delivery-not-recorded",
      checkedRoot: where.canonicalReceiptRoot,
    });
    const shown = await runsShow(where, "run-never");
    expect(publicationSection(shown.lines)).toEqual([
      "Status: not recorded (run-delivery-not-recorded)",
      `No draft merge request is recorded for this run in the run delivery index under ${where.canonicalReceiptRoot}.`,
    ]);
    // Receipt root exists without an index.
    await mkdir(where.canonicalReceiptRoot, { mode: 0o700 });
    expect((await lookup(where, "run-never")).status).toBe("absent");
    // Another run is indexed; this one is still not recorded.
    await publishedRun(where, "run-other");
    expect((await lookup(where, "run-never")).status).toBe("absent");
  });

  it("reports a receipt root that is not a directory as unavailable, not as not recorded", async () => {
    const where = await layout();
    await writeFile(where.canonicalReceiptRoot, "not a directory", {
      mode: 0o600,
    });
    expect(await lookup(where)).toMatchObject({
      status: "refused",
      code: "run-delivery-index-unavailable",
    });
  });

  it("refuses an unusable DOCSFAB_RECEIPT_ROOT as unavailable and honours a valid one", async () => {
    const where = await layout();
    const refused = await lookupSavedRunDelivery({
      environment: { DOCSFAB_RECEIPT_ROOT: "relative/receipts" },
      stateDirectory: where.stateDirectory,
      runId: "run-env",
    });
    expect(refused).toMatchObject({
      status: "refused",
      code: "run-delivery-index-unavailable",
    });
    const override = join(where.root, "override-receipts");
    const absent = await lookupSavedRunDelivery({
      environment: { DOCSFAB_RECEIPT_ROOT: override },
      stateDirectory: where.stateDirectory,
      runId: "run-env",
    });
    expect(absent).toEqual({
      status: "absent",
      code: "run-delivery-not-recorded",
      checkedRoot: override,
    });
  });
});

describe("run delivery index write failures", () => {
  it("writes nothing when the merge request does not open", async () => {
    const where = await layout();
    const target = delivery({ runId: "run-open-fails", failOpen: true });
    const failed = await publish(where, target);
    expect(failed.error).toBeDefined();
    expect(failed.error).not.toBeInstanceOf(RunDeliveryIndexContractError);
    expect(lastLine(failed.logs).failureCode).not.toBe("run-delivery-index-write-failed");
    expect(lastLine(failed.logs).status).toBe("failed");
    expect(await entryNames(where, "by-run", runDeliveryRunKey("run-open-fails"))).toEqual([]);
    expect(
      (
        await findRunDelivery({
          indexRoot: where.canonicalReceiptRoot,
          runId: "run-open-fails",
        })
      ).status,
    ).toBe("absent");
  });

  it("reports an index write failure as the terminal result on every caller, and the recovery replay records it", async () => {
    const where = await layout();
    const target = delivery({ runId: "run-index-fails" });
    await writeSavedWriteRun(where, "run-index-fails");
    await mkdir(where.canonicalReceiptRoot, { mode: 0o700 });
    // A run-index that is a regular file: the directory checks refuse it.
    await writeFile(join(where.canonicalReceiptRoot, "run-index"), "", {
      mode: 0o600,
    });

    const direct = await publish(where, target);
    expect(direct.error).toBeInstanceOf(RunDeliveryIndexContractError);
    expect((direct.error as RunDeliveryIndexContractError).code).toBe(
      "run-delivery-index-write-failed",
    );
    const terminal = lastLine(direct.logs);
    expect(terminal).toMatchObject({
      kind: "docsfab-local-user-gitlab-publication-result",
      status: "failed",
      state: "opened",
      failureCode: "run-delivery-index-write-failed",
      mergeRequestUrl: `https://${HOST}/group/docs/-/merge_requests/7`,
    });
    expect(terminal.recoveryCommand).toMatch(
      /^docsfab publish run-index-fails --draft-mr --execute /u,
    );
    expect(direct.logs).toHaveLength(1);

    // `run --draft-mr` PUBLICATION: the shipped decoder reads the same terminal line.
    const outcome = decodeFailedPublicationOutcome(direct.logs.at(-1), direct.error);
    expect(outcome).toEqual({
      status: "failed",
      failureCode: "run-delivery-index-write-failed",
      recoveryCommand: terminal.recoveryCommand,
      phase: "post-write",
    });
    const record = savedWriteRecord(where, "run-index-fails");
    const lines = formatRunSummary({
      record,
      recordPath: defaultRunRecordPath(where.stateDirectory, record.id),
      exitCode: 0,
      repositoryPath: where.repository,
      publication: outcome,
      noColor: true,
      tty: false,
    });
    expect(publicationSection(lines.join("\n").split("\n"))).toEqual([
      "Status: failed (run-delivery-index-write-failed)",
      `Recovery: ${terminal.recoveryCommand as string}`,
    ]);

    // Managed cycle: the host decodes the last line into a deferred attempt.
    const managed = await managedPublish(where, target, {
      deliveryRoot: where.deliveryRoot,
      receiptRoot: where.canonicalReceiptRoot,
    });
    expect(managed).toMatchObject({
      status: "deferred",
      failureCode: "run-delivery-index-write-failed",
      lastConfirmedState: "opened",
    });

    // Replaying the recovery command once the index is writable records the delivery.
    await rm(join(where.canonicalReceiptRoot, "run-index"));
    const replay = await publish(where, target);
    expect(replay.error).toBeUndefined();
    expect(decodeLocalUserGitLabPublicationResult(lastLine(replay.logs)).status).toBe("opened");
    expect(target.gitlab.creates).toBe(1);
    expect(
      await findRunDelivery({
        indexRoot: where.canonicalReceiptRoot,
        runId: "run-index-fails",
      }),
    ).toMatchObject({ status: "found" });
  });

  it("refuses to extend a key that holds a corrupt entry", async () => {
    const where = await layout();
    const first = delivery({ runId: "run-corrupt-a" });
    const second = delivery({ runId: "run-corrupt-b", commit: "e".repeat(40) });
    expect((await publish(where, first)).error).toBeUndefined();
    await writeFile(join(keyDirectory(where, "by-mr", mrKey(first)), "000001.json"), "{}");
    const blocked = await publish(where, second);
    expect(blocked.error).toBeInstanceOf(RunDeliveryIndexContractError);
    expect((blocked.error as Error).message).toContain("malformed-entry");
  });
});

describe("runs show PUBLICATION rendering", () => {
  it("keeps a refused lookup out of the verdict, NEXT, and the exit code", async () => {
    const where = await layout();
    await writeSavedWriteRun(where, "run-render");
    const before = await runsShow(where, "run-render");
    expect(before.result.publication).toMatchObject({ status: "absent" });

    await mkdir(join(where.canonicalReceiptRoot, "run-index"), {
      recursive: true,
      mode: 0o700,
    });
    await chmod(where.canonicalReceiptRoot, 0o755);
    const refused = await runsShow(where, "run-render");
    expect(refused.result.publication).toMatchObject({
      status: "refused",
      code: "run-delivery-index-unavailable",
    });
    expect(refused.humanExitCode).toBe(before.humanExitCode);
    expect(refused.result.execution.exitCode).toBe(before.result.execution.exitCode);
    expect(refused.result.nextSteps).toEqual(before.result.nextSteps);
    expect(refused.stdout).not.toMatch(/publication:\s*failed/u);
    expect(refused.stdout).not.toContain("Retry publication");
    const verdict = (lines: readonly string[]) =>
      lines.slice(
        0,
        lines.findIndex((line) => line.trim() === "EXECUTION"),
      );
    expect(verdict(refused.lines)).toEqual(verdict(before.lines));
  });

  it("prints no PUBLICATION section and keeps result bytes for a run without a publishable patch", async () => {
    const where = await layout();
    const record = savedWriteRecord(where, "run-review");
    record.workflow = "review-documentation";
    delete record.changes;
    await writeFile(
      join(where.stateDirectory, `${record.id}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
      { mode: 0o600 },
    );
    const shown = await runsShow(where, "run-review");
    expect(publicationSection(shown.lines)).toBeUndefined();
    expect(shown.result.publication).toBeUndefined();
    const recordPath = defaultRunRecordPath(where.stateDirectory, record.id);
    const exitCode = workflowOutcomeExitCode(record, interactiveWorkflowOutcomePolicy());
    const context: RunSummaryContext = {
      record,
      recordPath,
      exitCode,
      repositoryPath: record.repository.sourcePath,
    };
    const independent = buildRunResultV1({
      record,
      recordPath,
      exitCode,
      repositoryPath: record.repository.sourcePath,
      nextSteps: collectRunResultNextSteps(context),
    });
    expect(shown.result.resultSha256).toBe(independent.resultSha256);
  });

  it("names a receipt disposition other than succeeded", async () => {
    const where = await layout();
    const record = savedWriteRecord(where, "run-disposition");
    const lines = formatRunSummary({
      record,
      recordPath: defaultRunRecordPath(where.stateDirectory, record.id),
      exitCode: 0,
      repositoryPath: where.repository,
      noColor: true,
      tty: false,
      deliveryLookup: {
        status: "found",
        mergeRequestIid: 7,
        mergeRequestUrl: `https://${HOST}/group/docs/-/merge_requests/7`,
        sourceBranch: "docsfab-run/run-disposition",
        targetBranch: "main",
        headRevision: "c".repeat(40),
        disposition: "recovered",
        receiptSha256AtOpen: "1".repeat(64),
        receiptSha256Current: "2".repeat(64),
      },
    });
    expect(publicationSection(lines.join("\n").split("\n"))?.at(-1)).toBe(
      "Receipt disposition: recovered",
    );
  });

  it("refuses a malformed publication field in a run result", () => {
    const base = JSON.parse(
      JSON.stringify({
        schemaVersion: 1,
        kind: "docsfab-run-result",
        execution: { runId: "run" },
        resultSha256: "a".repeat(64),
      }),
    ) as Record<string, unknown>;
    expect(() =>
      decodeRunResultV1({
        ...base,
        publication: {
          status: "absent",
          code: "run-delivery-not-recorded",
          checkedRoot: "/r",
        },
      }),
    ).not.toThrow();
    expect(() =>
      decodeRunResultV1({
        ...base,
        publication: { status: "found", mergeRequestIid: 7 },
      }),
    ).toThrow("The docsfab run result envelope has an invalid publication lookup.");
  });
});

async function managedPublish(
  where: Layout,
  target: Delivery,
  cycleRoots: { deliveryRoot: string; receiptRoot: string },
) {
  const logs: string[] = [];
  const publishHost = createProductionManagedPublish({
    cwd: where.root,
    repositoryPath: where.repository,
    stateDirectory: where.stateDirectory,
    // The production submit, with the per-cycle roots the managed host derives.
    submit: (run, envelope, context) =>
      submitAfterSucceededRun({ ...run, changes: PUBLISHABLE_CHANGES }, envelope, {
        ...context,
        ...cycleRoots,
        preflight: async () => target.plan,
        executeDependencies: executeDependencies(where, target, logs),
      }),
  });
  return publishHost({
    link: { cycleId: "cycle:1" } as never,
    record: { cycleId: "cycle:1", runRecordId: target.plan.run.id } as never,
    resume: false,
  });
}

const PUBLISHABLE_CHANGES = {
  files: [{ path: "docs/guide.md", status: "modified" as const }],
  patch: {
    sha256: createHash("sha256").update(PATCH).digest("hex"),
    byteLength: PATCH.byteLength,
    lineCount: 1,
    artifactPath: "/nonexistent/run.patch",
    format: "git-diff" as const,
  },
};

function savedWriteRecord(where: Layout, id: string): RunRecord {
  return {
    schemaVersion: 2,
    id,
    workflow: "create-documentation",
    repository: {
      sourcePath: where.repository,
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-10-07T16:00:00.000Z",
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
    steps: [
      {
        id: "write-documentation",
        title: "Write documentation",
        kind: "inference",
        skill: "write-documentation",
        mode: "write",
        status: "succeeded",
        startedAt: "2026-10-07T16:00:00.000Z",
        completedAt: "2026-10-07T16:00:01.000Z",
        durationMs: 1_000,
        summary: "Wrote the guide.",
      },
    ],
    changes: {
      ...PUBLISHABLE_CHANGES,
      patch: {
        ...PUBLISHABLE_CHANGES.patch,
        artifactPath: join(where.stateDirectory, `${id}.patch`),
      },
    },
  } as RunRecord;
}

async function writeSavedWriteRun(where: Layout, id: string): Promise<void> {
  await writeFile(join(where.stateDirectory, `${id}.patch`), PATCH, {
    mode: 0o600,
  });
  await writeFile(
    join(where.stateDirectory, `${id}.json`),
    `${JSON.stringify(savedWriteRecord(where, id), null, 2)}\n`,
    { mode: 0o600 },
  );
}

function openedRecord(runId: string, idempotencyKey: string): ScmDeliveryRecord {
  return {
    schemaVersion: 2,
    kind: "docsfab-scm-delivery-record",
    deliveryMode: "local-user",
    idempotencyKey,
    planSha256: "3".repeat(64),
    authorization: {
      kind: "docsfab-scm-publication-authorization",
      provider: "gitlab",
      planSha256: "3".repeat(64),
    },
    run: { id: runId, recordSha256: "d".repeat(64) },
    repository: {
      provider: "gitlab",
      projectId: 42,
      host: HOST,
      path: "group/docs",
      remoteName: "origin",
      remoteTransport: "ssh",
    },
    baseRevision: "a".repeat(40),
    sourceBranch: `docsfab-run/${runId}`,
    targetBranch: "main",
    patch: {
      sha256: "b".repeat(64),
      byteLength: 5,
      changedFileCount: 1,
      preserved: true,
    },
    state: "opened",
    disposition: "succeeded",
    evidence: {
      commit: { sha: "c".repeat(40) },
      mergeRequest: {
        iid: 7,
        url: `https://${HOST}/group/docs/-/merge_requests/7`,
        state: "opened",
        draft: true,
        sourceBranch: `docsfab-run/${runId}`,
        targetBranch: "main",
        headRevision: "c".repeat(40),
      },
    },
    attempts: [],
    createdAt: "2026-10-07T16:00:00.000Z",
    updatedAt: "2026-10-07T16:00:00.000Z",
    sha256: "4".repeat(64),
  };
}

/** The opened receipt after a patch-only recovery replay moved its disposition. */
function recoveredCopy(opened: ScmDeliveryRecord): ScmDeliveryRecord {
  const at = new Date(Date.parse(opened.updatedAt) + 1_000).toISOString();
  const recovered = {
    ...structuredClone(opened),
    disposition: "recovered" as const,
    recovery: {
      mode: "patch-only" as const,
      reasonCode: "authentication-unavailable" as const,
      patchSha256: opened.patch.sha256,
      preserved: true as const,
      nextAction: "review-preserved-patch" as const,
      at,
    },
    updatedAt: at,
  };
  return { ...recovered, sha256: scmDeliveryRecordSha256(recovered) };
}

function makePlan(
  options: {
    runId?: string;
    recordSha256?: string;
    baseRevision?: string;
    patchBytes?: Buffer;
    projectId?: number;
    host?: string;
    path?: string;
  } = {},
): LocalUserPublicationPlanV2 {
  const runId = options.runId ?? "run-1";
  const candidate = {
    schemaVersion: 2 as const,
    kind: "docsfab-local-user-gitlab-publication-plan" as const,
    deliveryMode: "local-user" as const,
    authorityBasis: "interactive-once" as const,
    run: { id: runId, recordSha256: options.recordSha256 ?? "d".repeat(64) },
    project: {
      id: options.projectId ?? 42,
      host: options.host ?? HOST,
      path: options.path ?? "group/docs",
    },
    remote: { name: "origin", transport: "ssh" as const },
    identity: {
      git: "configured" as const,
      gitIdentitySha256: localUserGitIdentitySha256("Maintainer", "maintainer@example.test"),
      gitlabUsername: "maintainer",
    },
    baseRevision: options.baseRevision ?? "a".repeat(40),
    targetBranch: { name: "main", protected: true },
    proposedSourceBranch: `docsfab-run/${runId}`,
    patch: {
      format: "git-diff" as const,
      sha256: createHash("sha256")
        .update(options.patchBytes ?? PATCH)
        .digest("hex"),
      byteLength: (options.patchBytes ?? PATCH).byteLength,
      changedFileCount: 1,
    },
    validationCommand: "npm run check",
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
    },
    metadata: publicationMetadataInputDigests("Improve governed documentation", ["docs/guide.md"]),
  };
}

function loadedRun(plan: LocalUserPublicationPlan, sourcePath: string): never {
  return {
    id: plan.run.id,
    recordSha256: plan.run.recordSha256,
    revision: plan.baseRevision,
    sourcePath,
    workflowOutcome: "Improve governed documentation",
    changedFiles: [{ path: "docs/guide.md", status: "modified" }],
    changedFileCount: 1,
    patch: { ...plan.patch, bytes: PATCH },
  } as never;
}

function fakeGit(commit: string): LocalGitPublisher & { local: string; remote?: string } {
  const adapter: LocalGitPublisher & { local: string; remote?: string } = {
    local: "a".repeat(40),
    assertConfiguredIdentity: async () => undefined,
    localBranchRevision: async () => adapter.local,
    remoteBranchRevision: async () => adapter.remote,
    ensureCommit: async () => {
      adapter.local = commit;
      return adapter.local;
    },
    ensurePush: async () => {
      adapter.remote = adapter.local;
      return adapter.remote;
    },
    assertCommit: async ({ commitRevision }: { commitRevision: string }) => {
      if (commitRevision !== adapter.local) throw new Error("commit mismatch");
    },
  } as never;
  return adapter;
}

function fakeGitLab(
  plan: LocalUserPublicationPlan,
  iid: number,
  failOpen: boolean,
): GitLabPublisherAdapter & { creates: number } {
  const metadata = buildDocsFabPublicationMetadata({
    plan,
    workflowOutcome: "Improve governed documentation",
    changedPaths: ["docs/guide.md"],
  });
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
    openDraftMergeRequest: async ({ headRevision }) => {
      if (failOpen) throw new Error("fake forge refused the merge request");
      adapter.creates += 1;
      request = {
        iid,
        url: `https://${plan.project.host}/${plan.project.path}/-/merge_requests/${iid}`,
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
  return adapter;
}

async function captureIo(fn: () => Promise<void>): Promise<{ stdout: string; stderr: string }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (message?: unknown) => {
    logs.push(String(message ?? ""));
  };
  console.error = (message?: unknown) => {
    errors.push(String(message ?? ""));
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { stdout: logs.join("\n"), stderr: errors.join("\n") };
}
