// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ReadOnlyCommandResult } from "./command-types.js";
import {
  LocalUserPublicationPreflightError,
  type LocalUserPublicationFailureCode,
  type LocalUserPublicationPreflightDetails,
} from "./contracts.js";
import {
  classifyGlabCommandFailure,
  publicationCodeForGlabAuthClass,
} from "./glab-auth-diagnosis.js";
import type { ReadOnlyCommandRunner } from "./preflight.js";

const PINNED_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
/** GitLab's answer for a commit it does not have, such as `404 Commit Not Found`. */
const COMMIT_NOT_FOUND = /\b404\b[^\n]*\bnot found\b/iu;

export interface RunRevisionPublishableInput {
  readonly runRevision: string;
  readonly gitlabTargetRevision: string;
  readonly projectId: number;
  readonly host: string;
  readonly repositoryPath: string;
}

/** Pure policy: publish when GitLab merge-base equals the run base (includes equal SHAs). */
export function isRunRevisionPublishableFromMergeBase(
  runRevision: string,
  mergeBaseRevision: string,
): boolean {
  return mergeBaseRevision.toLowerCase() === runRevision.toLowerCase();
}

export async function gitLabMergeBaseRevision(
  commands: ReadOnlyCommandRunner,
  input: Pick<RunRevisionPublishableInput, "projectId" | "host" | "repositoryPath"> & {
    readonly leftRevision: string;
    readonly rightRevision: string;
  },
): Promise<string> {
  const result = await requestGitLabMergeBase(commands, input);
  if (result.exitCode !== 0) fail("stale-revision");
  return mergeBaseFromResponse(result);
}

export async function assertRunRevisionPublishableForGitLabTarget(
  input: RunRevisionPublishableInput,
  commands: ReadOnlyCommandRunner,
  details?: LocalUserPublicationPreflightDetails,
): Promise<void> {
  const runRevision = input.runRevision.toLowerCase();
  const gitlabTargetRevision = input.gitlabTargetRevision.toLowerCase();
  if (runRevision === gitlabTargetRevision) return;
  const result = await requestGitLabMergeBase(commands, {
    projectId: input.projectId,
    host: input.host,
    repositoryPath: input.repositoryPath,
    leftRevision: runRevision,
    rightRevision: gitlabTargetRevision,
  });
  if (result.exitCode !== 0) {
    await failUnresolvedRunRevision(commands, { ...input, runRevision }, result, details);
  }
  const mergeBase = mergeBaseFromResponse(result, details);
  if (!isRunRevisionPublishableFromMergeBase(runRevision, mergeBase)) {
    fail("stale-revision", details);
  }
}

async function requestGitLabMergeBase(
  commands: ReadOnlyCommandRunner,
  input: Pick<RunRevisionPublishableInput, "projectId" | "host" | "repositoryPath"> & {
    readonly leftRevision: string;
    readonly rightRevision: string;
  },
): Promise<ReadOnlyCommandResult> {
  const left = input.leftRevision.toLowerCase();
  const right = input.rightRevision.toLowerCase();
  return commands.run(
    "glab",
    [
      "api",
      "--hostname",
      input.host,
      `projects/${input.projectId}/repository/merge_base?refs[]=${left}&refs[]=${right}`,
    ],
    input.repositoryPath,
  );
}

function mergeBaseFromResponse(
  result: ReadOnlyCommandResult,
  details?: LocalUserPublicationPreflightDetails,
): string {
  let value: { id?: string };
  try {
    value = JSON.parse(result.stdout) as { id?: string };
  } catch {
    fail("stale-revision", details);
  }
  if (typeof value.id !== "string" || !PINNED_REVISION.test(value.id.toLowerCase())) {
    fail("stale-revision", details);
  }
  return value.id.toLowerCase();
}

/**
 * GitLab did not compute a merge base. Name the cause the operator can act on
 * (#2120): GitLab was unreachable, glab was not authenticated, or GitLab does
 * not have the run base commit because it was never pushed. Any other answer
 * stays `stale-revision`. Command output is classified here and never copied
 * into the refusal.
 */
async function failUnresolvedRunRevision(
  commands: ReadOnlyCommandRunner,
  input: RunRevisionPublishableInput,
  mergeBase: ReadOnlyCommandResult,
  details?: LocalUserPublicationPreflightDetails,
): Promise<never> {
  failIfGitLabUnavailable(mergeBase);
  const commit = await commands.run(
    "glab",
    [
      "api",
      "--hostname",
      input.host,
      `projects/${input.projectId}/repository/commits/${input.runRevision}`,
    ],
    input.repositoryPath,
  );
  if (commit.exitCode !== 0) {
    failIfGitLabUnavailable(commit);
    if (COMMIT_NOT_FOUND.test(`${commit.stderr ?? ""}\n${commit.stdout}`)) {
      fail("run-revision-unpushed", details);
    }
  }
  fail("stale-revision", details);
}

function failIfGitLabUnavailable(result: ReadOnlyCommandResult): void {
  const failure = classifyGlabCommandFailure({
    kind: "api",
    exitCode: result.exitCode,
    stdout: result.stdout,
    ...(result.stderr === undefined ? {} : { stderr: result.stderr }),
  });
  if (failure === "unreachable" || failure === "unauthenticated") {
    fail(publicationCodeForGlabAuthClass(failure));
  }
}

function fail(
  code: LocalUserPublicationFailureCode,
  details?: LocalUserPublicationPreflightDetails,
): never {
  throw new LocalUserPublicationPreflightError(code, details);
}
