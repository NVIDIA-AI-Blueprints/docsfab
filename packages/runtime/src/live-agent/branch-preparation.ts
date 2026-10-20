// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Task-branch preparation before live-agent writes.
 *
 * Creates or reuses a unique topic branch so documentation mutations never land
 * on `main`, the repository default branch, or detached HEAD. Success grants no
 * commit, push, merge-request, or merge action. A branch is not worktree
 * isolation.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { HostPreMutationError } from "../harness/confined-tools.js";
import { canonicalDigest } from "../content-ir/canonical.js";
import { ExecInitCommandRunner, git } from "../init/shared.js";
import { SAFE_BRANCH } from "../init/types.js";

export const TASK_BRANCH_PREFIX = "docs/live-agent/";

export const TASK_BRANCH_FAILURES = {
  repository:
    "DocsFab could not prepare a task branch because this path is not a usable Git checkout. No files were changed. Open a Git repository and retry.",
  collision:
    "DocsFab could not prepare a task branch because that branch name already exists. The existing branch was not overwritten, and no files were changed. Retry so a new unique name can be used, or switch to a unique topic branch first.",
  checkout:
    "DocsFab could not switch to a task branch without overwriting existing files. Staged, unstaged, and untracked files were preserved. Resolve the checkout conflict or stay on a unique topic branch, then retry. No content was written.",
  create:
    "DocsFab could not create a unique task branch before writing. The checkout remains on the default branch or detached HEAD, and no files were changed. Inspect git status, then retry.",
  mismatched:
    "DocsFab could not reuse the session task branch because it points at a different revision. The existing branch was not overwritten, and no files were changed. Stay on a unique topic branch at the intended revision, then retry.",
} as const;

export class TaskBranchPreparationError extends HostPreMutationError {
  constructor(message: string) {
    super(message);
    this.name = "TaskBranchPreparationError";
  }
}

export interface TaskBranchSession {
  branchName?: string;
  defaultBranch?: string;
  noticed?: boolean;
}

export type TaskBranchPreparation =
  | {
      readonly status: "succeeded";
      readonly branchName: string;
      readonly reused: boolean;
    }
  | {
      readonly status: "failed" | "mismatched";
      readonly message: string;
      readonly branchName?: string;
    };

export function createTaskBranchName(): string {
  return `${TASK_BRANCH_PREFIX}${randomBytes(16).toString("hex")}`;
}

export function taskBranchNotice(branchName: string, reused: boolean): string {
  const action = reused ? "Reusing" : "Prepared";
  return `${action} task branch ${branchName}. Later writes in this session reuse it. A task branch is not worktree isolation and does not grant commit, push, merge-request, or merge.`;
}

export function createLiveAgentMutationGuard(options: {
  repositoryPath: string;
  sessionDirectory?: string;
  createBranchName?: () => string;
  onNotice?: (message: string) => void;
}): {
  readonly session: TaskBranchSession;
  prepare(): Promise<TaskBranchPreparation>;
  assertPrepared(): Promise<TaskBranchPreparation>;
} {
  const session: TaskBranchSession = {};
  let loaded = false;
  const prepare = async (): Promise<TaskBranchPreparation> => {
    if (!loaded) {
      loaded = true;
      await restoreSession(options.repositoryPath, options.sessionDirectory, session);
    }
    const result = await prepareTaskBranch({
      repositoryPath: options.repositoryPath,
      session,
      createBranchName: options.createBranchName,
    });
    if (result.status === "succeeded") {
      await persistSession(options.repositoryPath, options.sessionDirectory, session);
      if (!session.noticed) {
        session.noticed = true;
        options.onNotice?.(taskBranchNotice(result.branchName, result.reused));
      }
    }
    return result;
  };
  return {
    session,
    prepare,
    async assertPrepared() {
      const result = await prepare();
      if (result.status !== "succeeded") {
        throw new TaskBranchPreparationError(result.message);
      }
      return result;
    },
  };
}

export async function prepareTaskBranch(input: {
  repositoryPath: string;
  session?: TaskBranchSession;
  createBranchName?: () => string;
}): Promise<TaskBranchPreparation> {
  const session = input.session ?? {};
  const gitCheckout = new GitCheckout(input.repositoryPath);
  const inside = await gitCheckout.text(["rev-parse", "--is-inside-work-tree"]);
  const head = await gitCheckout.text(["rev-parse", "--verify", "HEAD"]);
  if (inside !== "true" || !head || !/^[a-f0-9]{40,64}$/iu.test(head)) {
    return fail("repository");
  }
  const current = await currentBranchName(gitCheckout);
  const previousDefault = session.defaultBranch;
  const defaultBranch = await resolveDefaultBranch(gitCheckout, session);
  if (defaultBranch) session.defaultBranch = defaultBranch;

  if (current && !isProtectedCheckout(current, defaultBranch, previousDefault)) {
    session.branchName = current;
    return succeed(current, true);
  }

  const remembered = session.branchName;
  if (remembered && isProtectedCheckout(remembered, defaultBranch, previousDefault)) {
    session.branchName = undefined;
  }
  if (remembered && session.branchName === remembered && current === remembered) {
    return succeed(remembered, true);
  }
  if (
    remembered &&
    session.branchName === remembered &&
    (await gitCheckout.branchExists(remembered))
  ) {
    const rememberedHead = await gitCheckout.text(["rev-parse", "--verify", remembered]);
    if (rememberedHead !== head) {
      return {
        status: "mismatched",
        message: TASK_BRANCH_FAILURES.mismatched,
        branchName: remembered,
      };
    }
    if (!(await gitCheckout.switchTo(remembered))) return fail("checkout");
    return succeed(remembered, true);
  }

  if (
    current?.startsWith(TASK_BRANCH_PREFIX) &&
    !isProtectedCheckout(current, defaultBranch, previousDefault)
  ) {
    session.branchName = current;
    return succeed(current, true);
  }

  const matching = (await gitCheckout.taskBranchesAt(head)).filter(
    (name) => !isProtectedCheckout(name, defaultBranch, previousDefault),
  );
  const adopted = matching[0];
  if (adopted) {
    if (current !== adopted && !(await gitCheckout.switchTo(adopted))) return fail("checkout");
    session.branchName = adopted;
    return succeed(adopted, true);
  }
  const name = (input.createBranchName ?? createTaskBranchName)();
  if (
    !SAFE_BRANCH.test(name) ||
    !name.startsWith(TASK_BRANCH_PREFIX) ||
    isProtectedCheckout(name, defaultBranch, previousDefault)
  )
    return fail("create");
  if (await gitCheckout.branchExists(name)) return fail("collision");
  if (!(await gitCheckout.create(name))) return fail("create");
  session.branchName = name;
  return succeed(name, false);
}

function isProtectedCheckout(
  current: string | undefined,
  defaultBranch: string | undefined,
  previousDefault?: string,
): boolean {
  return (
    current === undefined ||
    current === defaultBranch ||
    current === "main" ||
    current === "master" ||
    (previousDefault !== undefined && current === previousDefault && current !== defaultBranch)
  );
}

function succeed(branchName: string, reused: boolean): TaskBranchPreparation {
  return { status: "succeeded", branchName, reused };
}

function fail(code: keyof typeof TASK_BRANCH_FAILURES): TaskBranchPreparation {
  return { status: "failed", message: TASK_BRANCH_FAILURES[code] };
}

async function currentBranchName(gitCheckout: GitCheckout): Promise<string | undefined> {
  const name = await gitCheckout.text(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return name && SAFE_BRANCH.test(name) ? name : undefined;
}

async function resolveDefaultBranch(
  gitCheckout: GitCheckout,
  session: TaskBranchSession,
): Promise<string | undefined> {
  const originHead = await gitCheckout.text([
    "symbolic-ref",
    "--quiet",
    "refs/remotes/origin/HEAD",
  ]);
  const prefix = "refs/remotes/origin/";
  if (originHead?.startsWith(prefix)) {
    const name = originHead.slice(prefix.length);
    if (name && SAFE_BRANCH.test(name)) return name;
  }
  const configured = await gitCheckout.text(["config", "--get", "init.defaultBranch"]);
  if (configured && SAFE_BRANCH.test(configured) && (await gitCheckout.branchExists(configured))) {
    return configured;
  }
  if (await gitCheckout.branchExists("main")) return "main";
  if (await gitCheckout.branchExists("master")) return "master";
  if (session.defaultBranch && (await gitCheckout.branchExists(session.defaultBranch))) {
    return session.defaultBranch;
  }
  const heads = await gitCheckout.localHeads();
  return heads.length === 1 ? heads[0] : undefined;
}

export const TASK_BRANCH_STATE_KIND = "docsfab-live-agent-task-branch" as const;

/** Subdirectory of the session directory that holds one task-branch state file per repository. */
export const TASK_BRANCH_STATE_DIRECTORY = "task-branches";

async function restoreSession(
  repositoryPath: string,
  sessionDirectory: string | undefined,
  session: TaskBranchSession,
): Promise<void> {
  if (!sessionDirectory) return;
  try {
    const raw = JSON.parse(await readFile(statePath(repositoryPath, sessionDirectory), "utf8")) as {
      kind?: unknown;
      repositoryPath?: unknown;
      branchName?: unknown;
      defaultBranch?: unknown;
    };
    if (raw.kind !== TASK_BRANCH_STATE_KIND || raw.repositoryPath !== repositoryPath) return;
    if (typeof raw.branchName === "string" && SAFE_BRANCH.test(raw.branchName)) {
      session.branchName = raw.branchName;
    }
    if (typeof raw.defaultBranch === "string" && SAFE_BRANCH.test(raw.defaultBranch)) {
      session.defaultBranch = raw.defaultBranch;
    }
  } catch {
    return;
  }
}

async function persistSession(
  repositoryPath: string,
  sessionDirectory: string | undefined,
  session: TaskBranchSession,
): Promise<void> {
  if (!sessionDirectory || !session.branchName) return;
  try {
    const path = statePath(repositoryPath, sessionDirectory);
    await mkdir(join(sessionDirectory, TASK_BRANCH_STATE_DIRECTORY), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      path,
      `${JSON.stringify({
        kind: TASK_BRANCH_STATE_KIND,
        repositoryPath,
        branchName: session.branchName,
        ...(session.defaultBranch ? { defaultBranch: session.defaultBranch } : {}),
      })}\n`,
      { mode: 0o600 },
    );
  } catch {
    return;
  }
}

function statePath(repositoryPath: string, sessionDirectory: string): string {
  return join(
    sessionDirectory,
    TASK_BRANCH_STATE_DIRECTORY,
    `${canonicalDigest(repositoryPath)}.json`,
  );
}

class GitCheckout {
  private readonly runner = new ExecInitCommandRunner();

  constructor(private readonly cwd: string) {}

  async text(args: readonly string[]): Promise<string | undefined> {
    const result = await git(this.runner, this.cwd, args);
    if (result.exitCode !== 0 || result.failure) return undefined;
    const value = result.stdout.trim();
    return value.length > 0 ? value : undefined;
  }

  async branchExists(name: string): Promise<boolean> {
    if (!SAFE_BRANCH.test(name)) return false;
    const result = await git(this.runner, this.cwd, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${name}`,
    ]);
    return result.exitCode === 0 && !result.failure;
  }

  async localHeads(): Promise<string[]> {
    const text = await this.text(["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
    if (!text) return [];
    return text.split(/\r?\n/u).filter((name) => SAFE_BRANCH.test(name));
  }

  async taskBranchesAt(head: string): Promise<string[]> {
    const text = await this.text([
      "for-each-ref",
      "--format=%(objectname) %(refname:short)",
      `refs/heads/${TASK_BRANCH_PREFIX}*`,
    ]);
    if (!text) return [];
    return text
      .split(/\r?\n/u)
      .flatMap((line) => {
        const separator = line.indexOf(" ");
        if (separator < 0) return [];
        const sha = line.slice(0, separator);
        const name = line.slice(separator + 1);
        return sha === head && name.startsWith(TASK_BRANCH_PREFIX) && SAFE_BRANCH.test(name)
          ? [name]
          : [];
      })
      .sort();
  }

  async switchTo(name: string): Promise<boolean> {
    if (!SAFE_BRANCH.test(name)) return false;
    const result = await git(this.runner, this.cwd, ["switch", "--no-guess", "--", name]);
    return result.exitCode === 0 && !result.failure;
  }

  async create(name: string): Promise<boolean> {
    if (!SAFE_BRANCH.test(name)) return false;
    const result = await git(this.runner, this.cwd, ["switch", "--no-guess", "-c", name]);
    return result.exitCode === 0 && !result.failure;
  }
}
