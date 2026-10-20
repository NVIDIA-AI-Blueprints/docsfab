// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";

import {
  LocalUserPublicationPreflightError,
  type LocalUserPublicationFailureCode,
  type LocalUserPublicationPreflightDetails,
} from "./contracts.js";
import { gitEnvironment } from "./git-publisher.js";
import {
  observeLocalUserGitLabTarget,
  type LocalUserGitLabTargetObservation,
  type LocalUserGitLabTargetObserveInput,
  type ReadOnlyCommandRunner,
} from "./preflight.js";

const PINNED_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SAFE_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const FETCH_TIMEOUT_MS = 120_000;
const GIT_TIMEOUT_MS = 30_000;
const SAFE_FETCH_CONFIG = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "commit.gpgSign=false",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.ssh.allow=always",
  "-c",
  "protocol.https.allow=always",
] as const;

export type LocalUserPublicationFreshnessPlan =
  | { readonly action: "noop" }
  | { readonly action: "ensure-object"; readonly revision: string }
  | { readonly action: "fast-forward"; readonly revision: string }
  | {
      readonly action: "resolve-named-ref";
      readonly ref: string;
      readonly gitlabRevision: string;
    }
  | { readonly action: "fail"; readonly code: "stale-revision" };

/**
 * The selected run-base policy. The caller derives this from the CLI request;
 * freshness only applies it after observing the live GitLab target.
 */
export type LocalUserPublicationRevisionPolicy =
  | "checkout-head"
  | "target-branch-head"
  | "explicit-ref"
  | "explicit-sha";

export interface LocalUserPublicationFreshnessInput {
  readonly repositoryPath: string;
  readonly revision: string;
  readonly revisionPolicy?: LocalUserPublicationRevisionPolicy;
  readonly remoteName?: string;
  readonly targetBranch?: string;
  readonly status?: (message: string) => void;
}

export interface LocalUserPublicationFreshnessDependencies {
  readonly observe?: (
    input: LocalUserGitLabTargetObserveInput,
    commands?: ReadOnlyCommandRunner,
    environment?: NodeJS.ProcessEnv,
  ) => Promise<LocalUserGitLabTargetObservation>;
  readonly commands?: ReadOnlyCommandRunner;
  /** The environment the publisher's Git will run with; the process environment by default. */
  readonly environment?: NodeJS.ProcessEnv;
  readonly hasCommit?: (repositoryPath: string, revision: string) => Promise<boolean>;
  readonly isAncestor?: (
    repositoryPath: string,
    ancestor: string,
    descendant: string,
  ) => Promise<boolean>;
  readonly fetchCommit?: (input: {
    repositoryPath: string;
    remoteName: string;
    revision: string;
  }) => Promise<void>;
  readonly fastForward?: (input: { repositoryPath: string; revision: string }) => Promise<void>;
  readonly resolveRevision?: (repositoryPath: string, revision: string) => Promise<string>;
  readonly trackedSourceDirty?: (repositoryPath: string) => Promise<boolean>;
}

/**
 * Operator-owned fetch environment: SSH agent is forwarded, `file` is not an
 * allowed protocol. Tests that clone from a local bare remote inject `fetchCommit`.
 */
export function fetchGitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...gitEnvironment(source),
    GIT_ALLOW_PROTOCOL: "ssh:https",
  };
}

export function pinnedPublicationRevision(revision: string): string | undefined {
  const normalized = revision.toLowerCase();
  return PINNED_REVISION.test(normalized) ? normalized : undefined;
}

/**
 * Decide how the observed GitLab target supplies the selected run base.
 * `target-branch-head` only resolves and fetches the target object: it never
 * moves the operator checkout. The legacy checkout-head path may still
 * fast-forward a clean target-branch checkout.
 */
export function planLocalUserPublicationFreshness(input: {
  readonly requestedRevision: string;
  readonly headRevision: string;
  readonly headBranch: string;
  readonly targetBranch: string;
  readonly gitlabRevision: string;
  readonly revisionPolicy?: LocalUserPublicationRevisionPolicy;
}): LocalUserPublicationFreshnessPlan {
  const gitlab = input.gitlabRevision.toLowerCase();
  const head = input.headRevision.toLowerCase();
  if (input.revisionPolicy === "target-branch-head") {
    return head === gitlab ? { action: "noop" } : { action: "ensure-object", revision: gitlab };
  }
  const pinned = pinnedPublicationRevision(input.requestedRevision);
  if (pinned) {
    if (pinned !== gitlab) return { action: "fail", code: "stale-revision" };
    return head === gitlab ? { action: "noop" } : { action: "ensure-object", revision: gitlab };
  }
  const liveCheckout =
    input.requestedRevision === "HEAD" || input.requestedRevision === input.headBranch;
  if (!liveCheckout) {
    return {
      action: "resolve-named-ref",
      ref: input.requestedRevision,
      gitlabRevision: gitlab,
    };
  }
  if (head === gitlab) return { action: "noop" };
  if (input.headBranch !== input.targetBranch) return { action: "fail", code: "stale-revision" };
  return { action: "fast-forward", revision: gitlab };
}

export interface LocalUserPublicationGitLabTargetSnapshot {
  readonly branch: string;
  readonly revision: string;
}

/**
 * DocsFab-owned GitLab freshness prelude for `--draft-mr`. The
 * `target-branch-head` policy ensures the observed target commit exists locally
 * without moving the operator checkout. The legacy path fast-forwards only a
 * clean checkout of the target branch that is a strict ancestor of GitLab HEAD.
 * A pinned full SHA is never fast-forwarded.
 */
export async function ensureLocalUserPublicationFreshness(
  input: LocalUserPublicationFreshnessInput,
  deps: LocalUserPublicationFreshnessDependencies = {},
): Promise<LocalUserPublicationGitLabTargetSnapshot> {
  const observe = deps.observe ?? observeLocalUserGitLabTarget;
  const observation = await observe(
    {
      repositoryPath: input.repositoryPath,
      ...(input.remoteName ? { remoteName: input.remoteName } : {}),
      ...(input.targetBranch ? { targetBranch: input.targetBranch } : {}),
    },
    deps.commands,
    deps.environment,
  );
  const plan = planLocalUserPublicationFreshness({
    requestedRevision: input.revision,
    headRevision: observation.headRevision,
    headBranch: observation.headBranch,
    targetBranch: observation.target.name,
    gitlabRevision: observation.target.revision,
    ...(input.revisionPolicy ? { revisionPolicy: input.revisionPolicy } : {}),
  });
  await applyLocalUserPublicationFreshness(plan, observation, input, deps);
  return {
    branch: observation.target.name,
    revision: observation.target.revision,
  };
}

async function applyLocalUserPublicationFreshness(
  plan: LocalUserPublicationFreshnessPlan,
  observation: LocalUserGitLabTargetObservation,
  input: LocalUserPublicationFreshnessInput,
  deps: LocalUserPublicationFreshnessDependencies,
): Promise<void> {
  if (plan.action === "noop") return;
  if (plan.action === "fail") fail(plan.code);
  const repositoryPath = observation.repositoryPath;
  const hasCommit = deps.hasCommit ?? defaultHasCommit;
  const fetchCommit = deps.fetchCommit ?? defaultFetchCommit;
  const isAncestor = deps.isAncestor ?? defaultIsAncestor;
  const fastForward = deps.fastForward ?? defaultFastForward;
  const resolveRevision = deps.resolveRevision ?? defaultResolveRevision;

  if (plan.action === "resolve-named-ref") {
    const resolved = (await resolveRevision(repositoryPath, plan.ref)).toLowerCase();
    if (resolved !== plan.gitlabRevision) fail("stale-revision");
    await ensureCommitObject(
      repositoryPath,
      observation.remoteName,
      plan.gitlabRevision,
      hasCommit,
      fetchCommit,
    );
    return;
  }

  await ensureCommitObject(
    repositoryPath,
    observation.remoteName,
    plan.revision,
    hasCommit,
    fetchCommit,
  );

  if (plan.action === "ensure-object") return;

  const trackedSourceDirty = deps.trackedSourceDirty ?? defaultTrackedSourceDirty;
  if (await trackedSourceDirty(repositoryPath)) {
    input.status?.(
      "leaving tracked local changes in place; writing from GitLab's target-branch revision",
    );
    return;
  }

  if (!(await isAncestor(repositoryPath, observation.headRevision, plan.revision))) {
    fail("stale-revision");
  }
  input.status?.("fast-forwarding the checkout to GitLab's target-branch revision");
  await fastForward({ repositoryPath, revision: plan.revision });
}

async function ensureCommitObject(
  repositoryPath: string,
  remoteName: string,
  revision: string,
  hasCommit: (repositoryPath: string, revision: string) => Promise<boolean>,
  fetchCommit: (input: {
    repositoryPath: string;
    remoteName: string;
    revision: string;
  }) => Promise<void>,
): Promise<void> {
  if (await hasCommit(repositoryPath, revision)) return;
  try {
    await fetchCommit({ repositoryPath, remoteName, revision });
  } catch {
    fail("stale-revision");
  }
  if (!(await hasCommit(repositoryPath, revision))) fail("stale-revision");
}

async function defaultTrackedSourceDirty(repositoryPath: string): Promise<boolean> {
  const captured = await spawnGitCapture(
    ["status", "--porcelain=v2", "-z", "--untracked-files=no"],
    repositoryPath,
    GIT_TIMEOUT_MS,
  );
  if (captured.exitCode !== 0) fail("tracked-source-dirty");
  return captured.stdout.length > 0;
}

async function defaultHasCommit(repositoryPath: string, revision: string): Promise<boolean> {
  assertSafeRevision(revision);
  const result = await spawnGit(
    ["cat-file", "-e", `${revision}^{commit}`],
    repositoryPath,
    GIT_TIMEOUT_MS,
  );
  return result === 0;
}

async function defaultIsAncestor(
  repositoryPath: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  assertSafeRevision(ancestor);
  assertSafeRevision(descendant);
  const result = await spawnGit(
    ["merge-base", "--is-ancestor", ancestor, descendant],
    repositoryPath,
    GIT_TIMEOUT_MS,
  );
  return result === 0;
}

async function defaultFetchCommit(input: {
  repositoryPath: string;
  remoteName: string;
  revision: string;
}): Promise<void> {
  if (!SAFE_REMOTE.test(input.remoteName)) fail("invalid-input");
  assertSafeRevision(input.revision);
  const result = await spawnGit(
    ["fetch", "--no-tags", "--recurse-submodules=no", "--", input.remoteName, input.revision],
    input.repositoryPath,
    FETCH_TIMEOUT_MS,
  );
  if (result !== 0) fail("stale-revision");
}

async function defaultFastForward(input: {
  repositoryPath: string;
  revision: string;
}): Promise<void> {
  assertSafeRevision(input.revision);
  const result = await spawnGit(
    ["merge", "--ff-only", "--no-edit", "--", input.revision],
    input.repositoryPath,
    GIT_TIMEOUT_MS,
  );
  if (result !== 0) fail("stale-revision");
}

async function defaultResolveRevision(repositoryPath: string, revision: string): Promise<string> {
  if (revision.length === 0 || revision.includes("\0") || revision.startsWith("-")) {
    fail("invalid-input");
  }
  const sha = await spawnGitStdout(
    ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`],
    repositoryPath,
    GIT_TIMEOUT_MS,
  );
  const normalized = sha.trim().toLowerCase();
  if (!PINNED_REVISION.test(normalized)) fail("stale-revision");
  return normalized;
}

function assertSafeRevision(revision: string): void {
  if (!PINNED_REVISION.test(revision)) fail("invalid-input");
}

function spawnGit(args: readonly string[], cwd: string, timeoutMs: number): Promise<number> {
  return new Promise((resolveResult) => {
    const child = spawn("git", [...SAFE_FETCH_CONFIG, ...args], {
      cwd,
      env: fetchGitEnvironment(),
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      resolveResult(code);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(1);
    }, timeoutMs);
    child.once("error", () => finish(1));
    child.once("exit", (code) => {
      clearTimeout(timer);
      finish(code ?? 1);
    });
  });
}

function spawnGitCapture(
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolveResult) => {
    const child = spawn("git", [...SAFE_FETCH_CONFIG, ...args], {
      cwd,
      env: fetchGitEnvironment(),
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      resolveResult({
        exitCode: code,
        stdout: Buffer.concat(chunks).toString("utf8"),
      });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(1);
    }, timeoutMs);
    child.once("error", () => finish(1));
    child.once("exit", (code) => {
      clearTimeout(timer);
      finish(code ?? 1);
    });
  });
}

function spawnGitStdout(args: readonly string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const child = spawn("git", [...SAFE_FETCH_CONFIG, ...args], {
      cwd,
      env: fetchGitEnvironment(),
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolveResult(Buffer.concat(chunks).toString("utf8"));
        return;
      }
      reject(new LocalUserPublicationPreflightError("stale-revision"));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(1);
    }, timeoutMs);
    child.once("error", () => finish(1));
    child.once("exit", (code) => {
      clearTimeout(timer);
      finish(code ?? 1);
    });
  });
}

function fail(
  code: LocalUserPublicationFailureCode,
  details?: LocalUserPublicationPreflightDetails,
): never {
  throw new LocalUserPublicationPreflightError(code, details);
}
