// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local-user GitLab observer and note hooks for `--comment-mr`.
 *
 * Uses `glab api` GET/POST/PUT only. Never `git commit`, `git push`,
 * `git branch`, or `glab mr create`. Live tokens stay in the glab store.
 */

import { spawn } from "node:child_process";

import { localUserGitIdentitySha256 } from "../delivery/contracts.js";
import { glabEnvironment } from "../delivery/gitlab-adapter.js";
import { loadPrivateDocsFabEnvironment } from "../config/private-environment.js";
import {
  parseGitLabRemote,
  resolveLocalUserGitIdentity,
  type ReadOnlyCommandRunner,
} from "../delivery/preflight.js";
import { parseJsonEvidence } from "../json-evidence.js";
import {
  requestIdentitySha256FromBinding,
  type ObservedMergeRequest,
} from "./comment-existing-mr.js";
import type { ParsedCommentMrTarget } from "./comment-existing-mr-target.js";

const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const FORBIDDEN_GIT = /^(?:commit|push|branch|checkout|merge|rebase|tag)$/u;

export interface CommentExistingMrNoteHooks {
  readonly botUserId: string;
  observeHead(binding: { host: string; projectId: number; mergeRequestIid: number }): Promise<{
    scmProvider: "gitlab";
    host: string;
    projectId: number;
    mergeRequestIid: number;
    observedHeadSha: string | null;
    sourceBranch: string | null;
    targetBranch: string | null;
    proofStatus: "current" | "unknown" | "ambiguous" | "moving";
  }>;
  listNotes(binding: {
    host: string;
    projectId: number;
    mergeRequestIid: number;
  }): Promise<readonly { noteId: string; body: string; authorId: string }[]>;
  create(input: {
    binding: { host: string; projectId: number; mergeRequestIid: number };
    body: string;
  }): Promise<{ status: "ok"; noteId: string } | { status: "uncertain" }>;
  update(input: {
    binding: { host: string; projectId: number; mergeRequestIid: number };
    noteId: string;
    body: string;
  }): Promise<{ status: "ok"; noteId: string } | { status: "uncertain" }>;
}

export async function observeCommentExistingMrWithGlab(
  input: { target: ParsedCommentMrTarget; repositoryPath: string },
  commands: ReadOnlyCommandRunner,
): Promise<ObservedMergeRequest> {
  const remote =
    input.target.kind === "url"
      ? { host: input.target.host, projectPath: input.target.projectPath }
      : await readGitLabRemote(commands, input.repositoryPath);
  const projectId = await gitlabProjectId(
    commands,
    input.repositoryPath,
    remote.host,
    remote.projectPath,
  );
  const mergeRequestIid = input.target.mergeRequestIid;
  const mr = await gitlabMergeRequest(
    commands,
    input.repositoryPath,
    remote.host,
    projectId,
    mergeRequestIid,
  );
  let requestIdentitySha256: string;
  try {
    const identity = await resolveLocalUserGitIdentity(commands, input.repositoryPath, remote.host);
    requestIdentitySha256 = localUserGitIdentitySha256(identity.name, identity.email);
  } catch {
    requestIdentitySha256 = requestIdentitySha256FromBinding(
      remote.host,
      projectId,
      mergeRequestIid,
    );
  }
  return {
    host: remote.host,
    projectId,
    mergeRequestIid,
    sourceBranch: mr.sourceBranch,
    targetBranch: mr.targetBranch,
    headSha: mr.headSha,
    requestIdentitySha256,
    proofStatus: "current",
  };
}

export async function createGlabCommentExistingMrNoteHooks(
  commands: ReadOnlyCommandRunner,
  cwd: string,
): Promise<CommentExistingMrNoteHooks> {
  const remote = await readGitLabRemote(commands, cwd);
  const botUserId = await gitlabUserId(commands, cwd, remote.host);
  return {
    botUserId,
    async observeHead(binding) {
      const mr = await gitlabMergeRequest(
        commands,
        cwd,
        binding.host,
        binding.projectId,
        binding.mergeRequestIid,
      );
      return {
        scmProvider: "gitlab",
        host: binding.host,
        projectId: binding.projectId,
        mergeRequestIid: binding.mergeRequestIid,
        observedHeadSha: mr.headSha,
        sourceBranch: mr.sourceBranch,
        targetBranch: mr.targetBranch,
        proofStatus: "current",
      };
    },
    async listNotes(binding) {
      const value = await gitlabGet(
        commands,
        cwd,
        binding.host,
        `projects/${binding.projectId}/merge_requests/${binding.mergeRequestIid}/notes?per_page=100`,
      );
      if (!Array.isArray(value)) {
        throw new Error("GitLab merge-request notes response was missing or invalid.");
      }
      return value.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          throw new Error("GitLab merge-request notes response was missing or invalid.");
        }
        const record = entry as {
          id?: unknown;
          body?: unknown;
          author?: { id?: unknown };
        };
        if (typeof record.id !== "number" || typeof record.body !== "string") {
          throw new Error("GitLab merge-request notes response was missing or invalid.");
        }
        const authorId =
          record.author &&
          typeof record.author === "object" &&
          typeof record.author.id === "number" &&
          Number.isSafeInteger(record.author.id) &&
          record.author.id > 0
            ? String(record.author.id)
            : "";
        return { noteId: String(record.id), body: record.body, authorId };
      });
    },
    async create(input) {
      return mutateNote(
        cwd,
        input.binding,
        "POST",
        `projects/${input.binding.projectId}/merge_requests/${input.binding.mergeRequestIid}/notes`,
        input.body,
      );
    },
    async update(input) {
      return mutateNote(
        cwd,
        input.binding,
        "PUT",
        `projects/${input.binding.projectId}/merge_requests/${input.binding.mergeRequestIid}/notes/${encodeURIComponent(input.noteId)}`,
        input.body,
      );
    },
  };
}

async function readGitLabRemote(
  commands: ReadOnlyCommandRunner,
  cwd: string,
): Promise<{ host: string; projectPath: string }> {
  const names = await commands.run("git", ["remote"], cwd);
  if (names.exitCode !== 0) {
    throw new Error("docsfab --comment-mr could not inspect configured Git remotes.");
  }
  const remoteNames = names.stdout.split(/\r?\n/u).filter(Boolean);
  const preferred = remoteNames.includes("origin") ? "origin" : remoteNames[0];
  if (!preferred) throw new Error("docsfab --comment-mr requires a configured GitLab remote URL.");
  const url = await commands.run("git", ["remote", "get-url", preferred], cwd);
  if (url.exitCode !== 0 || !url.stdout.trim()) {
    throw new Error("docsfab --comment-mr requires a configured GitLab remote URL.");
  }
  const parsed = parseGitLabRemote(url.stdout.trim());
  return { host: parsed.host, projectPath: parsed.projectPath };
}

async function gitlabUserId(
  commands: ReadOnlyCommandRunner,
  cwd: string,
  host: string,
): Promise<string> {
  const value = await gitlabGet(commands, cwd, host, "user");
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as { id?: unknown }).id !== "number" ||
    !Number.isSafeInteger((value as { id: number }).id) ||
    (value as { id: number }).id <= 0
  ) {
    throw new Error("GitLab user response was missing a valid numeric user id.");
  }
  return String((value as { id: number }).id);
}

async function gitlabProjectId(
  commands: ReadOnlyCommandRunner,
  cwd: string,
  host: string,
  projectPath: string,
): Promise<number> {
  const value = await gitlabGet(commands, cwd, host, `projects/${encodeURIComponent(projectPath)}`);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as { id?: unknown }).id !== "number" ||
    !Number.isSafeInteger((value as { id: number }).id) ||
    (value as { id: number }).id <= 0
  ) {
    throw new Error("GitLab project response was missing a valid numeric project id.");
  }
  return (value as { id: number }).id;
}

async function gitlabMergeRequest(
  commands: ReadOnlyCommandRunner,
  cwd: string,
  host: string,
  projectId: number,
  mergeRequestIid: number,
): Promise<{ headSha: string; sourceBranch: string; targetBranch: string }> {
  const value = await gitlabGet(
    commands,
    cwd,
    host,
    `projects/${projectId}/merge_requests/${mergeRequestIid}`,
  );
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitLab merge-request response was missing required head or branch fields.");
  }
  const record = value as {
    sha?: unknown;
    source_branch?: unknown;
    target_branch?: unknown;
  };
  if (
    typeof record.sha !== "string" ||
    !REVISION.test(record.sha) ||
    typeof record.source_branch !== "string" ||
    !SAFE_BRANCH.test(record.source_branch) ||
    typeof record.target_branch !== "string" ||
    !SAFE_BRANCH.test(record.target_branch) ||
    record.source_branch === record.target_branch
  ) {
    throw new Error("GitLab merge-request response was missing required head or branch fields.");
  }
  return {
    headSha: record.sha,
    sourceBranch: record.source_branch,
    targetBranch: record.target_branch,
  };
}

async function gitlabGet(
  commands: ReadOnlyCommandRunner,
  cwd: string,
  host: string,
  endpoint: string,
): Promise<unknown> {
  rejectMutationArgs("glab", ["api", "--hostname", host, endpoint]);
  const result = await commands.run("glab", ["api", "--hostname", host, endpoint], cwd);
  if (result.exitCode !== 0) {
    throw new Error(
      "GitLab API lookup failed before comment-existing-mr could observe the merge request.",
    );
  }
  return parseJsonEvidence(result.stdout);
}

async function mutateNote(
  cwd: string,
  binding: { host: string; projectId: number; mergeRequestIid: number },
  method: "POST" | "PUT",
  endpoint: string,
  body: string,
): Promise<{ status: "ok"; noteId: string } | { status: "uncertain" }> {
  rejectMutationArgs("glab", ["api", "--method", method, endpoint]);
  const payload = JSON.stringify({ body });
  try {
    const stdout = await spawnGlabApi(cwd, binding.host, method, endpoint, payload);
    const value = parseJsonEvidence(stdout);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "uncertain" };
    const id = (value as { id?: unknown }).id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      return { status: "uncertain" };
    }
    return { status: "ok", noteId: String(id) };
  } catch {
    return { status: "uncertain" };
  }
}

function spawnGlabApi(
  cwd: string,
  host: string,
  method: "POST" | "PUT",
  endpoint: string,
  payload: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "glab",
      ["api", "--hostname", host, "--method", method, endpoint, "--input", "-"],
      {
        cwd,
        env: glabEnvironment(loadPrivateDocsFabEnvironment()),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(chunks).toString("utf8");
      if (code === 0) resolve(stdout);
      else reject(new Error("GitLab note mutation failed."));
    });
    child.stdin.end(payload, "utf8");
  });
}

function rejectMutationArgs(command: "git" | "glab", args: readonly string[]): void {
  if (command === "git" && args.some((argument) => FORBIDDEN_GIT.test(argument))) {
    throw new Error(
      "comment-existing-mr must not create a commit, branch, push, or merge request.",
    );
  }
  if (command === "glab" && args.some((argument) => argument === "mr" || argument === "create")) {
    throw new Error(
      "comment-existing-mr must not create a commit, branch, push, or merge request.",
    );
  }
}
