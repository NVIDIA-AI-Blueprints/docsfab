// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { handleRunsCommand } from "../src/cli/commands/runs.js";
import { handleShipCommand } from "../src/cli/commands/ship.js";
import { deliverCliRunResult } from "../src/cli/run/delivery.js";
import { resolveDocsFabPublicationRoots } from "../src/config/host-paths.js";
import { lookupSavedRunRetainedDelivery } from "../src/operator/run-publication-lookup.js";
import type { RunRecord } from "../src/records/contracts.js";
import { applyRunDeletion, previewRunDeletion } from "../src/records/run-deletion.js";
import {
  DeliveryWorktreeError,
  authorizeLocalUserPublication,
  createScmDeliveryRecord,
  DeterministicLocalGitPublisher,
  deterministicLocalUserSourceBranch,
  localUserGitIdentitySha256,
  localUserPublicationPlanSha256,
  runLocalUserPublishExecuteCli,
  runLocalUserPublishCli,
  type GitLabPublisherAdapter,
  type LocalGitPublisher,
  type LocalUserPublicationPlanV2,
} from "../src/delivery/index.js";
import {
  recordRunDeliveryAttemptLocation,
  RUN_DELIVERY_ATTEMPT_LOCATIONS,
} from "../src/delivery/run-deletion-adapter.js";
import { deliveryCapsuleName } from "../src/delivery/worktree/materialize.js";
import { inspectReadyDeliveryWorktree } from "../src/delivery/worktree.js";
import { FileScmDeliveryReceiptStore } from "../src/delivery/receipt-store.js";
import { scmDeliveryIdempotencyKey } from "../src/delivery/receipt.js";
import {
  FIXTURE_GIT_IDENTITY,
  git,
  gitVersionAtLeast,
  hermeticGitEnv,
  initFixtureRepo,
} from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

// Each case runs the real publish execute path, real Git worktrees, and the
// real `docsfab runs delete` command; only GitLab preflight is replaced.
const temporary = temporaryRoots();

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

interface Layout {
  readonly root: string;
  readonly source: string;
  readonly stateDirectory: string;
  /** Not the defaults derived from the state directory, so commands must name them. */
  readonly deliveryRoot: string;
  readonly receiptRoot: string;
  readonly base: string;
}

interface SavedRun {
  readonly runId: string;
  readonly plan: LocalUserPublicationPlanV2;
  readonly artifactPath: string;
}

interface Failure {
  readonly logs: readonly string[];
  readonly attemptPath: string;
  readonly worktreePath: string;
  readonly error: unknown;
}

interface Worktree {
  readonly path: string;
  readonly head: string;
  readonly branch?: string;
}

async function layout(withTrackedSymlink = false, useDefaultRoots = false): Promise<Layout> {
  const root = await temporary.create("docsfab-retained-attempts-", { realpath: true });
  const source = join(root, "source");
  let base = await initFixtureRepo(
    source,
    {
      "README.md": "original\n",
      "validate.cjs": "process.exit(0);\n",
      "fail.cjs": "process.exit(7);\n",
    },
    { branch: "main", message: "base" },
  );
  if (withTrackedSymlink) {
    await symlink("README.md", join(source, "tracked-link"));
    await git(source, ["add", "tracked-link"]);
    await git(source, ["commit", "-m", "track symlink"]);
    base = await git(source, ["rev-parse", "HEAD"]);
  }
  await git(source, ["remote", "add", "origin", "https://gitlab.example.test/group/docs.git"]);
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory, { mode: 0o700 });
  const defaults = resolveDocsFabPublicationRoots({}, stateDirectory);
  return {
    root,
    source,
    stateDirectory,
    deliveryRoot: useDefaultRoots ? defaults.deliveryRoot : join(root, "custom-delivery"),
    receiptRoot: useDefaultRoots ? defaults.receiptRoot : join(root, "custom-receipts"),
    base,
  };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A succeeded write run whose saved patch changes README.md, with its fresh v2 plan. */
async function savedRun(
  where: Layout,
  runId: string,
  options: {
    content: string;
    validationCommand: string;
    corruptPatch?: boolean;
    /** An operator-named `--source-branch` instead of the DocsFab-minted name. */
    sourceBranch?: string;
  },
): Promise<SavedRun> {
  const writer = join(where.root, `writer-${runId}`);
  await git(where.source, ["worktree", "add", "--detach", writer, where.base]);
  await writeFile(join(writer, "README.md"), options.content);
  await git(writer, ["add", "-A"]);
  let patch = Buffer.from(
    await git(
      writer,
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
      { trim: false },
    ),
  );
  await git(where.source, ["worktree", "remove", "--force", writer]);
  if (options.corruptPatch) {
    patch = Buffer.from(patch.toString("utf8").replace("-original", "-not-the-base"));
  }
  // The CLI's layout: saved patches sit beside the run state directory.
  const patchRoot = join(where.root, "patches");
  await mkdir(patchRoot, { recursive: true, mode: 0o700 });
  const patchPath = join(patchRoot, `${runId}.patch`);
  await writeFile(patchPath, patch, { mode: 0o600 });
  const planReference = {
    kind: "ia-plan",
    schemaVersion: 1,
    digest: sha256(`ia-plan:${runId}`),
    repositoryRevision: where.base,
    repositoryContentDigest: "b".repeat(64),
  };
  const objects = join(where.root, "artifacts", "objects", "sha256");
  await mkdir(objects, { recursive: true, mode: 0o700 });
  const artifactPath = join(objects, `${planReference.digest}.json`);
  await writeFile(artifactPath, JSON.stringify({ kind: "ia-plan", schemaVersion: 1 }), {
    mode: 0o600,
  });
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 };
  const tools = { totalCalls: 0, failedCalls: 0, byTool: [] };
  const artifact = { role: "input", stepId: "apply-site-bootstrap", reference: planReference };
  const recordBytes = Buffer.from(
    `${JSON.stringify({
      schemaVersion: 2,
      id: runId,
      workflow: "site-bootstrap",
      repository: { sourcePath: where.source, requestedRevision: "HEAD", revision: where.base },
      workspace: { strategy: "tracked-export", disposable: true },
      task: { kind: "site-bootstrap", plan: planReference },
      status: "succeeded",
      createdAt: "2026-10-12T00:00:00.000Z",
      startedAt: "2026-10-12T00:00:01.000Z",
      completedAt: "2026-10-12T00:00:02.000Z",
      durationMs: 1000,
      models: [],
      skills: [],
      usage,
      tools,
      securityScan: {
        ruleSet: "credential-rules-v1",
        status: "passed",
        scannedFiles: 1,
        binaryFiles: 0,
        findings: [],
      },
      securityScanEffectiveDisposition: { status: "passed" },
      artifacts: [artifact],
      steps: [
        {
          id: "apply-site-bootstrap",
          title: "Apply approved site bootstrap",
          kind: "host-operation",
          operation: "site-bootstrap",
          skill: "template-scaffold-site",
          mode: "write",
          status: "succeeded",
          startedAt: "2026-10-12T00:00:01.000Z",
          completedAt: "2026-10-12T00:00:02.000Z",
          durationMs: 1000,
          usage,
          tools,
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
            cache: { disposition: "miss", keyDigest: "d".repeat(64), rebuildAttempted: true },
          },
          artifacts: [artifact],
          summary: "Applied approved site plan.",
        },
      ],
      changes: {
        files: [{ path: "README.md", status: "modified" }],
        patch: {
          sha256: sha256(patch),
          byteLength: patch.byteLength,
          lineCount: patch.toString("utf8").split("\n").length - 1,
          artifactPath: patchPath,
          format: "git-diff",
        },
      },
    })}\n`,
  );
  await writeFile(join(where.stateDirectory, `${runId}.json`), recordBytes, { mode: 0o600 });
  const recordSha256 = sha256(recordBytes);
  const body = {
    schemaVersion: 2,
    kind: "docsfab-local-user-gitlab-publication-plan",
    deliveryMode: "local-user",
    authorityBasis: "interactive-once",
    run: { id: runId, recordSha256 },
    project: { id: 42, host: "gitlab.example.test", path: "group/docs" },
    remote: { name: "origin", transport: "https" },
    identity: {
      git: "configured",
      gitIdentitySha256: localUserGitIdentitySha256(
        FIXTURE_GIT_IDENTITY.name,
        FIXTURE_GIT_IDENTITY.email,
      ),
      gitlabUsername: "maintainer",
    },
    baseRevision: where.base,
    targetBranch: { name: "main", protected: true },
    proposedSourceBranch:
      options.sourceBranch ??
      deterministicLocalUserSourceBranch(runId, where.base, recordSha256, sha256(patch)),
    patch: {
      format: "git-diff",
      sha256: sha256(patch),
      byteLength: patch.byteLength,
      changedFileCount: 1,
    },
    validationCommand: options.validationCommand,
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
  } as const satisfies Omit<LocalUserPublicationPlanV2, "sha256">;
  const plan: LocalUserPublicationPlanV2 = {
    ...body,
    sha256: localUserPublicationPlanSha256(body as unknown as LocalUserPublicationPlanV2),
  };
  return { runId, plan, artifactPath };
}

async function attemptDirectories(where: Layout): Promise<string[]> {
  const directory = join(where.deliveryRoot, "attempts");
  const names = await readdir(directory).catch(() => [] as string[]);
  return names.sort().map((name) => join(directory, name));
}

/** Build one pre-fix detached attempt so cleanup coverage includes legacy state. */
async function createLegacyDetachedAttempt(where: Layout, run: SavedRun, suffix: string) {
  const attemptPath = join(where.deliveryRoot, "attempts", `zz-legacy-${suffix}`);
  const capsule = join(attemptPath, deliveryCapsuleName(run.plan));
  const worktreePath = join(capsule, "repository");
  await mkdir(capsule, { recursive: true, mode: 0o700 });
  await writeFile(
    join(capsule, "verified.patch"),
    await readFile(join(where.root, "patches", `${run.runId}.patch`)),
    { mode: 0o600 },
  );
  await git(where.source, ["worktree", "add", "--detach", worktreePath, where.base]);
  await git(worktreePath, ["apply", "--index", join(capsule, "verified.patch")]).catch(
    () => undefined,
  );
  await recordRunDeliveryAttemptLocation({
    schemaVersion: 1,
    kind: "docsfab-run-delivery-attempt-location",
    stateDirectory: where.stateDirectory,
    runId: run.runId,
    recordSha256: run.plan.run.recordSha256,
    deliveryRoot: where.deliveryRoot,
    attemptPath,
    planSha256: run.plan.sha256,
  });
  return { attemptPath, worktreePath };
}

/** Real local commits through DocsFab's Git publisher; the remote rejects every push. */
function pushRejectingPublisher(run: SavedRun): {
  git: LocalGitPublisher;
  gitlab: GitLabPublisherAdapter;
} {
  const local = new DeterministicLocalGitPublisher(undefined, hermeticGitEnv());
  return {
    git: {
      assertConfiguredIdentity: async () => undefined,
      localBranchRevision: (plan, cwd) => local.localBranchRevision(plan, cwd),
      remoteBranchRevision: async () => undefined,
      ensureCommit: (input) => local.ensureCommit(input),
      ensurePush: async () => {
        throw new Error("the remote rejected the push");
      },
      assertCommit: (input) => local.assertCommit(input),
    },
    gitlab: {
      inspectPolicy: async () => ({
        username: run.plan.identity.gitlabUsername,
        projectId: run.plan.project.id,
        projectPath: run.plan.project.path,
        accessLevel: 30,
        defaultBranch: "main",
        targetBranch: {
          name: run.plan.targetBranch.name,
          protected: run.plan.targetBranch.protected,
          revision: run.plan.baseRevision,
        },
        sourceBranchProtected: false,
      }),
      findMergeRequests: async () => [],
      openDraftMergeRequest: async () => {
        throw new Error("no merge request opens after a rejected push");
      },
    },
  };
}

function acceptingPublisher(run: SavedRun): {
  git: LocalGitPublisher;
  gitlab: GitLabPublisherAdapter;
} {
  const rejecting = pushRejectingPublisher(run);
  const local = new DeterministicLocalGitPublisher(undefined, hermeticGitEnv());
  let opened: Awaited<ReturnType<GitLabPublisherAdapter["openDraftMergeRequest"]>> | undefined;
  return {
    git: {
      ...rejecting.git,
      remoteBranchRevision: (_plan, cwd) => local.localBranchRevision(run.plan, cwd),
      ensurePush: async ({ commitRevision }) => commitRevision,
    },
    gitlab: {
      ...rejecting.gitlab,
      findMergeRequests: async () => (opened ? [opened] : []),
      openDraftMergeRequest: async (input) => {
        opened = {
          iid: 42,
          url: "https://gitlab.example.test/group/docs/-/merge_requests/42",
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
        return opened;
      },
    },
  };
}

/**
 * One governed delivery that fails after its worktree exists. `inspection`
 * fails the ready inspection, as the released build's validation binding did;
 * `validation` lets the plan's own validation command fail; `patch` is a patch
 * that does not apply; `push` commits locally and then fails to push.
 */
async function failDelivery(
  where: Layout,
  run: SavedRun,
  failure: "inspection" | "validation" | "patch" | "push",
  extraArgs: readonly string[] = [],
  expectedCode?: string,
): Promise<Failure> {
  const before = new Set(await attemptDirectories(where));
  const logs: string[] = [];
  const error = await runLocalUserPublishExecuteCli(
    [
      run.runId,
      "--repo",
      where.source,
      "--draft-mr",
      "--execute",
      "--confirm-plan-sha256",
      run.plan.sha256,
      "--delivery-root",
      where.deliveryRoot,
      "--receipt-root",
      where.receiptRoot,
      "--state-dir",
      where.stateDirectory,
      ...extraArgs,
    ],
    {
      cwd: where.root,
      stateDirectory: where.stateDirectory,
      log: (message) => logs.push(message),
      preflight: async () => run.plan,
      isolateValidation: async () => ({ commandPrefix: [] }),
      ...(failure === "inspection"
        ? {
            inspectReady: async () => {
              throw new DeliveryWorktreeError("invalid-delivery-input");
            },
          }
        : {}),
      ...(failure === "push" ? { publisher: pushRejectingPublisher(run) } : {}),
    },
  ).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  const observedError =
    error instanceof Error
      ? `${error.name} code=${"code" in error ? String(error.code) : "<none>"}: ${error.message}`
      : String(error);
  expect(error, `Unexpected delivery failure: ${observedError}`).toMatchObject(
    failure === "push"
      ? { name: "LocalUserGitLabPublisherError", code: "push-failed" }
      : {
          name: "DeliveryWorktreeError",
          code: expectedCode ?? (failure === "patch" ? "patch-conflict" : "validation-failed"),
        },
  );
  const created = (await attemptDirectories(where)).filter((path) => !before.has(path));
  const result = JSON.parse(logs.at(-1)!) as { preservedWorktree?: string };
  const worktreePath = result.preservedWorktree;
  expect(worktreePath).toBeDefined();
  const attemptPath = join(worktreePath!, "..", "..");
  expect(created).toEqual(created.length === 0 ? [] : [attemptPath]);
  return {
    logs,
    attemptPath,
    worktreePath: worktreePath!,
    error,
  };
}

async function worktrees(source: string): Promise<Worktree[]> {
  const listed: Worktree[] = [];
  for (const block of (await git(source, ["worktree", "list", "--porcelain"])).split("\n\n")) {
    const fields = new Map<string, string>();
    for (const line of block.split("\n")) {
      const separator = line.indexOf(" ");
      fields.set(separator < 0 ? line : line.slice(0, separator), line.slice(separator + 1));
    }
    if (!fields.has("worktree")) continue;
    const branch = fields.get("branch")?.replace(/^refs\/heads\//u, "");
    listed.push({
      path: fields.get("worktree")!,
      head: fields.get("HEAD")!,
      ...(branch ? { branch } : {}),
    });
  }
  return listed;
}

async function branchRevision(source: string, branch: string): Promise<string | undefined> {
  const listed = await git(source, [
    "for-each-ref",
    "--format=%(objectname)",
    `refs/heads/${branch}`,
  ]);
  return listed || undefined;
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
}

/** Full fixture byte/mode/link identity; reads must not create, chmod, or change Git state. */
async function snapshot(root: string): Promise<unknown[]> {
  const entries: unknown[] = [];
  const visit = async (path: string): Promise<void> => {
    const stat = await lstat(path);
    const common = { path, mode: stat.mode, ino: stat.ino };
    if (stat.isSymbolicLink()) entries.push({ ...common, target: await readlink(path) });
    else if (stat.isDirectory()) {
      entries.push({ ...common, kind: "directory" });
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    } else entries.push({ ...common, sha256: sha256(await readFile(path)) });
  };
  await visit(root);
  return entries;
}

async function showSaved(where: Layout, run: SavedRun, json: boolean): Promise<string> {
  const lines: string[] = [];
  const log = vi
    .spyOn(console, "log")
    .mockImplementation((line?: unknown) => lines.push(String(line)));
  try {
    await handleRunsCommand([
      "show",
      run.runId,
      "--state-dir",
      where.stateDirectory,
      ...(json ? ["--json"] : []),
    ]);
  } finally {
    log.mockRestore();
  }
  process.exitCode = undefined;
  return lines.join("\n");
}

/** POSIX words of one printed command line: plain, single-quoted, and escaped forms. */
function shellWords(command: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (character === " ") {
      if (word !== undefined) words.push(word);
      word = undefined;
      continue;
    }
    word ??= "";
    if (character === "'" || character === '"') {
      const end = command.indexOf(character, index + 1);
      word += command.slice(index + 1, end);
      index = end;
    } else if (character === "\\") {
      index += 1;
      word += command[index]!;
    } else word += character;
  }
  if (word !== undefined) words.push(word);
  return words;
}

/** Runs one printed `docsfab runs delete ...` command through the real CLI handler. */
async function runPrinted(command: string): Promise<{ stdout: string; exitCode: number }> {
  const words = shellWords(command);
  expect(words.slice(0, 3)).toEqual(["docsfab", "runs", "delete"]);
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
    lines.push(String(line));
  });
  try {
    await handleRunsCommand(words.slice(2));
  } finally {
    log.mockRestore();
  }
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return { stdout: lines.join("\n"), exitCode };
}

const PREVIEW_PREFIX = "Preview deleting this saved run and its preserved delivery state: ";
const CONFIRM_PREFIX = "No files changed. Confirm with: ";

function printedPreview(failure: Failure): string {
  const line = failure.logs.find((candidate) => candidate.startsWith(PREVIEW_PREFIX));
  expect(line, failure.logs.join("\n")).toBeDefined();
  return line!.slice(PREVIEW_PREFIX.length);
}

function printedConfirmation(previewStdout: string): string {
  const line = previewStdout.split("\n").find((candidate) => candidate.startsWith(CONFIRM_PREFIX));
  expect(line, previewStdout).toBeDefined();
  return line!.slice(CONFIRM_PREFIX.length);
}

describe("retained failed-delivery cleanup", { timeout: testTimeoutMs(180_000) }, () => {
  it("keeps a disappeared already-bound record invalid after real delivery validation", async () => {
    const where = await layout();
    const run = await savedRun(where, "run-late-record-removal", {
      content: "validated delivery change\n",
      validationCommand: "node validate.cjs",
    });
    let inspected = 0;
    const forbidden = vi.fn(async () => {
      throw new Error("A missing bound record reached SCM publication.");
    });
    const publisher = pushRejectingPublisher(run);
    const error = await runLocalUserPublishExecuteCli(
      [
        run.runId,
        "--repo",
        where.source,
        "--draft-mr",
        "--execute",
        "--confirm-plan-sha256",
        run.plan.sha256,
        "--delivery-root",
        where.deliveryRoot,
        "--receipt-root",
        where.receiptRoot,
        "--state-dir",
        where.stateDirectory,
      ],
      {
        cwd: where.root,
        stateDirectory: where.stateDirectory,
        log: () => undefined,
        preflight: async () => run.plan,
        isolateValidation: async () => ({ commandPrefix: [] }),
        inspectReady: async (capability) => {
          const attestation = await inspectReadyDeliveryWorktree(capability);
          inspected += 1;
          await rm(join(where.stateDirectory, `${run.runId}.json`));
          return attestation;
        },
        publisher: {
          git: { ...publisher.git, ensureCommit: forbidden, ensurePush: forbidden },
          gitlab: { ...publisher.gitlab, openDraftMergeRequest: forbidden },
        },
      },
    ).catch((caught: unknown) => caught);
    expect(inspected).toBe(1);
    expect(forbidden).not.toHaveBeenCalled();
    expect(await attemptDirectories(where)).toHaveLength(1);
    expect(
      await new FileScmDeliveryReceiptStore(where.receiptRoot).load(
        scmDeliveryIdempotencyKey(run.plan),
      ),
    ).toMatchObject({ state: "validated" });
    expect(error).toMatchObject({ name: "LocalUserPublicationPreflightError" });
    expect((error as { code: string }).code).toBe("invalid-run-record");
  });

  it.each([false, true])(
    "carries a real failed delivery into immediate human/JSON output (json=%s)",
    async (json) => {
      const where = await layout();
      const run = await savedRun(where, `run-initial-retention-${json}`, {
        content: "initial retained guidance change\n",
        validationCommand: "node fail.cjs",
      });
      const path = join(where.stateDirectory, `${run.runId}.json`);
      const bytes = await readFile(path);
      const record = JSON.parse(bytes.toString("utf8")) as RunRecord;
      const output: string[] = [];
      let failure: Failure | undefined;
      const invocation = {
        request: {
          workflow: record.workflow,
          repositoryPath: where.source,
          revision: "HEAD",
          allowWrite: true,
          draftMr: true,
          json,
        },
        config: { stateDirectory: where.stateDirectory },
        options: {
          json,
          submitAfterSucceededRun: async (
            _record: unknown,
            _envelope: unknown,
            context: { log: (line: string) => void },
          ) => {
            failure = await failDelivery(where, run, "validation");
            for (const line of failure.logs) context.log(line);
            throw failure.error;
          },
        },
        output: {
          log: (line: string) => output.push(line),
          error: (line: string) => output.push(line),
        },
      } as unknown as Parameters<typeof deliverCliRunResult>[0];
      const error = await deliverCliRunResult(
        invocation,
        { sourcePath: where.source } as Parameters<typeof deliverCliRunResult>[1],
        {} as Parameters<typeof deliverCliRunResult>[2],
        { record, exitCode: 0 } as Parameters<typeof deliverCliRunResult>[3],
      ).catch((caught: unknown) => caught);
      expect(failure).toBeDefined();
      if (json) {
        expect(error).toMatchObject({ code: "validation-failed" });
        const result = output
          .filter((line) => line.startsWith("{"))
          .map((line) => JSON.parse(line))
          .find((value) => value.kind === "docsfab-run-result");
        expect(result.execution.status).toBe("succeeded");
        expect(result.retainedDelivery).toMatchObject({
          status: "retained",
          worktrees: [failure!.worktreePath],
          branches: [run.plan.proposedSourceBranch],
          cleanupPreviewCommand: printedPreview(failure!),
        });
      } else {
        const publication = output.join("\n").split("PUBLICATION")[1];
        expect(publication).toContain("Status: failed (validation-failed)");
        expect(publication).toContain(`Preserved worktree: ${failure!.worktreePath}`);
        expect(publication).toContain(`Preserved branch: ${run.plan.proposedSourceBranch}`);
        expect(publication).toContain(printedPreview(failure!));
        expect(process.exitCode).toBe(1);
      }
      expect(await readFile(path)).toEqual(bytes);
      expect(await attemptDirectories(where)).toEqual([failure!.attemptPath]);
    },
  );

  it("shows current retained delivery and a runnable preview after saved human and JSON reload", async () => {
    const where = await layout();
    const run = await savedRun(where, "run-saved-retention", {
      content: "retained guidance change\n",
      validationCommand: "node fail.cjs",
    });
    const failure = await failDelivery(where, run, "validation");
    const beforeRecord = await readFile(join(where.stateDirectory, `${run.runId}.json`));
    const beforeWorktrees = await worktrees(where.source);
    const show = async (json: boolean) => {
      const lines: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
        lines.push(String(line));
      });
      try {
        await handleRunsCommand([
          "show",
          run.runId,
          "--state-dir",
          where.stateDirectory,
          ...(json ? ["--json"] : []),
        ]);
      } finally {
        log.mockRestore();
      }
      process.exitCode = undefined;
      return lines.join("\n");
    };
    const human = await show(false);
    expect(human).toContain(`Preserved worktree: ${failure.worktreePath}`);
    expect(human).toContain(`Preserved branch: ${run.plan.proposedSourceBranch}`);
    const result = JSON.parse(await show(true));
    expect(result.retainedDelivery).toMatchObject({
      status: "retained",
      worktrees: [failure.worktreePath],
      branches: [run.plan.proposedSourceBranch],
    });
    const command = result.retainedDelivery.cleanupPreviewCommand;
    expect(command).toBe(printedPreview(failure));
    const preview = await runPrinted(command);
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toContain("1 delivery worktree(s) and 1 delivery branch(es)");
    expect(await readFile(join(where.stateDirectory, `${run.runId}.json`))).toEqual(beforeRecord);
    expect(await worktrees(where.source)).toEqual(beforeWorktrees);
  });

  it.each([false, true])(
    "keeps saved lookup passive with verified roots (defaults=%s)",
    async (defaults) => {
      const where = await layout(false, defaults);
      const run = await savedRun(where, `run-passive-${defaults}`, {
        content: "passive retained guidance\n",
        validationCommand: "node fail.cjs",
      });
      const failure = await failDelivery(where, run, "validation");
      // Include dirty/untracked/index/stash state outside the delivery capsule.
      await writeFile(join(where.source, "README.md"), "operator staged work\n");
      await git(where.source, ["add", "README.md"]);
      await git(where.source, ["stash", "push", "-m", "operator stash"]);
      await writeFile(join(where.source, "unrelated.txt"), "operator untracked work\n");
      await writeFile(join(where.source, "README.md"), "operator dirty work\n");
      const before = await snapshot(where.root);
      const human = await showSaved(where, run, false);
      const result = JSON.parse(await showSaved(where, run, true));
      expect(human).toContain(`Preserved worktree: ${failure.worktreePath}`);
      expect(result.retainedDelivery).toMatchObject({
        status: "retained",
        worktrees: [failure.worktreePath],
        branches: [run.plan.proposedSourceBranch],
        cleanupPreviewCommand: printedPreview(failure),
      });
      expect(result.retainedDelivery.cleanupPreviewCommand).not.toContain("--confirm");
      expect(await snapshot(where.root)).toEqual(before);
      const preview = await runPrinted(result.retainedDelivery.cleanupPreviewCommand);
      expect(preview.exitCode).toBe(0);
      expect(preview.stdout).toContain("1 delivery worktree(s) and 1 delivery branch(es)");
    },
  );

  it("keeps legacy unknown receipt roots explicit without inventing an executable preview", async () => {
    const where = await layout();
    const run = await savedRun(where, "run-legacy-unknown-roots", {
      content: "legacy retained guidance\n",
      validationCommand: "node fail.cjs",
    });
    await createLegacyDetachedAttempt(where, run, "unknown-roots");
    const before = await snapshot(where.root);
    const result = JSON.parse(await showSaved(where, run, true));
    expect(result.retainedDelivery).toMatchObject({
      status: "inspection-required",
      cleanupPreviewCommand: null,
    });
    expect(result.retainedDelivery.explanation).toContain("original private publication roots");
    expect(await snapshot(where.root)).toEqual(before);
  });

  it.each(["missing-root", "insecure-root", "tampered-plan"] as const)(
    "refuses unsafe saved retention (%s) without repairing or changing the fixture",
    async (variant) => {
      const where = await layout();
      const run = await savedRun(where, `run-retention-${variant}`, {
        content: "unsafe retained guidance\n",
        validationCommand: "node fail.cjs",
      });
      await failDelivery(where, run, "validation");
      if (variant === "missing-root") await rename(where.receiptRoot, `${where.receiptRoot}-moved`);
      if (variant === "insecure-root") await chmod(where.receiptRoot, 0o755);
      if (variant === "tampered-plan")
        await writeFile(join(where.receiptRoot, `plan-${run.plan.sha256}.json`), "{}", {
          mode: 0o600,
        });
      const before = await snapshot(where.root);
      const result = JSON.parse(await showSaved(where, run, true));
      expect(result.retainedDelivery).toMatchObject({
        status: "inspection-required",
        cleanupPreviewCommand: null,
      });
      expect(await snapshot(where.root)).toEqual(before);
    },
  );

  it("withholds configured credential paths through actual saved human and JSON lookup", async () => {
    const where = await layout();
    const run = await savedRun(where, "run-retention-private", {
      content: "private retained guidance\n",
      validationCommand: "node fail.cjs",
    });
    const failure = await failDelivery(where, run, "validation");
    configureCredential(failure.worktreePath);
    const before = await snapshot(where.root);
    const human = await showSaved(where, run, false);
    const json = await showSaved(where, run, true);
    const result = JSON.parse(json);
    expect(result.retainedDelivery).toMatchObject({
      status: "inspection-required",
      worktrees: [],
      cleanupPreviewCommand: null,
    });
    expect(human).not.toContain(failure.worktreePath);
    expect(json).not.toContain(failure.worktreePath);
    expect(human).not.toContain("Cleanup preview:");
    expect(await snapshot(where.root)).toEqual(before);
  });

  it("leaves ordinary publishable saved output without a retention field or filesystem changes", async () => {
    const where = await layout();
    const run = await savedRun(where, "run-no-retention", {
      content: "not yet delivered\n",
      validationCommand: "node fail.cjs",
    });
    const before = await snapshot(where.root);
    const result = JSON.parse(await showSaved(where, run, true));
    expect(result).not.toHaveProperty("retainedDelivery");
    const record = JSON.parse(
      (await readFile(join(where.stateDirectory, `${run.runId}.json`))).toString("utf8"),
    );
    await expect(
      lookupSavedRunRetainedDelivery({
        stateDirectory: where.stateDirectory,
        record,
        environment: {},
      }),
    ).resolves.toBeUndefined();
    expect(await snapshot(where.root)).toEqual(before);
  });

  it("keeps another run's failed delivery out of ordinary saved retention", async () => {
    const where = await layout(false, true);
    const other = await savedRun(where, "run-other-retention", {
      content: "another run's retained change\n",
      validationCommand: "node fail.cjs",
    });
    await failDelivery(where, other, "validation");
    const ordinary = await savedRun(where, "run-ordinary-beside-retention", {
      content: "ordinary saved change\n",
      validationCommand: "node fail.cjs",
    });
    const before = await snapshot(where.root);
    const human = await showSaved(where, ordinary, false);
    const result = JSON.parse(await showSaved(where, ordinary, true));
    expect(result).not.toHaveProperty("retainedDelivery");
    expect(human).not.toContain("Retained delivery");
    expect(await snapshot(where.root)).toEqual(before);
  });

  it("still finds a failed delivery receipt after its attempt locator is lost", async () => {
    const where = await layout(false, true);
    const run = await savedRun(where, "run-failed-without-locator", {
      content: "failed delivery without a locator\n",
      validationCommand: "node fail.cjs",
    });
    const failure = await failDelivery(where, run, "validation");
    const metadata = join(where.stateDirectory, RUN_DELIVERY_ATTEMPT_LOCATIONS);
    for (const name of await readdir(metadata)) await rm(join(metadata, name));
    const before = await snapshot(where.root);
    const result = JSON.parse(await showSaved(where, run, true));
    expect(result.retainedDelivery).toMatchObject({
      status: "retained",
      worktrees: [failure.worktreePath],
      branches: [run.plan.proposedSourceBranch],
    });
    expect(result.retainedDelivery.cleanupPreviewCommand).toContain("docsfab runs delete");
    expect(await snapshot(where.root)).toEqual(before);
  });

  it("keeps malformed attempt evidence visible as passive inspection-required guidance", async () => {
    const where = await layout(false, true);
    const run = await savedRun(where, "run-unknown-attempt", {
      content: "unknown retained delivery evidence\n",
      validationCommand: "node fail.cjs",
    });
    const metadata = join(where.stateDirectory, RUN_DELIVERY_ATTEMPT_LOCATIONS);
    await mkdir(metadata, { mode: 0o700 });
    await writeFile(join(metadata, `${"0".repeat(64)}.json`), "{}", { mode: 0o600 });
    const before = await snapshot(where.root);
    const result = JSON.parse(await showSaved(where, run, true));
    expect(result.retainedDelivery).toMatchObject({
      status: "inspection-required",
      cleanupPreviewCommand: null,
    });
    expect(await snapshot(where.root)).toEqual(before);
  });

  it("keeps an unfinished receipt visible even before it creates a worktree or locator", async () => {
    const where = await layout(false, true);
    const run = await savedRun(where, "run-unfinished-without-locator", {
      content: "unfinished delivery receipt\n",
      validationCommand: "node fail.cjs",
    });
    const authorization = authorizeLocalUserPublication({
      plan: run.plan,
      confirmedPlanSha256: run.plan.sha256,
      command: "publish",
    });
    const receipt = createScmDeliveryRecord({
      plan: run.plan,
      authorization,
      createdAt: "2026-10-15T00:00:00.000Z",
    });
    const receiptStore = new FileScmDeliveryReceiptStore(where.receiptRoot);
    await receiptStore.claim(receipt, run.plan);
    expect(await receiptStore.loadEither(receipt.idempotencyKey)).toEqual({
      kind: "scm",
      record: receipt,
    });
    const before = await snapshot(where.root);
    const result = JSON.parse(await showSaved(where, run, true));
    expect(result.retainedDelivery).toMatchObject({
      status: "inspection-required",
      worktrees: [],
      branches: [],
      cleanupPreviewCommand: null,
    });
    expect(result.retainedDelivery.explanation).toContain("original private publication roots");
    expect(await snapshot(where.root)).toEqual(before);
  });

  it("reuses one attempt through two actual ship and two one-shot publish replays", async () => {
    const where = await layout();
    const run = await savedRun(where, "run-entrypoint-replays", {
      content: "entrypoint replay change\n",
      validationCommand: "node fail.cjs",
    });
    const beforeRecord = await readFile(join(where.stateDirectory, `${run.runId}.json`));
    const environment = hermeticGitEnv({
      DOCSFAB_DELIVERY_ROOT: where.deliveryRoot,
      DOCSFAB_RECEIPT_ROOT: where.receiptRoot,
    });
    const preflight = async () => run.plan;
    const log = vi.fn();
    const executeDependencies = {
      cwd: where.root,
      stateDirectory: where.stateDirectory,
      environment,
      log,
      preflight,
      isolateValidation: async () => ({ commandPrefix: [] }),
    };
    let first: string | undefined;
    for (const surface of ["ship", "ship", "publish", "publish"] as const) {
      const pending =
        surface === "ship"
          ? handleShipCommand([run.runId, "--repo", where.source], {
              cwd: where.root,
              stateDirectory: where.stateDirectory,
              log,
              preflight,
              executeDependencies,
            })
          : runLocalUserPublishCli([run.runId, "--repo", where.source, "--draft-mr"], {
              ...executeDependencies,
              stderr: () => undefined,
            });
      await expect(pending).rejects.toMatchObject({ code: "validation-failed" });
      const attempts = await attemptDirectories(where);
      expect(attempts).toHaveLength(1);
      first ??= attempts[0];
      expect(attempts).toEqual([first]);
      expect(await readFile(join(where.stateDirectory, `${run.runId}.json`))).toEqual(beforeRecord);
      const result = JSON.parse(await showSaved(where, run, true));
      expect(result.retainedDelivery).toMatchObject({
        status: "retained",
        branches: [run.plan.proposedSourceBranch],
      });
      expect(result.retainedDelivery.worktrees).toHaveLength(1);
    }
  });

  it("reuses the exact retained attempt after repeated validation failures", async () => {
    const where = await layout();
    const run = await savedRun(where, "run-replay-stable", {
      content: "replay change\n",
      validationCommand: "node fail.cjs",
    });

    const first = await failDelivery(where, run, "validation");
    const second = await failDelivery(where, run, "validation");
    const third = await failDelivery(where, run, "validation");

    expect(second.attemptPath).toBe(first.attemptPath);
    expect(third.attemptPath).toBe(first.attemptPath);
    expect(await attemptDirectories(where)).toEqual([first.attemptPath]);
    expect(await worktrees(where.source)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: first.worktreePath,
          head: where.base,
          branch: run.plan.proposedSourceBranch,
        }),
      ]),
    );
  });

  it("replays with a tracked symlink without recursively inventorying worktree contents", async () => {
    const where = await layout(true);
    const run = await savedRun(where, "run-replay-symlink", {
      content: "symlink replay\n",
      validationCommand: "node fail.cjs",
    });

    const first = await failDelivery(where, run, "validation");
    const second = await failDelivery(where, run, "validation");

    expect(second.attemptPath).toBe(first.attemptPath);
    expect(await readlink(join(first.worktreePath, "tracked-link"))).toBe("README.md");
    expect(await attemptDirectories(where)).toEqual([first.attemptPath]);
  });

  it("reruns real validation and publishes from the same attempt after a transient validation-runner failure", async () => {
    const where = await layout();
    const run = await savedRun(where, "run-replay-recovers", {
      content: "replay change\n",
      validationCommand: "node validate.cjs",
    });
    const transientLogs: string[] = [];
    const args = [
      run.runId,
      "--repo",
      where.source,
      "--draft-mr",
      "--execute",
      "--confirm-plan-sha256",
      run.plan.sha256,
      "--delivery-root",
      where.deliveryRoot,
      "--receipt-root",
      where.receiptRoot,
      "--state-dir",
      where.stateDirectory,
    ];
    const transientError = await runLocalUserPublishExecuteCli(args, {
      cwd: where.root,
      stateDirectory: where.stateDirectory,
      log: (message) => transientLogs.push(message),
      preflight: async () => run.plan,
      isolateValidation: async () => ({
        commandPrefix: [process.execPath, "-e", "process.exit(7)"],
      }),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(transientError).toMatchObject({
      name: "DeliveryWorktreeError",
      code: "validation-failed",
    });
    const firstReport = JSON.parse(transientLogs.at(-1)!) as { preservedWorktree: string };
    const first = {
      worktreePath: firstReport.preservedWorktree,
      attemptPath: join(firstReport.preservedWorktree, "..", ".."),
    };
    const logs: string[] = [];
    const result = await runLocalUserPublishExecuteCli(args, {
      cwd: where.root,
      stateDirectory: where.stateDirectory,
      log: (message) => logs.push(message),
      preflight: async () => run.plan,
      isolateValidation: async () => ({ commandPrefix: [] }),
      publisher: acceptingPublisher(run),
    });

    expect(result).toMatchObject({ mergeRequest: { url: expect.any(String) } });
    expect(await attemptDirectories(where)).toEqual([first.attemptPath]);
    expect(
      (await worktrees(where.source)).filter((tree) => tree.path !== where.source),
    ).toHaveLength(1);
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({
      kind: "docsfab-local-user-gitlab-publication-result",
      status: "opened",
    });
  });

  it.each(["tracked", "untracked", "index", "patch"] as const)(
    "refuses a retained %s change without allocating or deleting delivery state",
    async (changed) => {
      const where = await layout();
      const run = await savedRun(where, `run-replay-${changed}`, {
        content: "replay change\n",
        validationCommand: "node fail.cjs",
      });
      const first = await failDelivery(where, run, "validation");
      if (changed === "tracked") {
        await writeFile(join(first.worktreePath, "README.md"), "operator edit\n");
      } else if (changed === "untracked") {
        await writeFile(join(first.worktreePath, "operator.txt"), "keep me\n");
      } else if (changed === "index") {
        await writeFile(join(first.worktreePath, "README.md"), "staged by operator\n");
        await git(first.worktreePath, ["add", "README.md"]);
        await writeFile(join(first.worktreePath, "README.md"), "replay change\n");
      } else {
        await writeFile(
          join(first.attemptPath, deliveryCapsuleName(run.plan), "verified.patch"),
          "tampered patch\n",
        );
      }

      const second = await failDelivery(
        where,
        run,
        "validation",
        [],
        changed === "patch" ? "patch-mismatch" : "delivery-collision",
      );

      expect(second.attemptPath).toBe(first.attemptPath);
      expect(await attemptDirectories(where)).toEqual([first.attemptPath]);
      if (changed === "tracked")
        expect(await readFile(join(first.worktreePath, "README.md"), "utf8")).toBe(
          "operator edit\n",
        );
      if (changed === "untracked")
        expect(await readFile(join(first.worktreePath, "operator.txt"), "utf8")).toBe("keep me\n");
      if (changed === "index")
        expect(await git(first.worktreePath, ["show", ":README.md"], { trim: false })).toBe(
          "staged by operator\n",
        );
      if (changed === "index")
        expect(await readFile(join(first.worktreePath, "README.md"), "utf8")).toBe(
          "replay change\n",
        );
      if (changed === "patch")
        expect(
          await readFile(
            join(first.attemptPath, deliveryCapsuleName(run.plan), "verified.patch"),
            "utf8",
          ),
        ).toBe("tampered patch\n");
    },
  );

  it("names the preserved worktree and branch and prints a runnable runs delete preview", async () => {
    const where = await layout();
    const run = await savedRun(where, "run-guidance", {
      content: "guided change\n",
      validationCommand: "node fail.cjs",
    });

    const failure = await failDelivery(where, run, "validation");

    const branch = run.plan.proposedSourceBranch;
    const command = `docsfab runs delete ${run.runId} --state-dir ${where.stateDirectory} --delivery-root ${where.deliveryRoot} --receipt-root ${where.receiptRoot}`;
    expect(failure.logs).toContain(
      `Preserved for inspection: worktree ${failure.worktreePath}, branch ${branch}`,
    );
    expect(failure.logs).toContain(`${PREVIEW_PREFIX}${command}`);
    expect(JSON.parse(failure.logs.at(-1)!)).toMatchObject({
      kind: "docsfab-local-user-gitlab-publication-result",
      status: "failed",
      failureCode: "validation-failed",
      preservedWorktree: failure.worktreePath,
      preservedBranch: branch,
      cleanupPreviewCommand: command,
    });
    // Preservation is unchanged: the failure itself deletes nothing.
    expect(await exists(join(failure.worktreePath, "README.md"))).toBe(true);
    expect(await branchRevision(where.source, branch)).toBe(where.base);

    const preview = await runPrinted(printedPreview(failure));
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).not.toContain("require ownership review");
    expect(preview.stdout).toContain(
      `Git cleanup: 1 delivery worktree(s) and 1 delivery branch(es) (${branch}) would be removed.`,
    );
    // A preview changes nothing.
    expect(await exists(join(failure.worktreePath, "README.md"))).toBe(true);
    expect(await branchRevision(where.source, branch)).toBe(where.base);
  });

  it("deletes every retained attempt of a repeatedly failed delivery and keeps unrelated Git state, files, and runs", async () => {
    const where = await layout();
    const target = await savedRun(where, "run-target", {
      content: "target change\n",
      validationCommand: "node validate.cjs",
    });
    const unrelated = await savedRun(where, "run-unrelated", {
      content: "unrelated change\n",
      validationCommand: "node validate.cjs",
    });
    const userWorktree = join(where.root, "user-worktree");
    await git(where.source, ["worktree", "add", "-b", "user-topic", userWorktree, where.base]);
    await writeFile(join(where.source, "notes.txt"), "operator notes\n");
    const unrelatedFailure = await failDelivery(where, unrelated, "inspection");
    const failures = [
      await failDelivery(where, target, "inspection"),
      await failDelivery(where, target, "inspection"),
      await failDelivery(where, target, "inspection"),
    ];
    const legacy = [
      await createLegacyDetachedAttempt(where, target, "target-a"),
      await createLegacyDetachedAttempt(where, target, "target-b"),
    ];

    const branch = target.plan.proposedSourceBranch;
    const before = await worktrees(where.source);
    expect(failures.map((failure) => failure.attemptPath)).toEqual([
      failures[0]!.attemptPath,
      failures[0]!.attemptPath,
      failures[0]!.attemptPath,
    ]);
    expect(before.find((candidate) => candidate.path === failures[0]!.worktreePath)?.branch).toBe(
      branch,
    );
    expect(
      legacy.map(
        (item) => before.find((candidate) => candidate.path === item.worktreePath)?.branch,
      ),
    ).toEqual([undefined, undefined]);
    for (const failure of failures) {
      expect(failure.logs).toContain(
        `Preserved for inspection: worktree ${failure.worktreePath}, branch ${branch}`,
      );
    }

    const preview = await runPrinted(printedPreview(failures.at(-1)!));
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).not.toContain("require ownership review");
    expect(preview.stdout).toContain(
      `Git cleanup: 3 delivery worktree(s) and 1 delivery branch(es) (${branch}) would be removed.`,
    );
    const confirmed = await runPrinted(printedConfirmation(preview.stdout));
    expect(confirmed.stdout, confirmed.stdout).toMatch(
      new RegExp(`^Run ${target.runId}: removed [0-9]+ local entr\\(ies\\)\\.$`, "u"),
    );
    expect(confirmed.exitCode).toBe(0);

    const after = await worktrees(where.source);
    for (const failure of failures) {
      expect(after.map((worktree) => worktree.path)).not.toContain(failure.worktreePath);
      expect(await exists(failure.attemptPath)).toBe(false);
    }
    for (const attempt of legacy) {
      expect(after.map((worktree) => worktree.path)).not.toContain(attempt.worktreePath);
      expect(await exists(attempt.attemptPath)).toBe(false);
    }
    expect(await branchRevision(where.source, branch)).toBeUndefined();
    expect(await exists(join(where.stateDirectory, `${target.runId}.json`))).toBe(false);
    expect(await exists(target.artifactPath)).toBe(false);
    // Unrelated worktrees, branches, files, and another run's recovery evidence remain.
    expect(after).toEqual(
      expect.arrayContaining([
        { path: where.source, head: where.base, branch: "main" },
        { path: userWorktree, head: where.base, branch: "user-topic" },
        {
          path: unrelatedFailure.worktreePath,
          head: where.base,
          branch: unrelated.plan.proposedSourceBranch,
        },
      ]),
    );
    expect(after).toHaveLength(3);
    expect(await branchRevision(where.source, unrelated.plan.proposedSourceBranch)).toBe(
      where.base,
    );
    expect(await readFile(join(where.source, "notes.txt"), "utf8")).toBe("operator notes\n");
    expect(await exists(join(unrelatedFailure.worktreePath, "README.md"))).toBe(true);
    expect(await exists(join(where.stateDirectory, `${unrelated.runId}.json`))).toBe(true);
    expect(await exists(unrelated.artifactPath)).toBe(true);
    const unrelatedPreview = await runPrinted(printedPreview(unrelatedFailure));
    expect(unrelatedPreview.stdout).toContain(
      `Git cleanup: 1 delivery worktree(s) and 1 delivery branch(es) (${unrelated.plan.proposedSourceBranch}) would be removed.`,
    );
  });

  it("deletes a legacy detached attempt after a patch-conflict replay", async () => {
    const where = await layout();
    const run = await savedRun(where, "run-conflict", {
      content: "conflicting change\n",
      validationCommand: "node validate.cjs",
      corruptPatch: true,
    });
    const first = await failDelivery(where, run, "patch");
    const legacy = await createLegacyDetachedAttempt(where, run, "patch");
    const retry = first;
    const branch = run.plan.proposedSourceBranch;
    const before = await worktrees(where.source);
    expect(before.find((worktree) => worktree.path === first.worktreePath)?.branch).toBe(branch);
    expect(
      before.find((worktree) => worktree.path === legacy.worktreePath)?.branch,
    ).toBeUndefined();

    const preview = await runPrinted(printedPreview(retry));
    expect(preview.stdout).not.toContain("require ownership review");
    expect(preview.stdout).toContain(
      `Git cleanup: 2 delivery worktree(s) and 1 delivery branch(es) (${branch}) would be removed.`,
    );
    const confirmed = await runPrinted(printedConfirmation(preview.stdout));
    expect(confirmed.exitCode, confirmed.stdout).toBe(0);
    expect((await worktrees(where.source)).map((worktree) => worktree.path)).toEqual([
      where.source,
    ]);
    expect(await branchRevision(where.source, branch)).toBeUndefined();
  });

  it("reuses a committed retained attempt after a rejected push and deletes its exact state", async () => {
    const where = await layout();
    const run = await savedRun(where, "run-push-rejected", {
      content: "rejected push change\n",
      validationCommand: "node validate.cjs",
    });
    // DocsFab's publisher refuses repository-local signing settings; this fixture's helper sets one.
    await git(where.source, ["config", "--unset", "commit.gpgsign"]);
    const first = await failDelivery(where, run, "push");
    const branch = run.plan.proposedSourceBranch;
    const commit = await branchRevision(where.source, branch);
    expect(commit).toMatch(/^[a-f0-9]{40}$/u);
    expect(commit).not.toBe(where.base);
    expect(await git(where.source, ["rev-parse", `${commit}^`])).toBe(where.base);
    expect(first.logs).toContain(
      `Preserved for inspection: worktree ${first.worktreePath}, branch ${branch}`,
    );
    expect(JSON.parse(first.logs.at(-1)!)).toMatchObject({
      status: "failed",
      failureCode: "push-failed",
      preservedWorktree: first.worktreePath,
      preservedBranch: branch,
    });
    const retry = await failDelivery(where, run, "push");
    expect(retry.attemptPath).toBe(first.attemptPath);
    const before = await worktrees(where.source);
    expect(before.find((worktree) => worktree.path === first.worktreePath)?.branch).toBe(branch);
    expect(before).toHaveLength(2);

    const preview = await runPrinted(printedPreview(retry));
    expect(preview.stdout).not.toContain("require ownership review");
    expect(preview.stdout).toContain(
      `Git cleanup: 1 delivery worktree(s) and 1 delivery branch(es) (${branch}) would be removed.`,
    );
    const confirmed = await runPrinted(printedConfirmation(preview.stdout));
    expect(confirmed.exitCode, confirmed.stdout).toBe(0);
    expect((await worktrees(where.source)).map((worktree) => worktree.path)).toEqual([
      where.source,
    ]);
    expect(await branchRevision(where.source, branch)).toBeUndefined();
  });

  it("prints a runnable preview even when a failure leaves no worktree or branch", async () => {
    const where = await layout();
    const run = await savedRun(where, "run-nothing-kept", {
      content: "early failure change\n",
      validationCommand: "node validate.cjs",
    });
    const logs: string[] = [];
    const error = await runLocalUserPublishExecuteCli(
      [
        run.runId,
        "--repo",
        where.source,
        "--draft-mr",
        "--execute",
        "--confirm-plan-sha256",
        run.plan.sha256,
        "--delivery-root",
        where.deliveryRoot,
        "--receipt-root",
        where.receiptRoot,
        "--state-dir",
        where.stateDirectory,
      ],
      {
        cwd: where.root,
        stateDirectory: where.stateDirectory,
        log: (message) => logs.push(message),
        preflight: async () => run.plan,
        prepareWorktree: async (input) => {
          await input.onPrepared?.({
            workspaceKey: "9".repeat(64),
            baseRevision: run.plan.baseRevision,
          });
          throw new DeliveryWorktreeError("worktree-creation-failed");
        },
      },
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ name: "DeliveryWorktreeError", code: "validation-failed" });

    const command = `docsfab runs delete ${run.runId} --state-dir ${where.stateDirectory} --delivery-root ${where.deliveryRoot} --receipt-root ${where.receiptRoot}`;
    expect(logs.filter((line) => line.startsWith("Preserved for inspection:"))).toEqual([]);
    expect(logs).toContain(`${PREVIEW_PREFIX}${command}`);
    const result = JSON.parse(logs.at(-1)!) as Record<string, unknown>;
    expect(result).toMatchObject({ status: "failed", cleanupPreviewCommand: command });
    expect(result).not.toHaveProperty("preservedWorktree");
    expect(result).not.toHaveProperty("preservedBranch");
    const preview = await runPrinted(command);
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).not.toContain("require ownership review");
    expect(preview.stdout).not.toContain("Git cleanup:");
  });

  it("refuses a legacy detached attempt whose HEAD moved and removes nothing", async () => {
    const where = await layout();
    const run = await savedRun(where, "run-moved-head", {
      content: "moved head change\n",
      validationCommand: "node validate.cjs",
    });
    const first = await failDelivery(where, run, "inspection");
    const retry = await failDelivery(where, run, "inspection");
    const legacy = await createLegacyDetachedAttempt(where, run, "moved-head");
    await git(legacy.worktreePath, ["commit", "-q", "-m", "operator commit in the retry"]);
    const moved = await git(legacy.worktreePath, ["rev-parse", "HEAD"]);
    const branch = run.plan.proposedSourceBranch;

    const preview = await runPrinted(printedPreview(retry));
    expect(preview.stdout).toContain(
      "1 unattributed local entry(ies) require ownership review before deletion can complete.",
    );
    const confirmed = await runPrinted(printedConfirmation(preview.stdout));
    expect(confirmed.exitCode).toBe(1);
    expect(confirmed.stdout).toContain(`Run ${run.runId}: deletion incomplete after 0 removal(s).`);
    expect(confirmed.stdout).toContain(
      `Attempt branch or commit changed for ${legacy.attemptPath}; inspect it.`,
    );
    const after = await worktrees(where.source);
    expect(after.find((worktree) => worktree.path === first.worktreePath)?.branch).toBe(branch);
    expect(after.find((worktree) => worktree.path === legacy.worktreePath)?.head).toBe(moved);
    expect(await branchRevision(where.source, branch)).toBe(where.base);
    expect(await exists(join(where.stateDirectory, `${run.runId}.json`))).toBe(true);
  });

  it("refuses an attached attempt whose run branch moved and removes nothing", async () => {
    const where = await layout();
    const run = await savedRun(where, "run-moved-branch", {
      content: "moved branch change\n",
      validationCommand: "node validate.cjs",
    });
    const first = await failDelivery(where, run, "inspection");
    const retry = await failDelivery(where, run, "inspection");
    const branch = run.plan.proposedSourceBranch;
    const tree = await git(where.source, ["rev-parse", `${where.base}^{tree}`]);
    const other = await git(where.source, [
      "commit-tree",
      tree,
      "-p",
      where.base,
      "-m",
      "operator commit on the run branch",
    ]);
    await git(where.source, ["update-ref", `refs/heads/${branch}`, other, where.base]);

    const preview = await runPrinted(printedPreview(retry));
    expect(preview.stdout).toContain(
      "1 unattributed local entry(ies) require ownership review before deletion can complete.",
    );
    const confirmed = await runPrinted(printedConfirmation(preview.stdout));
    expect(confirmed.exitCode).toBe(1);
    expect(confirmed.stdout).toContain(`Run ${run.runId}: deletion incomplete after 0 removal(s).`);
    expect(confirmed.stdout).toContain(
      `Attempt branch or commit changed for ${first.attemptPath}; inspect it.`,
    );
    const after = (await worktrees(where.source)).map((worktree) => worktree.path);
    expect(after).toEqual(expect.arrayContaining([first.worktreePath, retry.worktreePath]));
    expect(await branchRevision(where.source, branch)).toBe(other);
  });

  it("refuses replay when the retained delivery HEAD has moved without allocating another attempt", async () => {
    const where = await layout();
    const run = await savedRun(where, "run-replay-moved-head", {
      content: "replay change\n",
      validationCommand: "node fail.cjs",
    });
    const first = await failDelivery(where, run, "validation");
    const moved = await git(where.source, ["rev-parse", "HEAD"]);
    await git(where.source, ["update-ref", `refs/heads/${run.plan.proposedSourceBranch}`, moved]);

    const retry = await failDelivery(where, run, "validation", [], "validation-failed");

    expect(retry.attemptPath).toBe(first.attemptPath);
    expect(await attemptDirectories(where)).toEqual([first.attemptPath]);
    expect(await branchRevision(where.source, run.plan.proposedSourceBranch)).toBe(moved);
  });

  it("refuses a branch that moves after partial Git cleanup and keeps the operator's commit", async () => {
    const where = await layout();
    const run = await savedRun(where, "run-resume-moved", {
      content: "resume moved change\n",
      validationCommand: "node validate.cjs",
    });
    const first = await failDelivery(where, run, "inspection");
    const retry1 = await failDelivery(where, run, "inspection");
    const retry2 = await failDelivery(where, run, "inspection");
    const branch = run.plan.proposedSourceBranch;
    // Without the attached worktree, only the branch's own evidence can notice a moved tip.
    await git(where.source, ["worktree", "remove", "--force", first.worktreePath]);
    const legacy = [
      await createLegacyDetachedAttempt(where, run, "resume-a"),
      await createLegacyDetachedAttempt(where, run, "resume-b"),
    ];
    const tree = await git(where.source, ["rev-parse", `${where.base}^{tree}`]);
    const operator = await git(where.source, [
      "commit-tree",
      tree,
      "-p",
      where.base,
      "-m",
      "operator work on the run branch",
    ]);

    // The tip moves after the preview and before the confirmation: the token no longer matches.
    const preview = await runPrinted(printedPreview(retry2));
    if (
      !preview.stdout.includes(
        `Git cleanup: 2 delivery worktree(s) and 1 delivery branch(es) (${branch}) would be removed.`,
      )
    )
      throw new Error(`Expected registered Git cleanup in preview:\n${preview.stdout}`);
    expect(preview.stdout).toContain(
      `Git cleanup: 2 delivery worktree(s) and 1 delivery branch(es) (${branch}) would be removed.`,
    );
    await git(where.source, ["update-ref", `refs/heads/${branch}`, operator, where.base]);
    await expect(runPrinted(printedConfirmation(preview.stdout))).rejects.toMatchObject({
      code: "confirmation-changed",
    });
    expect(await branchRevision(where.source, branch)).toBe(operator);
    expect(await exists(legacy[0]!.worktreePath)).toBe(true);
    expect(await exists(legacy[1]!.worktreePath)).toBe(true);

    // Restore the tip and preview again. A locked worktree stops Git cleanup before
    // the final receipt-root phase, so no private deletion journal is written.
    await git(where.source, ["update-ref", `refs/heads/${branch}`, where.base, operator]);
    const approved = await runPrinted(printedPreview(retry2));
    const token = printedConfirmation(approved.stdout);
    await git(where.source, [
      "worktree",
      "lock",
      "--reason",
      "operator lock",
      legacy[1]!.worktreePath,
    ]);
    const partial = await runPrinted(token);
    expect(partial.exitCode).toBe(1);
    expect(partial.stdout).toContain("Git refused exact worktree cleanup");
    expect(await exists(join(where.stateDirectory, ".docsfab-run-delete-journals"))).toBe(false);
    expect(await branchRevision(where.source, branch)).toBe(where.base);

    // The tip moves again. The old token cannot authorize changed Git state.
    await git(where.source, ["update-ref", `refs/heads/${branch}`, operator, where.base]);
    await git(where.source, ["worktree", "unlock", legacy[1]!.worktreePath]);
    await expect(runPrinted(token)).rejects.toMatchObject({ code: "confirmation-changed" });
    expect(await branchRevision(where.source, branch)).toBe(operator);
    expect(await exists(legacy[0]!.worktreePath)).toBe(false);
    expect(await exists(legacy[1]!.worktreePath)).toBe(true);
    expect(await exists(join(where.stateDirectory, `${run.runId}.json`))).toBe(true);

    // A later interruption after the final gate has begun really does persist a
    // journal. Its approved branch tip must still be checked on every resume.
    await git(where.source, ["update-ref", `refs/heads/${branch}`, where.base, operator]);
    const reportDirectory = join(where.stateDirectory, "reports", run.runId);
    await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
    const marker = join(reportDirectory, "interrupt.txt");
    await writeFile(marker, "interrupt after Git cleanup\n", { mode: 0o600 });
    const laterPreview = await previewRunDeletion(where.stateDirectory, run.runId, {
      deliveryRoots: [where.deliveryRoot],
      receiptRoots: [where.receiptRoot],
    });
    const interrupted = await applyRunDeletion(
      where.stateDirectory,
      run.runId,
      laterPreview.confirmation,
      {
        afterRemove(path) {
          if (path === marker) throw new Error("injected final-phase interruption");
        },
      },
      { deliveryRoots: [where.deliveryRoot], receiptRoots: [where.receiptRoot] },
    );
    expect(interrupted.complete).toBe(false);
    expect(interrupted.removed).toBeGreaterThan(0);
    expect(await readdir(join(where.stateDirectory, ".docsfab-run-delete-journals"))).toHaveLength(
      1,
    );
    expect(await branchRevision(where.source, branch)).toBeUndefined();
    await git(where.source, ["update-ref", `refs/heads/${branch}`, operator]);
    const journalResume = await applyRunDeletion(
      where.stateDirectory,
      run.runId,
      laterPreview.confirmation,
    );
    expect(journalResume.complete).toBe(false);
    expect(journalResume.nextAction).toContain(`Branch ${branch} moved after preview`);
    expect(await branchRevision(where.source, branch)).toBe(operator);
    expect(await exists(join(where.stateDirectory, `${run.runId}.json`))).toBe(true);
  });

  it("deletes the run after the operator keeps their commit and removes the retained worktree", async () => {
    const where = await layout();
    const run = await savedRun(where, "run-resolved-retry", {
      content: "resolved retry change\n",
      validationCommand: "node validate.cjs",
    });
    const first = await failDelivery(where, run, "inspection");
    const retry = first;
    const legacy = await createLegacyDetachedAttempt(where, run, "resolved-retry");
    await git(legacy.worktreePath, ["commit", "-q", "-m", "operator commit in the retry"]);
    const moved = await git(legacy.worktreePath, ["rev-parse", "HEAD"]);
    const branch = run.plan.proposedSourceBranch;

    const flagged = await runPrinted(printedPreview(retry));
    expect(flagged.stdout).toContain(
      "1 unattributed local entry(ies) require ownership review before deletion can complete.",
    );
    const refused = await runPrinted(printedConfirmation(flagged.stdout));
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout).toContain(
      `Attempt branch or commit changed for ${legacy.attemptPath}; inspect it.`,
    );

    // Resolve the entry as the documentation says: save the work, then remove the worktree.
    await git(where.source, ["branch", "operator-saved-work", moved]);
    await git(where.source, ["worktree", "remove", "--force", legacy.worktreePath]);
    const preview = await runPrinted(printedPreview(retry));
    expect(preview.stdout).not.toContain("require ownership review");
    expect(preview.stdout).toContain(
      `Git cleanup: 1 delivery worktree(s) and 1 delivery branch(es) (${branch}) would be removed.`,
    );
    const confirmed = await runPrinted(printedConfirmation(preview.stdout));
    expect(confirmed.exitCode, confirmed.stdout).toBe(0);
    expect((await worktrees(where.source)).map((worktree) => worktree.path)).toEqual([
      where.source,
    ]);
    expect(await branchRevision(where.source, branch)).toBeUndefined();
    expect(await branchRevision(where.source, "operator-saved-work")).toBe(moved);
    expect(await exists(first.attemptPath)).toBe(false);
    expect(await exists(retry.attemptPath)).toBe(false);
    expect(await exists(legacy.attemptPath)).toBe(false);
    expect(await exists(join(where.stateDirectory, `${run.runId}.json`))).toBe(false);
  });

  it("keeps a run branch checked out outside the run and still deletes its detached attempt", async () => {
    const where = await layout();
    const run = await savedRun(where, "run-branch-in-use", {
      content: "branch in use change\n",
      validationCommand: "node validate.cjs",
    });
    const first = await failDelivery(where, run, "inspection");
    const retry = await failDelivery(where, run, "inspection");
    const branch = run.plan.proposedSourceBranch;
    await git(where.source, ["worktree", "remove", "--force", first.worktreePath]);
    const legacy = await createLegacyDetachedAttempt(where, run, "branch-in-use");
    const inspection = join(where.root, "operator-inspection");
    await git(where.source, ["worktree", "add", inspection, branch]);

    const preview = await runPrinted(printedPreview(retry));
    expect(preview.stdout).not.toContain("require ownership review");
    expect(preview.stdout).toContain(
      "Git cleanup: 1 delivery worktree(s) and 0 delivery branch(es) would be removed.",
    );
    expect(preview.stdout).toContain(
      `Branch ${branch} would be kept: it is checked out at ${inspection}.`,
    );
    const confirmed = await runPrinted(printedConfirmation(preview.stdout));
    expect(confirmed.exitCode, confirmed.stdout).toBe(0);
    const after = await worktrees(where.source);
    expect(after.map((worktree) => worktree.path)).not.toContain(legacy.worktreePath);
    expect(after).toContainEqual({ path: inspection, head: where.base, branch });
    expect(await branchRevision(where.source, branch)).toBe(where.base);
    expect(await exists(first.attemptPath)).toBe(false);
    expect(await exists(retry.attemptPath)).toBe(false);
    expect(await exists(legacy.attemptPath)).toBe(false);
  });

  it("keeps a run branch that the original checkout has checked out and still deletes its detached attempt", async () => {
    const where = await layout();
    const run = await savedRun(where, "run-branch-in-original", {
      content: "branch in the original checkout\n",
      validationCommand: "node validate.cjs",
    });
    const first = await failDelivery(where, run, "inspection");
    const retry = await failDelivery(where, run, "inspection");
    const branch = run.plan.proposedSourceBranch;
    await git(where.source, ["worktree", "remove", "--force", first.worktreePath]);
    const legacy = await createLegacyDetachedAttempt(where, run, "branch-original");
    // Branches that merely look like the run's own stay out of the deletion.
    await git(where.source, ["branch", `${branch}-operator`, where.base]);
    await git(where.source, ["branch", "docsfab-run/someone-else", where.base]);
    await git(where.source, ["switch", "-q", branch]);

    const preview = await runPrinted(printedPreview(retry));
    expect(preview.stdout).not.toContain("require ownership review");
    expect(preview.stdout).toContain(
      "Git cleanup: 1 delivery worktree(s) and 0 delivery branch(es) would be removed.",
    );
    expect(preview.stdout).toContain(
      `Branch ${branch} would be kept: it is checked out at ${where.source}.`,
    );
    const confirmed = await runPrinted(printedConfirmation(preview.stdout));
    expect(confirmed.exitCode, confirmed.stdout).toBe(0);
    expect((await worktrees(where.source)).map((worktree) => worktree.path)).toEqual([
      where.source,
    ]);
    expect(await git(where.source, ["symbolic-ref", "HEAD"])).toBe(`refs/heads/${branch}`);
    expect(await branchRevision(where.source, branch)).toBe(where.base);
    expect(await branchRevision(where.source, `${branch}-operator`)).toBe(where.base);
    expect(await branchRevision(where.source, "docsfab-run/someone-else")).toBe(where.base);
    expect(await exists(first.attemptPath)).toBe(false);
    expect(await exists(retry.attemptPath)).toBe(false);
    expect(await exists(legacy.attemptPath)).toBe(false);
  });

  it("keeps a run branch that another worktree is rebasing and still deletes its detached attempt", async () => {
    const where = await layout();
    const run = await savedRun(where, "run-branch-rebasing", {
      content: "branch being rebased\n",
      validationCommand: "node validate.cjs",
    });
    const first = await failDelivery(where, run, "inspection");
    const retry = await failDelivery(where, run, "inspection");
    const branch = run.plan.proposedSourceBranch;
    await git(where.source, ["worktree", "remove", "--force", first.worktreePath]);
    const legacy = await createLegacyDetachedAttempt(where, run, "branch-rebasing");
    const rebasing = join(where.root, "operator-rebase");
    await git(where.source, ["worktree", "add", rebasing, branch]);
    // A failing exec step stops the rebase with HEAD detached, so only Git's rebase state names the branch.
    await git(rebasing, ["rebase", "--root", "-x", "false"], {
      env: { GIT_SEQUENCE_EDITOR: "true" },
    }).then(
      () => expect.unreachable("the rebase should stop at the failing exec step"),
      () => undefined,
    );
    const midRebase = (await worktrees(where.source)).find(
      (worktree) => worktree.path === rebasing,
    );
    expect(midRebase).toBeDefined();
    expect(midRebase?.branch).toBeUndefined();

    const preview = await runPrinted(printedPreview(retry));
    expect(preview.stdout).not.toContain("require ownership review");
    expect(preview.stdout).toContain(
      "Git cleanup: 1 delivery worktree(s) and 0 delivery branch(es) would be removed.",
    );
    expect(preview.stdout).toContain(
      `Branch ${branch} would be kept: it is being rebased at ${rebasing}.`,
    );
    const confirmed = await runPrinted(printedConfirmation(preview.stdout));
    expect(confirmed.exitCode, confirmed.stdout).toBe(0);
    const after = (await worktrees(where.source)).map((worktree) => worktree.path);
    expect(after).toContain(rebasing);
    expect(after).not.toContain(legacy.worktreePath);
    expect(await branchRevision(where.source, branch)).toBe(where.base);
    expect(await exists(first.attemptPath)).toBe(false);
    expect(await exists(retry.attemptPath)).toBe(false);
    expect(await exists(legacy.attemptPath)).toBe(false);
  });

  it("keeps a run branch that a rebase with update-refs in another worktree will move", async (context) => {
    // `git rebase --update-refs` and Git's guard for it first appeared in Git 2.38.
    if (!(await gitVersionAtLeast(2, 38))) {
      context.skip("rebase --update-refs and Git's guard for it need Git 2.38 or later");
    }
    const where = await layout();
    const run = await savedRun(where, "run-branch-update-refs", {
      content: "branch moved by update-refs\n",
      validationCommand: "node validate.cjs",
    });
    // DocsFab's publisher refuses repository-local signing settings; this fixture's helper sets one.
    await git(where.source, ["config", "--unset", "commit.gpgsign"]);
    const first = await failDelivery(where, run, "push");
    const branch = run.plan.proposedSourceBranch;
    const commit = await branchRevision(where.source, branch);
    expect(commit).toMatch(/^[a-f0-9]{40}$/u);
    expect(commit).not.toBe(where.base);
    // The operator removed the attached attempt worktree, so no worktree has the branch checked out.
    await git(where.source, ["worktree", "remove", "--force", first.worktreePath]);
    // They stack a topic branch on the pending delivery commit while main moves on.
    const topicTree = join(where.root, "operator-topic");
    await git(where.source, ["worktree", "add", "-q", "-b", "topic", topicTree, commit!]);
    await writeFile(join(topicTree, "topic.txt"), "topic\n");
    await git(topicTree, ["add", "topic.txt"]);
    await git(topicTree, ["commit", "-q", "-m", "topic work"]);
    await writeFile(join(where.source, "main-moves.txt"), "main\n");
    await git(where.source, ["add", "main-moves.txt"]);
    await git(where.source, ["commit", "-q", "-m", "main moves on"]);
    // HEAD there names topic. Only the update-refs state lists the run branch, and Git's own
    // deletion refuses it, in wording that varies by version.
    await git(topicTree, ["rebase", "--update-refs", "-x", "false", "main"], {
      env: { GIT_SEQUENCE_EDITOR: "true" },
    }).then(
      () => expect.unreachable("the rebase should stop at the failing exec step"),
      () => undefined,
    );
    await expect(git(where.source, ["branch", "-D", branch])).rejects.toThrow();
    expect(await branchRevision(where.source, branch)).toBe(commit);

    const preview = await runPrinted(printedPreview(first));
    expect(preview.stdout).not.toContain("require ownership review");
    expect(preview.stdout).not.toContain("Git cleanup:");
    expect(preview.stdout).toContain(
      `Branch ${branch} would be kept: it is being rebased at ${topicTree}.`,
    );
    const confirmed = await runPrinted(printedConfirmation(preview.stdout));
    expect(confirmed.exitCode, confirmed.stdout).toBe(0);
    expect(await branchRevision(where.source, branch)).toBe(commit);
    expect((await worktrees(where.source)).map((worktree) => worktree.path)).toContain(topicTree);
    expect(await exists(first.attemptPath)).toBe(false);
    expect(await exists(join(where.stateDirectory, `${run.runId}.json`))).toBe(false);
  });

  it("keeps a run branch that no longer points at the run's base revision", async () => {
    const where = await layout();
    const run = await savedRun(where, "run-branch-moved", {
      content: "branch moved change\n",
      validationCommand: "node validate.cjs",
    });
    const first = await failDelivery(where, run, "inspection");
    const retry = await failDelivery(where, run, "inspection");
    const branch = run.plan.proposedSourceBranch;
    await git(where.source, ["worktree", "remove", "--force", first.worktreePath]);
    const tree = await git(where.source, ["rev-parse", `${where.base}^{tree}`]);
    const other = await git(where.source, [
      "commit-tree",
      tree,
      "-p",
      where.base,
      "-m",
      "operator work on the run branch",
    ]);
    await git(where.source, ["branch", "-f", branch, other]);

    const preview = await runPrinted(printedPreview(retry));
    expect(preview.stdout).not.toContain("require ownership review");
    expect(preview.stdout).toContain(
      `Branch ${branch} would be kept: it points at ${other}, not at the run's base revision or its recorded delivery commit.`,
    );
    const confirmed = await runPrinted(printedConfirmation(preview.stdout));
    expect(confirmed.exitCode, confirmed.stdout).toBe(0);
    expect(await branchRevision(where.source, branch)).toBe(other);
    expect((await worktrees(where.source)).map((worktree) => worktree.path)).toEqual([
      where.source,
    ]);
  });

  it("keeps an operator-named --source-branch and still deletes the run's attempts", async () => {
    const where = await layout();
    const branch = "operator/named-delivery";
    const run = await savedRun(where, "run-operator-branch", {
      content: "operator branch change\n",
      validationCommand: "node validate.cjs",
      sourceBranch: branch,
    });
    const first = await failDelivery(where, run, "inspection", ["--source-branch", branch]);
    const retry = await failDelivery(where, run, "inspection", ["--source-branch", branch]);
    const legacy = await createLegacyDetachedAttempt(where, run, "operator-branch");
    expect(run.plan.proposedSourceBranch).toBe(branch);
    expect(first.logs).toContain(
      `Preserved for inspection: worktree ${first.worktreePath}, branch ${branch}`,
    );
    const before = await worktrees(where.source);
    expect(before.find((worktree) => worktree.path === first.worktreePath)?.branch).toBe(branch);
    expect(
      before.find((worktree) => worktree.path === legacy.worktreePath)?.branch,
    ).toBeUndefined();

    const preview = await runPrinted(printedPreview(retry));
    expect(preview.stdout).not.toContain("require ownership review");
    expect(preview.stdout).toContain(
      "Git cleanup: 2 delivery worktree(s) and 0 delivery branch(es) would be removed.",
    );
    expect(preview.stdout).toContain(
      `Branch ${branch} would be kept: DocsFab did not name it for this run.`,
    );
    const confirmed = await runPrinted(printedConfirmation(preview.stdout));
    expect(confirmed.exitCode, confirmed.stdout).toBe(0);
    expect((await worktrees(where.source)).map((worktree) => worktree.path)).toEqual([
      where.source,
    ]);
    expect(await branchRevision(where.source, branch)).toBe(where.base);
    expect(await exists(first.attemptPath)).toBe(false);
    expect(await exists(retry.attemptPath)).toBe(false);
    expect(await exists(legacy.attemptPath)).toBe(false);
  });

  it("keeps the run branch when its repository no longer matches the approved plan", async () => {
    const where = await layout();
    const run = await savedRun(where, "run-repository-changed", {
      content: "repository changed\n",
      validationCommand: "node validate.cjs",
    });
    const failure = await failDelivery(where, run, "inspection");
    const branch = run.plan.proposedSourceBranch;
    await git(where.source, ["worktree", "remove", "--force", failure.worktreePath]);
    await git(where.source, [
      "remote",
      "set-url",
      "origin",
      "https://gitlab.example.test/other/docs.git",
    ]);

    const preview = await runPrinted(printedPreview(failure));
    expect(preview.stdout).not.toContain("require ownership review");
    expect(preview.stdout).not.toContain("Git cleanup:");
    expect(preview.stdout).toContain(
      `Branch ${branch} would be kept: the original repository at ${where.source} could not be inspected.`,
    );
    const confirmed = await runPrinted(printedConfirmation(preview.stdout));
    expect(confirmed.exitCode, confirmed.stdout).toBe(0);
    expect(await branchRevision(where.source, branch)).toBe(where.base);
    expect(await exists(failure.attemptPath)).toBe(false);
  });
});
