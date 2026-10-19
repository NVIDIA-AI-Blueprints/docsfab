// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";

import { runtimeEgressRootSet } from "../config/egress-roots.js";
import { limit } from "../config/limits.js";
import { egressText } from "../security/egress.js";
import { processPublicRoots } from "../security/host-roots.js";
import {
  containsConfiguredCredentialText,
  canonicalLocalUserGitIdentity,
  localUserGitIdentitySha256,
  localUserPublicationAdvance,
  type LocalUserPublicationPlan,
} from "./contracts.js";
import { gitEnvironment } from "./git-environment.js";
import {
  GIT_CONFIGURATION_LIST_ARGS,
  GIT_CONFIGURATION_LISTING_LIMIT,
  HOST_GIT_CONFIG_FLAGS,
  assessGitConfigurationList,
  resolveGitConfigurationPaths,
} from "./git-config-policy.js";
import { parseGitLabRemote } from "./preflight.js";
import type { DeliveryWorktreeReadyAttestation } from "./worktree.js";

export { gitEnvironment };

const MAX_OUTPUT = 1_000_000;
/** A push, including a leased branch delete; neither transfers more than the publication. */
const PUSH_TIMEOUT_LIMIT = "delivery.gitPushTimeoutMs";
const COMMIT_TIMEOUT_LIMIT = "delivery.gitCommitTimeoutMs";
const LS_REMOTE_TIMEOUT_LIMIT = "delivery.gitLsRemoteTimeoutMs";
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SAFE_BRANCH =
  /^(?![-.])(?!.*(?:\.\.|@\{|\\|[\x00-\x20~^:?*\[]))(?!.*\/$)(?!.*\.lock(?:\/|$))[A-Za-z0-9._/-]{1,200}$/u;
const SAFE_CONFIG = HOST_GIT_CONFIG_FLAGS;

export type GitPublisherErrorCode =
  | "missing-identity"
  | "identity-drift"
  | "unsafe-configuration"
  /** A configuration entry the publisher refuses by key and origin (#2363). */
  | "refused-configuration"
  | "local-branch-conflict"
  | "remote-branch-conflict"
  | "commit-failed"
  | "commit-drift"
  | "push-failed";

export class GitPublisherError extends Error {
  public constructor(public readonly code: GitPublisherErrorCode) {
    super(`Git publication failed (${code}).`);
    this.name = "GitPublisherError";
  }
}

export interface GitPublisherCommandResult {
  exitCode: number;
  stdout: Buffer;
}

export interface GitPublisherCommandRunner {
  run(
    command: "git",
    args: readonly string[],
    cwd: string,
    options: {
      env: NodeJS.ProcessEnv;
      stdin?: Uint8Array;
      timeoutMs: number;
      maxOutputBytes: number;
    },
  ): Promise<GitPublisherCommandResult>;
}

export interface LocalGitPublisher {
  assertConfiguredIdentity(plan: LocalUserPublicationPlan, cwd: string): Promise<void>;
  localBranchRevision(plan: LocalUserPublicationPlan, cwd: string): Promise<string | undefined>;
  remoteBranchRevision(plan: LocalUserPublicationPlan, cwd: string): Promise<string | undefined>;
  ensureCommit(input: {
    plan: LocalUserPublicationPlan;
    ready: DeliveryWorktreeReadyAttestation;
    commitMessage: string;
    cwd: string;
    assertAuthorized?: () => void;
  }): Promise<string>;
  ensurePush(input: {
    plan: LocalUserPublicationPlan;
    commitRevision: string;
    cwd: string;
    assertAuthorized?: () => void;
  }): Promise<string>;
  assertCommit(input: {
    plan: LocalUserPublicationPlan;
    ready: Pick<DeliveryWorktreeReadyAttestation, "tree">;
    commitMessage: string;
    commitRevision: string;
    cwd: string;
  }): Promise<void>;
}

export interface LocalGitRemoteTarget {
  project: {
    host: string;
    path: string;
  };
  remote: {
    name: string;
    transport: "ssh" | "https";
  };
}

export class ExecFileGitPublisherCommandRunner implements GitPublisherCommandRunner {
  public run(
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
    return new Promise((resolveResult) => {
      const child = spawn(command, [...args], {
        cwd,
        env: options.env,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      let inputDone = false;
      let closed = false;
      let exitCode = 1;
      const finish = (): void => {
        if (settled || !inputDone || !closed) return;
        settled = true;
        clearTimeout(timer);
        resolveResult({ exitCode, stdout: Buffer.concat(chunks) });
      };
      const terminate = (): void => {
        try {
          if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const timer = setTimeout(() => {
        terminate();
        closed = true;
        inputDone = true;
        finish();
      }, options.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > options.maxOutputBytes) terminate();
        else chunks.push(Buffer.from(chunk));
      });
      child.once("error", () => {
        closed = true;
        inputDone = true;
        finish();
      });
      child.once("close", (code) => {
        exitCode = code === 0 && size <= options.maxOutputBytes ? 0 : 1;
        closed = true;
        finish();
      });
      child.stdin.once("error", () => {
        inputDone = true;
        terminate();
        finish();
      });
      child.stdin.end(options.stdin ? Buffer.from(options.stdin) : undefined, () => {
        inputDone = true;
        finish();
      });
    });
  }
}

export interface DeterministicLocalGitPublisherOptions {
  /**
   * Directories whose files the repository supplies, beyond the directory each
   * Git command runs in: the checkout a delivery worktree was made from. A `HOME`
   * inside one is not the operator's own (`git-config-policy.ts`).
   */
  readonly repositoryRoots?: readonly string[];
}

/** Host-only Git adapter. It exposes no generic command surface. */
export class DeterministicLocalGitPublisher implements LocalGitPublisher {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly publicRoots: ReadonlySet<string>;
  private readonly repositoryRoots: readonly string[];

  /**
   * `environment` defaults to this process's, whose public roots are the
   * startup set. Throws `PublicRootsOperatorError` when an explicit
   * environment's `DOCSFAB_PUBLIC_ROOTS` is invalid.
   */
  public constructor(
    private readonly commands: GitPublisherCommandRunner = new ExecFileGitPublisherCommandRunner(),
    environment?: NodeJS.ProcessEnv,
    options: DeterministicLocalGitPublisherOptions = {},
  ) {
    this.environment = environment ?? process.env;
    this.publicRoots = processPublicRoots(environment);
    this.repositoryRoots = options.repositoryRoots ?? [];
  }

  public async assertConfiguredIdentity(
    plan: LocalUserPublicationPlan,
    cwd: string,
  ): Promise<void> {
    await this.assertGitVersion(cwd);
    await this.assertSafeConfiguration(plan, cwd);
    await this.assertRemote(plan, cwd);
    const identity = await this.resolvedIdentity(plan, cwd);
    if (
      localUserGitIdentitySha256(identity.name, identity.email) !== plan.identity.gitIdentitySha256
    ) {
      fail("identity-drift");
    }
  }

  public async localBranchRevision(
    plan: LocalUserPublicationPlan,
    cwd: string,
  ): Promise<string | undefined> {
    const result = await this.git(
      ["rev-parse", "--verify", `refs/heads/${plan.proposedSourceBranch}^{commit}`],
      cwd,
    );
    if (result.exitCode !== 0) return undefined;
    return revision(result.stdout, "local-branch-conflict");
  }

  public async remoteBranchRevision(
    plan: LocalUserPublicationPlan,
    cwd: string,
  ): Promise<string | undefined> {
    return this.remoteBranchRevisionForTarget(plan, plan.proposedSourceBranch, cwd);
  }

  /** Observe one exact branch through the same fail-closed adapter used for publication. */
  public async remoteBranchRevisionForTarget(
    target: LocalGitRemoteTarget,
    branch: string,
    cwd: string,
  ): Promise<string | undefined> {
    if (!SAFE_BRANCH.test(branch)) fail("unsafe-configuration");
    await this.assertGitVersion(cwd);
    await this.assertSafeConfiguration(target, cwd);
    const remoteUrl = await this.assertRemote(target, cwd);
    const result = await this.git(
      ["ls-remote", "--heads", "--refs", remoteUrl, `refs/heads/${branch}`],
      cwd,
      undefined,
      limit(LS_REMOTE_TIMEOUT_LIMIT).value,
    );
    if (result.exitCode !== 0) fail("push-failed");
    if (result.stdout.byteLength === 0) return undefined;
    const rows = result.stdout.toString("utf8").trimEnd().split("\n");
    if (rows.length !== 1) fail("remote-branch-conflict");
    const [sha, ref, ...extra] = rows[0]!.split("\t");
    if (extra.length > 0 || ref !== `refs/heads/${branch}` || !sha || !REVISION.test(sha))
      fail("remote-branch-conflict");
    return sha;
  }

  /** Delete only an exact observed branch revision, then prove it is absent. */
  public async deleteRemoteBranch(input: {
    target: LocalGitRemoteTarget;
    branch: string;
    expectedRevision: string;
    cwd: string;
  }): Promise<void> {
    if (!SAFE_BRANCH.test(input.branch) || !REVISION.test(input.expectedRevision)) {
      fail("unsafe-configuration");
    }
    const observed = await this.remoteBranchRevisionForTarget(
      input.target,
      input.branch,
      input.cwd,
    );
    if (observed !== input.expectedRevision) fail("remote-branch-conflict");
    const remoteUrl = await this.assertRemote(input.target, input.cwd);
    const ref = `refs/heads/${input.branch}`;
    const deleted = await this.git(
      [
        "push",
        "--porcelain",
        "--no-verify",
        "--no-signed",
        "--no-recurse-submodules",
        "--no-follow-tags",
        "--no-tags",
        "--no-prune",
        "--no-mirror",
        "--no-all",
        "--no-set-upstream",
        "--no-push-option",
        `--force-with-lease=${ref}:${input.expectedRevision}`,
        remoteUrl,
        `:${ref}`,
      ],
      input.cwd,
      undefined,
      limit(PUSH_TIMEOUT_LIMIT).value,
    );
    if (deleted.exitCode !== 0) fail("push-failed");
    if (await this.remoteBranchRevisionForTarget(input.target, input.branch, input.cwd)) {
      fail("remote-branch-conflict");
    }
  }

  public async ensureCommit(input: {
    plan: LocalUserPublicationPlan;
    ready: DeliveryWorktreeReadyAttestation;
    commitMessage: string;
    cwd: string;
    assertAuthorized?: () => void;
  }): Promise<string> {
    await this.assertConfiguredIdentity(input.plan, input.cwd);
    if (unsafe(input.commitMessage)) fail("commit-failed");
    input = {
      ...input,
      commitMessage: this.egress(input.commitMessage, input.cwd, "commit-failed"),
    };
    const existing = await this.localBranchRevision(input.plan, input.cwd);
    const advance = localUserPublicationAdvance(input.plan);
    // An advance may find the branch absent, at the head DocsFab last pushed,
    // or at the observed head; it moves the ref from that exact value to the
    // new commit. Any other value is an earlier attempt's commit or a conflict.
    const replaceable = advance
      ? existing === undefined ||
        existing === advance.lastRecordedHead ||
        existing === advance.observedHead
      : existing === input.plan.baseRevision;
    if (existing !== undefined && !replaceable) {
      await this.assertCommit({ ...input, commitRevision: existing });
      return existing;
    }
    if (!replaceable) fail("local-branch-conflict");

    const identity = await this.resolvedIdentity(input.plan, input.cwd);
    const baseTimeText = line(
      await this.require(["show", "-s", "--format=%ct", input.plan.baseRevision], input.cwd),
      32,
      "commit-failed",
    );
    const baseTime = Number(baseTimeText);
    if (!Number.isSafeInteger(baseTime) || baseTime < 0) fail("commit-failed");
    const commitEnvironment = {
      ...gitEnvironment(this.environment),
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
      GIT_AUTHOR_DATE: `@${baseTime + 1} +0000`,
      GIT_COMMITTER_DATE: `@${baseTime + 1} +0000`,
    };
    input.assertAuthorized?.();
    const created = await this.require(
      ["commit-tree", input.ready.tree, "-p", input.plan.baseRevision, "-F", "-"],
      input.cwd,
      Buffer.from(input.commitMessage, "utf8"),
      limit(COMMIT_TIMEOUT_LIMIT).value,
      commitEnvironment,
    );
    const commitRevision = revision(created, "commit-failed");
    await this.assertCommit({ ...input, commitRevision });
    input.assertAuthorized?.();
    const updated = await this.git(
      [
        "update-ref",
        `refs/heads/${input.plan.proposedSourceBranch}`,
        commitRevision,
        // The all-zero old value requires the ref to be absent.
        existing ?? "0".repeat(commitRevision.length),
      ],
      input.cwd,
    );
    if (updated.exitCode !== 0) {
      const winner = await this.localBranchRevision(input.plan, input.cwd);
      if (winner !== commitRevision) fail("local-branch-conflict");
    }
    await this.assertCommit({ ...input, commitRevision });
    return commitRevision;
  }

  /** The commit message as published: this checkout and host's roots replaced. */
  private egress(message: string, cwd: string, code: GitPublisherErrorCode): string {
    const result = egressText(
      message,
      runtimeEgressRootSet({
        environment: this.environment,
        workspace: cwd,
        publicRoots: this.publicRoots,
      }),
    );
    if (!result.ok) fail(code);
    return result.text;
  }

  public async ensurePush(input: {
    plan: LocalUserPublicationPlan;
    commitRevision: string;
    cwd: string;
    assertAuthorized?: () => void;
  }): Promise<string> {
    if (!REVISION.test(input.commitRevision)) fail("push-failed");
    await this.assertConfiguredIdentity(input.plan, input.cwd);
    const local = await this.localBranchRevision(input.plan, input.cwd);
    if (local !== input.commitRevision) fail("local-branch-conflict");
    const remote = await this.remoteBranchRevision(input.plan, input.cwd);
    if (remote === input.commitRevision) return remote;
    const advance = localUserPublicationAdvance(input.plan);
    // A first publication creates the branch; an advance moves it only from
    // the observed head, and the lease below re-checks that on the server.
    if (advance ? remote !== advance.observedHead : remote !== undefined) {
      fail("remote-branch-conflict");
    }
    const ref = `refs/heads/${input.plan.proposedSourceBranch}`;
    const lease = `--force-with-lease=${ref}:${advance ? advance.observedHead : ""}`;
    const remoteUrl = await this.assertRemote(input.plan, input.cwd);
    input.assertAuthorized?.();
    const pushed = await this.git(
      [
        "push",
        "--porcelain",
        "--no-verify",
        "--no-signed",
        "--no-recurse-submodules",
        "--no-follow-tags",
        "--no-tags",
        "--no-prune",
        "--no-mirror",
        "--no-all",
        "--no-delete",
        "--no-set-upstream",
        "--no-push-option",
        lease,
        remoteUrl,
        `${input.commitRevision}:${ref}`,
      ],
      input.cwd,
      undefined,
      limit(PUSH_TIMEOUT_LIMIT).value,
    );
    if (pushed.exitCode !== 0) {
      const raced = await this.remoteBranchRevision(input.plan, input.cwd);
      if (raced === input.commitRevision) return raced;
      if (raced !== undefined) fail("remote-branch-conflict");
      fail("push-failed");
    }
    const observed = await this.remoteBranchRevision(input.plan, input.cwd);
    if (observed !== input.commitRevision) fail("push-failed");
    return observed;
  }

  public async assertCommit(input: {
    plan: LocalUserPublicationPlan;
    ready: Pick<DeliveryWorktreeReadyAttestation, "tree">;
    commitMessage: string;
    commitRevision: string;
    cwd: string;
  }): Promise<void> {
    if (!REVISION.test(input.commitRevision)) fail("commit-drift");
    const commitMessage = this.egress(input.commitMessage, input.cwd, "commit-drift");
    const raw = await this.require(["cat-file", "commit", input.commitRevision], input.cwd);
    const text = raw.toString("utf8");
    const separator = text.indexOf("\n\n");
    if (separator < 0) fail("commit-drift");
    const headers = text.slice(0, separator).split("\n");
    if (
      headers.length !== 4 ||
      headers[0] !== `tree ${input.ready.tree}` ||
      headers[1] !== `parent ${input.plan.baseRevision}` ||
      text.slice(separator + 2) !== commitMessage
    )
      fail("commit-drift");
    const baseTimeText = line(
      await this.require(["show", "-s", "--format=%ct", input.plan.baseRevision], input.cwd),
      32,
      "commit-drift",
    );
    const baseTime = Number(baseTimeText);
    if (!Number.isSafeInteger(baseTime) || baseTime < 0) fail("commit-drift");
    const author = commitIdentityHeader(headers[2], "author");
    const committer = commitIdentityHeader(headers[3], "committer");
    const expectedTime = String(baseTime + 1);
    if (
      author.name !== committer.name ||
      author.email !== committer.email ||
      author.timestamp !== expectedTime ||
      committer.timestamp !== expectedTime ||
      author.timezone !== "+0000" ||
      committer.timezone !== "+0000" ||
      localUserGitIdentitySha256(author.name, author.email) !==
        input.plan.identity.gitIdentitySha256
    )
      fail("commit-drift");
    const tree = revision(
      await this.require(["rev-parse", "--verify", `${input.commitRevision}^{tree}`], input.cwd),
      "commit-drift",
    );
    if (tree !== input.ready.tree) fail("commit-drift");
    const indexTree = revision(await this.require(["write-tree"], input.cwd), "commit-drift");
    if (indexTree !== input.ready.tree) fail("commit-drift");
    // No diff-files check: under GIT_OPTIONAL_LOCKS=0 a freshly materialized
    // index has a stale stat cache and reports false drift. This verifies the
    // commit and index trees; the caller verifies the filesystem before ready.
  }

  /**
   * Refuse the configuration the shared policy refuses (`git-config-policy.ts`),
   * the same function delivery preflight applies before the model run, over the
   * same listing under the same output bound. A listing that fails, overruns that
   * bound, or does not parse is `unsafe-configuration`, as it is in preflight; it
   * is not a failed commit.
   */
  private async assertSafeConfiguration(plan: LocalGitRemoteTarget, cwd: string): Promise<void> {
    // No stdin, the default timeout and environment, and the listing's own output bound.
    const result = await this.git(
      [...GIT_CONFIGURATION_LIST_ARGS],
      cwd,
      undefined,
      undefined,
      undefined,
      limit(GIT_CONFIGURATION_LISTING_LIMIT).value,
    );
    if (result.exitCode !== 0) fail("unsafe-configuration");
    const assessment = assessGitConfigurationList(
      result.stdout,
      await resolveGitConfigurationPaths({
        home: this.environment.HOME,
        host: plan.project.host,
        repositoryRoots: [cwd, ...this.repositoryRoots],
      }),
    );
    if (assessment.status === "unreadable") fail("unsafe-configuration");
    if (assessment.status === "refused") fail("refused-configuration");
  }

  private async assertGitVersion(cwd: string): Promise<void> {
    // Some Git installs read the global configuration even for `git version`, so a malformed
    // file stops it. That is a checkout that cannot be verified, not a failed commit.
    const printed = await this.git(["version"], cwd);
    if (printed.exitCode !== 0) fail("unsafe-configuration");
    const value = line(printed.stdout, 128, "unsafe-configuration");
    const match = /^git version (\d+)\.(\d+)\.(\d+)(?:\s|$)/u.exec(value);
    if (!match) fail("unsafe-configuration");
    const version = match.slice(1).map(Number);
    if (
      version[0]! < 2 ||
      (version[0] === 2 && version[1]! < 9) ||
      (version[0] === 2 && version[1] === 9 && version[2]! < 5)
    ) {
      fail("unsafe-configuration");
    }
  }

  private async assertRemote(plan: LocalGitRemoteTarget, cwd: string): Promise<string> {
    const read = async (push: boolean): Promise<string> => {
      const args = push
        ? ["remote", "get-url", "--push", "--all", plan.remote.name]
        : ["remote", "get-url", "--all", plan.remote.name];
      const output = (await this.require(args, cwd)).toString("utf8").trimEnd().split("\n");
      if (output.length !== 1 || !output[0]) fail("unsafe-configuration");
      const parsed = parseGitLabRemote(output[0]);
      if (
        parsed.host !== plan.project.host ||
        parsed.projectPath !== plan.project.path ||
        (push && parsed.transport !== plan.remote.transport)
      )
        fail("unsafe-configuration");
      return output[0];
    };
    await read(false);
    const pushUrl = await read(true);
    return pushUrl;
  }

  private async resolvedIdentity(
    plan: LocalUserPublicationPlan,
    cwd: string,
  ): Promise<{ name: string; email: string }> {
    const nameResult = await this.git(["config", "--get", "user.name"], cwd);
    const emailResult = await this.git(["config", "--get", "user.email"], cwd);
    const gitName = nameResult.exitCode === 0 ? nameResult.stdout.toString("utf8") : "";
    const gitEmail = emailResult.exitCode === 0 ? emailResult.stdout.toString("utf8") : "";
    if (gitName.trim() && gitEmail.trim()) {
      const identity = canonicalLocalUserGitIdentity(gitName, gitEmail);
      if (
        localUserGitIdentitySha256(identity.name, identity.email) !==
        plan.identity.gitIdentitySha256
      ) {
        fail("identity-drift");
      }
      return identity;
    }
    const envName = this.environment.GIT_AUTHOR_NAME ?? this.environment.GIT_COMMITTER_NAME;
    const envEmail = this.environment.GIT_AUTHOR_EMAIL ?? this.environment.GIT_COMMITTER_EMAIL;
    if (envName && envEmail) {
      const identity = canonicalLocalUserGitIdentity(envName, envEmail);
      if (
        localUserGitIdentitySha256(identity.name, identity.email) !==
        plan.identity.gitIdentitySha256
      ) {
        fail("identity-drift");
      }
      return identity;
    }
    fail("missing-identity");
  }

  private async require(
    args: readonly string[],
    cwd: string,
    stdin?: Uint8Array,
    timeoutMs = 30_000,
    environment?: NodeJS.ProcessEnv,
  ): Promise<Buffer> {
    const result = await this.git(args, cwd, stdin, timeoutMs, environment);
    if (result.exitCode !== 0) fail("commit-failed");
    return result.stdout;
  }

  private git(
    args: readonly string[],
    cwd: string,
    stdin?: Uint8Array,
    timeoutMs = 30_000,
    environment: NodeJS.ProcessEnv = gitEnvironment(this.environment),
    maxOutputBytes = MAX_OUTPUT,
  ): Promise<GitPublisherCommandResult> {
    if (args.some((argument) => typeof argument !== "string" || argument.includes("\0"))) {
      fail("unsafe-configuration");
    }
    return this.commands.run("git", [...SAFE_CONFIG, ...args], cwd, {
      env: environment,
      ...(stdin ? { stdin } : {}),
      timeoutMs,
      maxOutputBytes,
    });
  }
}

function revision(bytes: Buffer, code: GitPublisherErrorCode): string {
  const value = bytes.toString("utf8").trim();
  if (!REVISION.test(value)) fail(code);
  return value;
}

function line(bytes: Buffer, maximum: number, code: GitPublisherErrorCode): string {
  const value = bytes.toString("utf8").trimEnd();
  if (
    value.length === 0 ||
    value.length > maximum ||
    value.includes("\0") ||
    value.includes("\r") ||
    value.includes("\n") ||
    unsafe(value)
  )
    fail(code);
  return value;
}

/**
 * Whether git input or output carries DocsFab's own configured credential,
 * which refuses (#1807). Text that only looks like a credential continues and
 * is recorded as a `credential-like-content` finding at `git`.
 */
function unsafe(value: string): boolean {
  return containsConfiguredCredentialText(value, "git");
}

function commitIdentityHeader(
  value: string | undefined,
  kind: "author" | "committer",
): { name: string; email: string; timestamp: string; timezone: string } {
  if (!value) fail("commit-drift");
  const match = new RegExp(
    `^${kind} ([^<>\\r\\n]+) <([^<>\\r\\n]+)> ([0-9]+) ([+-][0-9]{4})$`,
    "u",
  ).exec(value);
  if (!match || unsafe(match[1]!) || unsafe(match[2]!)) fail("commit-drift");
  return {
    name: match[1]!,
    email: match[2]!,
    timestamp: match[3]!,
    timezone: match[4]!,
  };
}

function fail(code: GitPublisherErrorCode): never {
  throw new GitPublisherError(code);
}
