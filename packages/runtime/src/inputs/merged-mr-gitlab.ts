// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * GitLab page, diff, and checkout-identity ports for date-scoped UPDATE.
 *
 * Transport lives here because `src/live-agent/gitlab-read.ts` is a confined
 * ToolDefinition, not a callable library API. These ports use the same
 * `list_merged` / `diffs` endpoints, `GITLAB_READ_FAILURES` vocabulary, and
 * `glab api` transport.
 */

import { execFile } from "node:child_process";

import type { ReadOnlyCommandResult } from "../delivery/command-types.js";
import { glabEnvironment } from "../delivery/gitlab-adapter.js";
import { loadPrivateDocsFabEnvironment } from "../config/private-environment.js";
import { classifyGlabCommandFailure } from "../delivery/glab-auth-diagnosis.js";
import { discoverRepository, selectCanonicalRemote } from "../init/gitlab-probe.js";
import type { CommandRunner, RemoteCandidate } from "../init/types.js";
import { GITLAB_READ_FAILURES } from "../live-agent/gitlab-read.js";
import { assertConfinedToolResultCredentialFree } from "../security/credential-isolation.js";
import type { GitLabProjectIdentityPortV1 } from "./gitlab-source-provider.js";
import {
  MERGED_MR_FAILURE_CODES,
  type MergedMrFailureCodeV1,
  type MergedMrPagePortV1,
  type MergedMrPageV1,
} from "./merged-mr-discovery.js";
import type { MergedMrProjectScopeV1, MergedMrRecordV1 } from "./merged-mr-selection.js";

const LIST_PAGE_SIZE = 100;
const DIFF_PAGE_SIZE = 20;
const TEXT_LIMIT = 32_000;
const MAX_DIFF_PAGES = 50;
const GITLAB_API_TIMEOUT_MS = 60_000;
/** GitLab merged-MR list pages can exceed the init runner's 2 MiB cap. */
const GITLAB_API_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

class MergedMrGitLabApiRunner implements CommandRunner {
  public run(
    command: "git" | "glab",
    args: readonly string[],
    cwd: string,
    options: { env?: NodeJS.ProcessEnv } = {},
  ): Promise<ReadOnlyCommandResult> {
    return new Promise((resolveResult) => {
      execFile(
        command,
        [...args],
        {
          cwd,
          encoding: "utf8",
          env: options.env,
          timeout: GITLAB_API_TIMEOUT_MS,
          maxBuffer: GITLAB_API_MAX_BUFFER_BYTES,
        },
        (error, stdout, stderr) =>
          resolveResult({
            exitCode: error ? 1 : 0,
            stdout: typeof stdout === "string" ? stdout : "",
            stderr: typeof stderr === "string" ? stderr : "",
            ...(error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
              ? { failure: "output-limit" as const }
              : error?.killed
                ? { failure: "timeout" as const }
                : {}),
          }),
      );
    });
  }
}

function gitlabCommands(options: GitLabMergedMrPortOptionsV1): CommandRunner {
  return options.commands ?? new MergedMrGitLabApiRunner();
}

export class GitLabMergedMrReadError extends Error {
  public constructor(public readonly code: MergedMrFailureCodeV1) {
    super(GITLAB_READ_FAILURES[code]);
    this.name = "GitLabMergedMrReadError";
  }
}

function failRead(code: MergedMrFailureCodeV1): never {
  throw new GitLabMergedMrReadError(code);
}

export interface GitLabMergedMrDiffFileV1 {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly diff: string | null;
  readonly collapsed: boolean;
  readonly tooLarge: boolean;
  readonly newFile: boolean;
  readonly deletedFile: boolean;
  readonly renamedFile: boolean;
}

export interface GitLabMergedMrDiffBundleV1 {
  readonly iid: number;
  readonly files: readonly GitLabMergedMrDiffFileV1[];
  readonly truncated: boolean;
  readonly pagesRead: number;
}

export interface GitLabMergedMrPortOptionsV1 {
  readonly repositoryPath: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly commands?: CommandRunner;
}

function integer(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= max;
}

function text(value: unknown, truncated: { value: boolean }): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    failRead("response");
  }
  truncated.value ||= value.length > TEXT_LIMIT;
  return value.slice(0, TEXT_LIMIT);
}

function classifyFailure(result: ReadOnlyCommandResult): MergedMrFailureCodeV1 {
  if (result.failure === "output-limit") return "response";
  if (result.failure === "timeout") return "timeout";
  const category = classifyGlabCommandFailure({ ...result, kind: "api" });
  if (category === "unauthenticated") return "authentication";
  if (category === "unreachable") return "network";
  if (/\b403\b/u.test(result.stderr ?? "")) return "access";
  return "request";
}

async function resolveRemote(options: GitLabMergedMrPortOptionsV1): Promise<RemoteCandidate> {
  const commands = gitlabCommands(options);
  try {
    const repository = await discoverRepository(options.repositoryPath, commands);
    return await selectCanonicalRemote(repository, undefined, false, {
      async chooseRemote() {
        failRead("repository");
      },
      async confirm() {
        return false;
      },
    });
  } catch (error) {
    if (error instanceof GitLabMergedMrReadError) throw error;
    failRead("repository");
  }
}

async function gitlabGet(
  options: GitLabMergedMrPortOptionsV1,
  target: RemoteCandidate,
  endpoint: string,
): Promise<unknown> {
  const commands = gitlabCommands(options);
  const environment = glabEnvironment(
    loadPrivateDocsFabEnvironment(options.environment ?? process.env),
  );
  let result: { exitCode: number; stdout: string; stderr?: string };
  try {
    result = await commands.run(
      "glab",
      ["api", "--hostname", target.host, "--method", "GET", endpoint],
      options.repositoryPath,
      { env: environment },
    );
  } catch {
    failRead("request");
  }
  if (result.exitCode !== 0) {
    failRead(classifyFailure(result));
  }
  let parsed: unknown;
  try {
    if (Buffer.byteLength(result.stdout) > GITLAB_API_MAX_BUFFER_BYTES) {
      failRead("response");
    }
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    if (error instanceof GitLabMergedMrReadError) throw error;
    failRead("response");
  }
  return parsed;
}

function projectListItems(parsed: unknown, limit: number): Omit<MergedMrPageV1, "nextPage"> {
  if (!Array.isArray(parsed) || parsed.length > limit) {
    failRead("response");
  }
  const truncated = { value: false };
  const items = parsed.map((record): MergedMrRecordV1 => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      failRead("response");
    }
    const item = record as Record<string, unknown>;
    if (!integer(item.iid, Number.MAX_SAFE_INTEGER)) {
      failRead("response");
    }
    // Match live-agent `list_merged`: compact identity fields, no description.
    return {
      iid: item.iid,
      url: null,
      title: text(item.title, truncated),
      state: text(item.state, truncated),
      mergedAt: text(item.merged_at, truncated),
      targetBranch: text(item.target_branch, truncated),
      sourceBranch: text(item.source_branch, truncated),
      mergeCommitSha: text(item.merge_commit_sha, truncated),
      squashCommitSha: text(item.squash_commit_sha, truncated),
      updatedAt: text(item.updated_at, truncated),
    };
  });
  try {
    assertConfinedToolResultCredentialFree({ items });
  } catch {
    failRead("credentials");
  }
  return { items, truncated: truncated.value };
}

function projectDiffItems(parsed: unknown): {
  items: GitLabMergedMrDiffFileV1[];
  truncated: boolean;
} {
  if (!Array.isArray(parsed) || parsed.length > DIFF_PAGE_SIZE) {
    failRead("response");
  }
  const truncated = { value: false };
  const items: GitLabMergedMrDiffFileV1[] = [];
  for (const record of parsed) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      failRead("response");
    }
    const item = record as Record<string, unknown>;
    const file: GitLabMergedMrDiffFileV1 = {
      oldPath: text(item.old_path, truncated),
      newPath: text(item.new_path, truncated),
      diff: text(item.diff, truncated),
      collapsed: item.collapsed === true,
      tooLarge: item.too_large === true,
      newFile: item.new_file === true,
      deletedFile: item.deleted_file === true,
      renamedFile: item.renamed_file === true,
    };
    try {
      assertConfinedToolResultCredentialFree({ items: [file] });
      items.push(file);
    } catch {
      truncated.value = true;
    }
  }
  try {
    assertConfinedToolResultCredentialFree({ items });
  } catch {
    truncated.value = true;
    return { items: [], truncated: true };
  }
  return { items, truncated: truncated.value };
}

function listEndpoint(target: RemoteCandidate, page: number): string {
  return (
    `projects/${encodeURIComponent(target.projectPath)}/merge_requests` +
    `?state=merged&scope=all&order_by=merged_at&sort=desc` +
    `&per_page=${LIST_PAGE_SIZE}&page=${page}`
  );
}

function diffsEndpoint(target: RemoteCandidate, iid: number, page: number): string {
  return (
    `projects/${encodeURIComponent(target.projectPath)}/merge_requests/${iid}` +
    `/diffs?per_page=${DIFF_PAGE_SIZE}&page=${page}`
  );
}

/**
 * Checkout identity adapter for the shared GitLab source provider.
 *
 * Always answers about this checkout's canonical remote. The numeric project
 * id is required: a path alone cannot key a `gitlab-mr:v1:` locator. Scope
 * matching against the requested path stays in `resolveGitLabSourceScope`.
 */
export function createGitLabCheckoutIdentityPort(
  options: GitLabMergedMrPortOptionsV1,
): GitLabProjectIdentityPortV1 {
  return {
    async resolveProjectIdentity() {
      const project = await resolveGitLabMergedMrProject(options);
      if (typeof project.projectPath !== "string" || project.projectPath.length === 0) {
        failRead("repository");
      }
      if (
        typeof project.projectId !== "number" ||
        !Number.isSafeInteger(project.projectId) ||
        project.projectId <= 0
      ) {
        failRead("response");
      }
      return {
        host: project.host,
        projectId: project.projectId,
        projectPath: project.projectPath,
      };
    },
  };
}

/** Same-project GitLab identity for the selected checkout's canonical remote. */
export async function resolveGitLabMergedMrProject(
  options: GitLabMergedMrPortOptionsV1,
): Promise<MergedMrProjectScopeV1> {
  const target = await resolveRemote(options);
  let projectId: number | undefined;
  try {
    const parsed = await gitlabGet(
      options,
      target,
      `projects/${encodeURIComponent(target.projectPath)}`,
    );
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      integer((parsed as { id?: unknown }).id, Number.MAX_SAFE_INTEGER)
    ) {
      projectId = (parsed as { id: number }).id;
    }
  } catch {
    // Numeric identity is optional. Selection still works with host + path.
  }
  return {
    host: target.host,
    projectPath: target.projectPath,
    ...(projectId !== undefined ? { projectId } : {}),
  };
}

/** Injected `list_merged` page port. Ordering is the shipped GitLab contract. */
export function createGitLabMergedMrPagePort(
  options: GitLabMergedMrPortOptionsV1,
): MergedMrPagePortV1 {
  return {
    orderedDescendingByMergedAt: true,
    async fetchPage(page: number): Promise<MergedMrPageV1> {
      if (!Number.isSafeInteger(page) || page < 1) {
        failRead("request");
      }
      const target = await resolveRemote(options);
      const parsed = await gitlabGet(options, target, listEndpoint(target, page));
      const projected = projectListItems(parsed, LIST_PAGE_SIZE);
      return {
        ...projected,
        nextPage: Array.isArray(parsed) && parsed.length === LIST_PAGE_SIZE ? page + 1 : null,
      };
    },
  };
}

export type MergedMrDiffFetcherV1 = (iid: number) => Promise<GitLabMergedMrDiffBundleV1>;

export function createGitLabMergedMrDiffFetcher(
  options: GitLabMergedMrPortOptionsV1,
): MergedMrDiffFetcherV1 {
  return async (iid: number): Promise<GitLabMergedMrDiffBundleV1> => {
    if (!Number.isSafeInteger(iid) || iid < 1) {
      failRead("request");
    }
    const target = await resolveRemote(options);
    const files: GitLabMergedMrDiffFileV1[] = [];
    let truncated = false;
    let page: number | null = 1;
    let pagesRead = 0;
    while (page !== null) {
      if (pagesRead >= MAX_DIFF_PAGES) {
        truncated = true;
        break;
      }
      const parsed = await gitlabGet(options, target, diffsEndpoint(target, iid, page));
      const projected = projectDiffItems(parsed);
      pagesRead += 1;
      files.push(...projected.items);
      truncated ||= projected.truncated;
      truncated ||= projected.items.some((file) => file.tooLarge || file.collapsed);
      page = Array.isArray(parsed) && parsed.length === DIFF_PAGE_SIZE ? page + 1 : null;
    }
    return { iid, files: Object.freeze(files), truncated, pagesRead };
  };
}

export function isMergedMrFailureCode(value: unknown): value is MergedMrFailureCodeV1 {
  return (
    typeof value === "string" && (MERGED_MR_FAILURE_CODES as readonly string[]).includes(value)
  );
}
