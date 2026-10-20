// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-git fixture for advancing a DocsFab-minted draft-MR branch: a source
 * checkout, a bare repository standing in for the GitLab remote, and a fake
 * GitLab API. The publisher's git runner maps only the remote URL to the bare
 * repository and allows the file transport for this test; product SAFE_CONFIG
 * is unchanged.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  DeterministicLocalGitPublisher,
  ExecFileGitPublisherCommandRunner,
  FileScmDeliveryReceiptStore,
  LocalUserGitLabPublisherAdapter,
  preflightLocalUserGitLabPublication,
  runLocalUserPublishExecuteCli,
  scmDeliveryIdempotencyKey,
  type GitLabPublisherCommandResult,
  type GitLabPublisherCommandRunner,
  type GitPublisherCommandResult,
  type GitPublisherCommandRunner,
  type LocalUserGitLabPublisherHooks,
  type LocalUserPublicationAdvanceV1,
  type LocalUserPublicationPlan,
  type ReadOnlyCommandResult,
  type ReadOnlyCommandRunner,
  type ScmDeliveryRecord,
  type ScmDeliveryReceiptStore,
  assertLocalUserPublicationPlan,
  assertScmDeliveryRecordShape,
} from "../../../src/delivery/index.js";

const exec = promisify(execFile);
const MAX_BUFFER = 8 * 1024 * 1024;

export const HOST = "gitlab.example.test";
export const PROJECT_PATH = "group/docs";
export const PROJECT_ID = 42;
export const REMOTE_URL = `https://${HOST}/${PROJECT_PATH}.git`;
export const USERNAME = "maintainer";
export const USER_ID = 7;
export const VALIDATION = "node validate.cjs";
/** Product publisher git configuration, asserted unchanged on every recorded call. */
export const PRODUCT_SAFE_CONFIG = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "commit.gpgSign=false",
  "-c",
  "tag.gpgSign=false",
  "-c",
  "diff.trustExitCode=false",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.ssh.allow=always",
  "-c",
  "protocol.https.allow=always",
] as const;

const FIXTURE_GIT_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Human Reviewer",
  GIT_AUTHOR_EMAIL: "reviewer@example.test",
  GIT_COMMITTER_NAME: "Human Reviewer",
  GIT_COMMITTER_EMAIL: "reviewer@example.test",
  LC_ALL: "C",
};

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await exec("git", args, { cwd, env: FIXTURE_GIT_ENV, maxBuffer: MAX_BUFFER });
  return result.stdout.trim();
}

async function gitBuffer(cwd: string, ...args: string[]): Promise<Buffer> {
  const result = await exec("git", args, {
    cwd,
    env: FIXTURE_GIT_ENV,
    encoding: "buffer",
    maxBuffer: MAX_BUFFER,
  });
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
}

/** The bare remote's head of one branch, or undefined when the branch is absent. */
export async function bareHead(bare: string, branch: string): Promise<string | undefined> {
  try {
    return await git(bare, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`);
  } catch {
    return undefined;
  }
}

export interface FakeMergeRequest {
  iid: number;
  state: "opened" | "closed" | "merged";
  draft: boolean;
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  /** Pinned MR head; the live bare branch head when absent (an instant GitLab refresh). */
  sha?: string;
}

/** Stateful GitLab API double over the bare remote. */
export class FakeGitLab {
  public username = USERNAME;
  public readonly mergeRequests = new Map<number, FakeMergeRequest>();
  public createCount = 0;
  public writeCount = 0;
  /** The state the list endpoint reports, to model a change after preflight. */
  public listState?: Partial<FakeMergeRequest>;
  public readonly calls: string[][] = [];

  public constructor(private readonly bare: string) {}

  public async execute(args: readonly string[]): Promise<{ exitCode: number; stdout: string }> {
    this.calls.push([...args]);
    const key = args.join(" ");
    if (key === "version") return ok("glab 1.0.0\n");
    if (key === `auth status --hostname ${HOST}`) return ok("");
    if (args[0] === "config") return failure();
    if (args[0] !== "api" || args[1] !== "--hostname" || args[2] !== HOST) return failure();
    if (args.includes("--method")) return this.write(args);
    const endpoint = args[3]!;
    if (endpoint === "user") {
      return json({
        username: this.username,
        id: USER_ID,
        name: "Maintainer",
        email: "maintainer@example.test",
      });
    }
    if (endpoint === "graphql") {
      return json({
        data: { project: { id: `gid://gitlab/Project/${PROJECT_ID}`, fullPath: PROJECT_PATH } },
      });
    }
    if (endpoint === `projects/${PROJECT_ID}`) {
      return json({
        id: PROJECT_ID,
        path_with_namespace: PROJECT_PATH,
        default_branch: "main",
        permissions: { project_access: { access_level: 30 }, group_access: null },
      });
    }
    const branchPrefix = `projects/${PROJECT_ID}/repository/branches/`;
    if (endpoint.startsWith(branchPrefix)) {
      const name = decodeURIComponent(endpoint.slice(branchPrefix.length));
      const head = await bareHead(this.bare, name);
      if (!head) return failure();
      return json({ name, protected: name === "main", commit: { id: head } });
    }
    if (endpoint.startsWith(`projects/${PROJECT_ID}/protected_branches?`)) {
      return json([{ name: "main" }]);
    }
    const mergeBase =
      /^projects\/\d+\/repository\/merge_base\?refs\[\]=([a-f0-9]+)&refs\[\]=([a-f0-9]+)$/u.exec(
        endpoint,
      );
    if (mergeBase) {
      try {
        return json({ id: await git(this.bare, "merge-base", mergeBase[1]!, mergeBase[2]!) });
      } catch {
        return failure();
      }
    }
    const listPrefix = `projects/${PROJECT_ID}/merge_requests?`;
    if (endpoint.startsWith(listPrefix)) {
      const query = new URLSearchParams(endpoint.slice(listPrefix.length));
      const source = query.get("source_branch");
      const listed = await Promise.all(
        [...this.mergeRequests.values()]
          .filter((request) => request.sourceBranch === source)
          .map(async (request) => this.render({ ...request, ...this.listState })),
      );
      return json(listed);
    }
    const single = new RegExp(`^projects/${PROJECT_ID}/merge_requests/(\\d+)$`, "u").exec(endpoint);
    if (single) {
      const request = this.mergeRequests.get(Number(single[1]));
      return request ? json(await this.render(request)) : failure();
    }
    return failure();
  }

  private async write(args: readonly string[]): Promise<{ exitCode: number; stdout: string }> {
    this.writeCount += 1;
    const method = args[args.indexOf("--method") + 1];
    const endpoint = args[args.indexOf("--method") + 2];
    if (method !== "POST" || endpoint !== `projects/${PROJECT_ID}/merge_requests`) {
      return failure();
    }
    const fields = new Map<string, string>();
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] !== "--field") continue;
      const field = args[index + 1]!;
      const separator = field.indexOf("=");
      fields.set(field.slice(0, separator), field.slice(separator + 1));
    }
    this.createCount += 1;
    const iid = 16 + this.createCount;
    const request: FakeMergeRequest = {
      iid,
      state: "opened",
      draft: true,
      title: fields.get("title")!,
      description: fields.get("description")!,
      sourceBranch: fields.get("source_branch")!,
      targetBranch: fields.get("target_branch")!,
    };
    this.mergeRequests.set(iid, request);
    return json(await this.render(request));
  }

  /** GitLab keeps reporting an MR's last head after its branch is deleted. */
  private readonly lastHeads = new Map<number, string>();

  private async liveHead(request: FakeMergeRequest): Promise<string | undefined> {
    const head = await bareHead(this.bare, request.sourceBranch);
    if (head) this.lastHeads.set(request.iid, head);
    return head ?? this.lastHeads.get(request.iid);
  }

  private async render(request: FakeMergeRequest): Promise<Record<string, unknown>> {
    return {
      iid: request.iid,
      state: request.state,
      draft: request.draft,
      title: request.title,
      description: request.description,
      source_branch: request.sourceBranch,
      target_branch: request.targetBranch,
      sha: request.sha ?? (await this.liveHead(request)),
      source_project_id: PROJECT_ID,
      target_project_id: PROJECT_ID,
    };
  }
}

/** The read-only preflight runner: real local git, fake glab. */
export class PreflightRunner implements ReadOnlyCommandRunner {
  public constructor(private readonly gitlab: FakeGitLab) {}

  public async run(
    command: "git" | "glab" | "gh",
    args: readonly string[],
    cwd: string,
    options?: { env?: NodeJS.ProcessEnv },
  ): Promise<ReadOnlyCommandResult> {
    if (command === "gh") throw new Error("GitLab fixture does not support gh.");
    if (command === "glab") return this.gitlab.execute(args);
    try {
      const result = await exec("git", [...args], {
        cwd,
        env: options?.env ?? FIXTURE_GIT_ENV,
        maxBuffer: MAX_BUFFER,
      });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      // The product runner reports only success or failure, like this one.
      const failed = error as { stdout?: string; stderr?: string };
      return { exitCode: 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
    }
  }
}

class GlabRunner implements GitLabPublisherCommandRunner {
  public constructor(private readonly gitlab: FakeGitLab) {}

  public async run(
    _command: "glab",
    args: readonly string[],
  ): Promise<GitLabPublisherCommandResult> {
    const result = await this.gitlab.execute(args);
    return { exitCode: result.exitCode, stdout: Buffer.from(result.stdout) };
  }
}

export interface RecordedGitCall {
  /** The argv the publisher passed, before this runner rewrote anything. */
  readonly raw: readonly string[];
  /** The git subcommand and its arguments, product configuration removed. */
  readonly operation: readonly string[];
  readonly timeoutMs: number;
}

/**
 * Test-only publisher runner: rewrites the GitLab URL to the bare remote and
 * allows the file transport instead of HTTPS. `beforePush` runs just before a
 * push reaches the remote, to race it.
 */
export class BareRemoteRunner implements GitPublisherCommandRunner {
  public readonly calls: RecordedGitCall[] = [];
  public beforePush?: () => Promise<void>;
  private readonly delegate = new ExecFileGitPublisherCommandRunner();

  public constructor(private readonly bare: string) {}

  public pushes(): RecordedGitCall[] {
    return this.calls.filter((call) => call.operation[0] === "push");
  }

  public async run(
    command: "git",
    args: readonly string[],
    cwd: string,
    options: {
      env: NodeJS.ProcessEnv;
      stdin?: Uint8Array;
      timeoutMs: number;
      maxOutputBytes: number;
    },
  ): Promise<GitPublisherCommandResult> {
    let index = 0;
    while (args[index] === "-c") index += 2;
    const operation = args.slice(index);
    this.calls.push({ raw: [...args], operation, timeoutMs: options.timeoutMs });
    if (operation[0] === "push" && this.beforePush) {
      const hook = this.beforePush;
      this.beforePush = undefined;
      await hook();
    }
    const rewritten = args.map((argument) =>
      argument === REMOTE_URL
        ? this.bare
        : argument === "protocol.https.allow=always"
          ? "protocol.file.allow=always"
          : argument,
    );
    return this.delegate.run(command, rewritten, cwd, options);
  }
}

/**
 * In-process receipt store with the file store's contract: exact-shape records
 * that survive a JSON round trip, plans bound at the first claim, and
 * compare-and-swap. Each process restart in a test reuses it, as the file
 * store would persist across processes.
 */
export class MemoryReceiptStore implements ScmDeliveryReceiptStore {
  public readonly records = new Map<string, string>();
  public readonly plans = new Map<string, string>();
  public claims = 0;
  public writes = 0;

  public async load(idempotencyKey: string): Promise<ScmDeliveryRecord | undefined> {
    const bytes = this.records.get(idempotencyKey);
    return bytes === undefined ? undefined : assertScmDeliveryRecordShape(JSON.parse(bytes));
  }

  public async loadPlan(planSha256: string): Promise<LocalUserPublicationPlan | undefined> {
    const bytes = this.plans.get(planSha256);
    if (bytes === undefined) return undefined;
    const plan = JSON.parse(bytes) as unknown;
    assertLocalUserPublicationPlan(plan);
    return plan;
  }

  public async claim(
    record: ScmDeliveryRecord,
    plan?: LocalUserPublicationPlan,
  ): Promise<{ record: ScmDeliveryRecord; created: boolean }> {
    this.claims += 1;
    const existing = await this.load(record.idempotencyKey);
    if (existing) return { record: existing, created: false };
    this.writes += 1;
    this.records.set(record.idempotencyKey, JSON.stringify(record));
    if (plan) this.plans.set(plan.sha256, JSON.stringify(plan));
    return {
      record: assertScmDeliveryRecordShape(JSON.parse(JSON.stringify(record))),
      created: true,
    };
  }

  public async compareAndSwap(
    expectedSha256: string,
    record: ScmDeliveryRecord,
  ): Promise<ScmDeliveryRecord> {
    const current = await this.load(record.idempotencyKey);
    if (!current || current.sha256 !== expectedSha256) throw new Error("receipt conflict");
    this.writes += 1;
    this.records.set(record.idempotencyKey, JSON.stringify(record));
    return assertScmDeliveryRecordShape(JSON.parse(JSON.stringify(record)));
  }
}

export interface AdvanceFixture {
  root: string;
  source: string;
  bare: string;
  state: string;
  receipts: string;
  deliveries: string;
  home: string;
  gitlab: FakeGitLab;
  git: BareRemoteRunner;
  base: string;
  /** The in-process store, or undefined to use the file store under `receipts`. */
  store?: MemoryReceiptStore;
}

export async function createAdvanceFixture(
  options: { fileStore?: boolean } = {},
): Promise<AdvanceFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-advance-")));
  const source = join(root, "source");
  const bare = join(root, "remote.git");
  const state = join(root, "state");
  const home = join(root, "home");
  await Promise.all([mkdir(source), mkdir(home), mkdir(state, { mode: 0o700 })]);
  await git(root, "init", "--bare", "-b", "main", bare);
  await git(source, "init", "-b", "main");
  await git(source, "config", "user.name", "Maintainer");
  await git(source, "config", "user.email", "maintainer@example.test");
  await writeFile(join(source, "README.md"), "original\n");
  await writeFile(join(source, "guide.md"), "guide\n");
  await writeFile(join(source, "validate.cjs"), "process.exit(0);\n");
  await git(source, "add", "-A");
  await git(source, "commit", "-m", "base");
  await git(source, "remote", "add", "origin", REMOTE_URL);
  await git(source, "push", "--quiet", bare, "main:refs/heads/main");
  const gitlab = new FakeGitLab(bare);
  return {
    root,
    source,
    bare,
    state,
    receipts: join(root, "receipts"),
    deliveries: join(root, "deliveries"),
    home,
    gitlab,
    git: new BareRemoteRunner(bare),
    base: await git(source, "rev-parse", "HEAD"),
    ...(options.fileStore ? {} : { store: new MemoryReceiptStore() }),
  };
}

export async function removeAdvanceFixture(fixture: AdvanceFixture | undefined): Promise<void> {
  if (fixture) await rm(fixture.root, { recursive: true, force: true });
}

export interface FixtureRun {
  runId: string;
  recordPath: string;
  revision: string;
}

/** Write a succeeded run record at `revision` whose patch writes `content` to `path`. */
export async function writeRun(
  fixture: AdvanceFixture,
  runId: string,
  revision: string,
  path: string,
  content: string,
): Promise<FixtureRun> {
  const writer = join(fixture.root, `writer-${runId}`);
  await git(fixture.source, "worktree", "add", "--detach", writer, revision);
  await writeFile(join(writer, path), content);
  await git(writer, "add", "-A");
  const patch = await gitBuffer(writer, "diff", "--cached", "--binary", "--full-index", "--");
  await git(fixture.source, "worktree", "remove", "--force", writer);
  const patchPath = join(fixture.state, `${runId}.patch`);
  await writeFile(patchPath, patch, { mode: 0o600 });
  const reference = {
    kind: "ia-plan",
    schemaVersion: 1,
    digest: "a".repeat(64),
    repositoryRevision: revision,
    repositoryContentDigest: "b".repeat(64),
  };
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 };
  const record = {
    schemaVersion: 2,
    id: runId,
    workflow: "site-bootstrap",
    repository: { sourcePath: fixture.source, requestedRevision: "HEAD", revision },
    workspace: { strategy: "tracked-export", disposable: true },
    task: { kind: "site-bootstrap", plan: reference },
    status: "succeeded",
    createdAt: "2026-08-04T00:00:00.000Z",
    startedAt: "2026-08-04T00:00:01.000Z",
    completedAt: "2026-08-04T00:00:02.000Z",
    durationMs: 1000,
    models: [],
    skills: [],
    usage,
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    securityScan: {
      ruleSet: "credential-rules-v1",
      status: "passed",
      scannedFiles: 1,
      binaryFiles: 0,
      findings: [],
    },
    securityScanEffectiveDisposition: { status: "passed" },
    artifacts: [{ role: "input", stepId: "apply-site-bootstrap", reference }],
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
        usage,
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
          cache: { disposition: "miss", keyDigest: "d".repeat(64), rebuildAttempted: true },
        },
        artifacts: [{ role: "input", stepId: "apply-site-bootstrap", reference }],
        summary: "Applied approved site plan.",
      },
    ],
    changes: {
      files: [{ path, status: "modified" }],
      patch: {
        sha256: createHash("sha256").update(patch).digest("hex"),
        byteLength: patch.byteLength,
        lineCount: patch.toString("utf8").split("\n").length - 1,
        artifactPath: patchPath,
        format: "git-diff",
      },
    },
  };
  const recordPath = join(fixture.state, `${runId}.json`);
  await writeFile(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return { runId, recordPath, revision };
}

/** Create a commit on `parent` that writes `path`, without touching any ref. */
export async function commitOn(
  fixture: AdvanceFixture,
  parent: string,
  path: string,
  content: string,
): Promise<string> {
  const writer = join(
    fixture.root,
    `commit-${createHash("sha256")
      .update(path + content)
      .digest("hex")
      .slice(0, 8)}`,
  );
  await git(fixture.source, "worktree", "add", "--detach", writer, parent);
  await writeFile(join(writer, path), content);
  await git(writer, "add", "-A");
  await git(writer, "commit", "--quiet", "-m", `human edit of ${path}`);
  const revision = await git(writer, "rev-parse", "HEAD");
  await git(fixture.source, "worktree", "remove", "--force", writer);
  return revision;
}

export function receiptStore(fixture: AdvanceFixture): ScmDeliveryReceiptStore {
  return fixture.store ?? new FileScmDeliveryReceiptStore(fixture.receipts);
}

export interface PublishOptions {
  advance?: LocalUserPublicationAdvanceV1;
  hooks?: LocalUserGitLabPublisherHooks;
  receiptRoot?: string;
  targetBranch?: string;
  /** Skip the host-side preflight and confirm this digest instead. */
  confirm?: string;
  /** Run the host-side preflight without a receipt store. */
  withoutStore?: boolean;
}

/** Fresh preflight, then the execute CLI with the real preflight inside it. */
export async function publish(
  fixture: AdvanceFixture,
  run: FixtureRun,
  options: PublishOptions = {},
): Promise<{ plan?: LocalUserPublicationPlan; logs: string[] }> {
  const receiptRoot = options.receiptRoot ?? fixture.receipts;
  const commands = new PreflightRunner(fixture.gitlab);
  const plan =
    options.confirm === undefined
      ? await preflightLocalUserGitLabPublication(
          {
            runId: run.runId,
            runRecordPath: run.recordPath,
            repositoryPath: fixture.source,
            validationCommand: VALIDATION,
            draftMergeRequest: true,
            ...(options.targetBranch ? { targetBranch: options.targetBranch } : {}),
            ...(options.advance ? { advance: options.advance } : {}),
          },
          commands,
          {},
          options.withoutStore
            ? {}
            : fixture.store
              ? { receiptStore: fixture.store }
              : (await exists(receiptRoot))
                ? { receiptStore: new FileScmDeliveryReceiptStore(receiptRoot) }
                : {},
        )
      : undefined;
  const logs: string[] = [];
  await runLocalUserPublishExecuteCli(
    [
      run.runId,
      "--repo",
      fixture.source,
      "--draft-mr",
      "--execute",
      "--confirm-plan-sha256",
      options.confirm ?? plan!.sha256,
      "--delivery-root",
      fixture.deliveries,
      "--receipt-root",
      receiptRoot,
      "--state-dir",
      fixture.state,
      "--validation-command",
      VALIDATION,
      ...(options.targetBranch ? ["--target-branch", options.targetBranch] : []),
    ],
    {
      cwd: fixture.root,
      stateDirectory: fixture.state,
      log: (message) => logs.push(message),
      commands,
      ...(fixture.store && !options.withoutStore ? { receiptStore: fixture.store } : {}),
      isolateValidation: async () => ({ commandPrefix: [] }),
      publisher: {
        git: new DeterministicLocalGitPublisher(fixture.git, {
          PATH: process.env.PATH,
          HOME: fixture.home,
        }),
        gitlab: new LocalUserGitLabPublisherAdapter(new GlabRunner(fixture.gitlab), {}),
        ...(options.hooks ? { hooks: options.hooks } : {}),
      },
    },
    options.advance ? { advance: options.advance } : {},
  );
  return { ...(plan ? { plan } : {}), logs };
}

async function exists(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}

export interface Published {
  run: FixtureRun;
  plan: LocalUserPublicationPlan;
  receipt: ScmDeliveryRecord;
  head: string;
}

/** Publish `run` through the real path and return its terminal receipt. */
export async function publishRoot(
  fixture: AdvanceFixture,
  run: FixtureRun,
  options: PublishOptions = {},
): Promise<Published> {
  const { plan } = await publish(fixture, run, options);
  const receipt = await receiptStore(fixture).load(scmDeliveryIdempotencyKey(plan!));
  if (!receipt || receipt.state !== "opened") throw new Error("root publication did not open");
  return { run, plan: plan!, receipt, head: receipt.evidence.push!.remoteRevision };
}

/** The typed advance a host would build for `child` from `parent`'s receipt. */
export function advanceFrom(
  parent: Published,
  observedHead: string,
  ordinal = 1,
): LocalUserPublicationAdvanceV1 {
  return {
    kind: "docsfab-local-user-publication-advance",
    parent: {
      runId: parent.plan.run.id,
      recordSha256: parent.plan.run.recordSha256,
      deliveryReceiptSha256: parent.receipt.sha256,
      idempotencyKey: parent.receipt.idempotencyKey,
      planSha256: parent.plan.sha256,
    },
    mergeRequest: { projectId: PROJECT_ID, iid: parent.receipt.evidence.mergeRequest!.iid },
    sourceBranch: parent.plan.proposedSourceBranch,
    lastRecordedHead: parent.head,
    observedHead,
    ordinal,
  };
}

/** Every file under the receipt root with its digest, to prove a refusal wrote nothing. */
export async function receiptSnapshot(fixture: AdvanceFixture): Promise<string[]> {
  const entries: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const path = join(directory, name);
      try {
        const bytes = await readFile(path);
        entries.push(`${path}:${createHash("sha256").update(bytes).digest("hex")}`);
      } catch {
        await walk(path);
      }
    }
  };
  if (fixture.store) {
    return [...fixture.store.records.entries(), ...fixture.store.plans.entries()]
      .map(([key, bytes]) => `${key}:${createHash("sha256").update(bytes).digest("hex")}`)
      .sort();
  }
  await walk(fixture.receipts);
  return entries;
}

function ok(stdout: string): { exitCode: number; stdout: string } {
  return { exitCode: 0, stdout };
}

function failure(): { exitCode: number; stdout: string } {
  return { exitCode: 1, stdout: "" };
}

function json(value: unknown): { exitCode: number; stdout: string } {
  return ok(`${JSON.stringify(value)}\n`);
}
