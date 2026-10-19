// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";

import { runtimeEgressRootSet, withoutEgressPlaceholders } from "../config/egress-roots.js";
import { egressText, type HostRootSet } from "../security/egress.js";
import { processPublicRoots } from "../security/host-roots.js";
import { loadPrivateDocsFabEnvironment } from "../config/private-environment.js";
import { containsConfiguredCredentialText, type LocalUserPublicationPlan } from "./contracts.js";
import { classifyGlabCommandFailure, tokenProbeFromExitCode } from "./glab-auth-diagnosis.js";
import {
  buildDocsFabPublicationProvenanceMarker,
  COMPOSITION_TITLE_PREFIX,
  hasExactDocsFabPublicationMetadata,
  hasExactDocsFabPublicationProvenance,
  type DocsFabPublicationMetadata,
} from "./metadata.js";

const MAX_OUTPUT = 1_000_000;
const SAFE_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const MAX_ACCESS_LEVEL = 100;

export type GitLabPublisherAdapterErrorCode =
  | "authentication-unavailable"
  | "authentication-revoked"
  | "host-unreachable"
  | "project-drift"
  | "protected-source-branch"
  | "invalid-response"
  | "external-failure";

export class GitLabPublisherAdapterError extends Error {
  public constructor(public readonly code: GitLabPublisherAdapterErrorCode) {
    super(`GitLab publication adapter failed (${code}).`);
    this.name = "GitLabPublisherAdapterError";
  }
}

export interface GitLabPublisherCommandResult {
  exitCode: number;
  stdout: Buffer;
  stderr?: Buffer;
}

export interface GitLabPublisherCommandRunner {
  run(
    command: "glab",
    args: readonly string[],
    cwd: string,
    options: {
      env: NodeJS.ProcessEnv;
      timeoutMs: number;
      maxOutputBytes: number;
    },
  ): Promise<GitLabPublisherCommandResult>;
}

export interface GitLabMergeRequest {
  iid: number;
  url: string;
  state: "opened" | "closed" | "merged";
  /** False only for an advance plan's MR; every other read refuses a ready MR. */
  draft: boolean;
  sourceBranch: string;
  targetBranch: string;
  headRevision: string;
  sourceProjectId?: number;
  targetProjectId?: number;
  title?: string;
  description?: string;
}

export interface GitLabPublicationPolicy {
  username: string;
  projectId: number;
  projectPath: string;
  accessLevel: number;
  defaultBranch: string;
  targetBranch: {
    name: string;
    protected: boolean;
    revision: string;
  };
  sourceBranchProtected: boolean;
}

export interface GitLabPublisherAdapter {
  inspectPolicy(plan: LocalUserPublicationPlan, cwd: string): Promise<GitLabPublicationPolicy>;
  findMergeRequests(plan: LocalUserPublicationPlan, cwd: string): Promise<GitLabMergeRequest[]>;
  openDraftMergeRequest(input: {
    plan: LocalUserPublicationPlan;
    cwd: string;
    title: string;
    description: string;
    headRevision: string;
    metadata?: DocsFabPublicationMetadata;
    assertAuthorized?: () => void;
  }): Promise<GitLabMergeRequest>;
}

export class ExecFileGitLabPublisherCommandRunner implements GitLabPublisherCommandRunner {
  public run(
    command: "glab",
    args: readonly string[],
    cwd: string,
    options: {
      env: NodeJS.ProcessEnv;
      timeoutMs: number;
      maxOutputBytes: number;
    },
  ): Promise<GitLabPublisherCommandResult> {
    return new Promise((resolveResult) => {
      const child = spawn(command, [...args], {
        cwd,
        env: options.env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let size = 0;
      let errSize = 0;
      let settled = false;
      const finish = (exitCode: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveResult({
          exitCode,
          stdout: Buffer.concat(chunks),
          stderr: Buffer.concat(errChunks),
        });
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
        finish(1);
      }, options.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > options.maxOutputBytes) {
          terminate();
          finish(1);
        } else chunks.push(Buffer.from(chunk));
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        errSize += chunk.byteLength;
        if (errSize <= options.maxOutputBytes) errChunks.push(Buffer.from(chunk));
      });
      child.once("error", () => finish(1));
      child.once("close", (code) => finish(code === 0 ? 0 : 1));
    });
  }
}

/** Small fixed-command GitLab API surface. Raw command output never escapes. */
export class LocalUserGitLabPublisherAdapter implements GitLabPublisherAdapter {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly publicRoots: ReadonlySet<string>;

  /**
   * `environment` defaults to this process's, whose public roots are the
   * startup set. Throws `PublicRootsOperatorError` when an explicit
   * environment's `DOCSFAB_PUBLIC_ROOTS` is invalid.
   */
  public constructor(
    private readonly commands: GitLabPublisherCommandRunner = new ExecFileGitLabPublisherCommandRunner(),
    environment?: NodeJS.ProcessEnv,
  ) {
    // Public-root declarations are startup authority and must retain the
    // constructor's original source identity. The private effective copy is
    // only for configuration and credential consumers.
    this.publicRoots = processPublicRoots(environment);
    this.environment =
      environment === undefined || environment === process.env
        ? loadPrivateDocsFabEnvironment()
        : loadPrivateDocsFabEnvironment(environment, { isolated: true });
  }

  public async inspectPolicy(
    plan: LocalUserPublicationPlan,
    cwd: string,
  ): Promise<GitLabPublicationPolicy> {
    const auth = await this.run(["auth", "status", "--hostname", plan.project.host], cwd, true);
    if (auth.exitCode !== 0) {
      const probe = await this.run(
        ["config", "get", "token", "--host", plan.project.host],
        cwd,
        true,
      );
      const cls = classifyGlabCommandFailure({
        kind: "auth-status",
        exitCode: auth.exitCode,
        stdout: auth.stdout.toString("utf8"),
        stderr: auth.stderr?.toString("utf8") ?? "",
        tokenProbe: tokenProbeFromExitCode(probe.exitCode),
      });
      fail(cls === "unreachable" ? "host-unreachable" : "authentication-unavailable");
    }
    const user = object(await this.json(["api", "--hostname", plan.project.host, "user"], cwd));
    const username = safeString(user.username, 128);
    if (username !== plan.identity.gitlabUsername) fail("authentication-revoked");
    const project = object(
      await this.json(["api", "--hostname", plan.project.host, `projects/${plan.project.id}`], cwd),
    );
    if (
      project.id !== plan.project.id ||
      safeString(project.path_with_namespace, 512) !== plan.project.path
    )
      fail("project-drift");
    const accessLevel = Math.max(
      projectAccessLevel(object(project.permissions).project_access),
      projectAccessLevel(object(project.permissions).group_access),
    );
    const defaultBranch = safeString(project.default_branch, 200);
    const target = object(
      await this.json(
        [
          "api",
          "--hostname",
          plan.project.host,
          `projects/${plan.project.id}/repository/branches/${encodeURIComponent(plan.targetBranch.name)}`,
        ],
        cwd,
      ),
    );
    const targetName = safeString(target.name, 200);
    const targetProtected = target.protected;
    const targetRevision = safeString(object(target.commit).id, 64);
    if (
      targetName !== plan.targetBranch.name ||
      typeof targetProtected !== "boolean" ||
      !SAFE_REVISION.test(targetRevision)
    )
      fail("invalid-response");
    const rules = await this.paginated(plan, cwd, `projects/${plan.project.id}/protected_branches`);
    const protectedNames = rules.map((entry) => safeString(object(entry).name, 200));
    return Object.freeze({
      username,
      projectId: project.id,
      projectPath: safeString(project.path_with_namespace, 512),
      accessLevel,
      defaultBranch,
      targetBranch: Object.freeze({
        name: targetName,
        protected: targetProtected,
        revision: targetRevision,
      }),
      sourceBranchProtected: protectedNames.some((pattern) =>
        branchMatches(pattern, plan.proposedSourceBranch),
      ),
    });
  }

  public async findMergeRequests(
    plan: LocalUserPublicationPlan,
    cwd: string,
  ): Promise<GitLabMergeRequest[]> {
    const endpoint = `projects/${plan.project.id}/merge_requests?scope=all&state=all&source_branch=${encodeURIComponent(plan.proposedSourceBranch)}`;
    const requests = (await this.paginated(plan, cwd, endpoint)).map((value) =>
      mergeRequest(value, plan),
    );
    // Only an advance inspects a ready MR, to refuse it with its own code;
    // a plan that creates its branch never adopts one.
    if (plan.schemaVersion !== 3 && requests.some((request) => !request.draft)) {
      fail("invalid-response");
    }
    return requests;
  }

  public async openDraftMergeRequest(input: {
    plan: LocalUserPublicationPlan;
    cwd: string;
    title: string;
    description: string;
    headRevision: string;
    metadata?: DocsFabPublicationMetadata;
    assertAuthorized?: () => void;
  }): Promise<GitLabMergeRequest> {
    const roots = runtimeEgressRootSet({
      environment: this.environment,
      workspace: input.cwd,
      publicRoots: this.publicRoots,
    });
    const title = egress(input.title, roots);
    const description = egress(input.description, roots);
    const metadata = input.metadata && {
      ...input.metadata,
      mergeRequestTitle: egress(input.metadata.mergeRequestTitle, roots),
    };
    if (
      !SAFE_REVISION.test(input.headRevision) ||
      !isCanonicalDocsFabDraftTitle(
        title,
        input.plan.identity.gitlabUsername,
        metadata?.mergeRequestCompositionMarker !== undefined,
      ) ||
      !isSafeMergeRequestDescription(description) ||
      (metadata
        ? !metadataBindsPlan(input.plan, metadata) ||
          title !== metadata.mergeRequestTitle ||
          !hasExactDocsFabPublicationMetadata(title, description, metadata)
        : !hasExactDocsFabPublicationProvenance(
            description,
            buildDocsFabPublicationProvenanceMarker(input.plan),
          ))
    ) {
      fail("invalid-response");
    }
    input.assertAuthorized?.();
    const value = await this.json(
      [
        "api",
        "--hostname",
        input.plan.project.host,
        "--method",
        "POST",
        `projects/${input.plan.project.id}/merge_requests`,
        "--field",
        `source_branch=${input.plan.proposedSourceBranch}`,
        "--field",
        `target_branch=${input.plan.targetBranch.name}`,
        "--field",
        `title=${title}`,
        "--field",
        `description=${description}`,
        "--field",
        "remove_source_branch=false",
        "--field",
        "squash=false",
      ],
      input.cwd,
    );
    const result = mergeRequest(value, input.plan);
    if (!result.draft || result.state !== "opened" || result.headRevision !== input.headRevision) {
      fail("invalid-response");
    }
    return result;
  }

  private async json(args: readonly string[], cwd: string): Promise<unknown> {
    const result = await this.run(args, cwd, true);
    if (result.exitCode !== 0) fail(this.classifyApiFailure(result));
    if (result.stdout.byteLength === 0 || result.stdout.byteLength > MAX_OUTPUT)
      fail("invalid-response");
    try {
      return JSON.parse(result.stdout.toString("utf8")) as unknown;
    } catch {
      fail("invalid-response");
    }
  }

  private classifyApiFailure(
    result: GitLabPublisherCommandResult,
  ): GitLabPublisherAdapterErrorCode {
    const cls = classifyGlabCommandFailure({
      kind: "api",
      exitCode: result.exitCode,
      stdout: result.stdout.toString("utf8"),
      stderr: result.stderr?.toString("utf8") ?? "",
    });
    if (cls === "unreachable") return "host-unreachable";
    if (cls === "unauthenticated") return "authentication-unavailable";
    return "external-failure";
  }

  private async paginated(
    plan: LocalUserPublicationPlan,
    cwd: string,
    endpoint: string,
  ): Promise<unknown[]> {
    const result: unknown[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const separator = endpoint.includes("?") ? "&" : "?";
      const values = array(
        await this.json(
          [
            "api",
            "--hostname",
            plan.project.host,
            `${endpoint}${separator}per_page=100&page=${page}`,
          ],
          cwd,
        ),
      );
      result.push(...values);
      if (values.length < 100) return result;
    }
    fail("invalid-response");
  }

  private run(
    args: readonly string[],
    cwd: string,
    allowFailure = false,
  ): Promise<GitLabPublisherCommandResult> {
    if (args.some((argument) => typeof argument !== "string" || argument.includes("\0"))) {
      fail("invalid-response");
    }
    return this.commands
      .run("glab", args, cwd, {
        env: glabEnvironment(this.environment),
        timeoutMs: 30_000,
        maxOutputBytes: MAX_OUTPUT,
      })
      .then((result) => {
        if (!allowFailure && result.exitCode !== 0) fail("external-failure");
        return result;
      });
  }
}

export function glabEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    PATH: source.PATH,
    HOME: source.HOME,
    USER: source.USER,
    LOGNAME: source.LOGNAME,
    TMPDIR: source.TMPDIR,
    SSH_AUTH_SOCK: source.SSH_AUTH_SOCK,
    XDG_CONFIG_HOME: source.XDG_CONFIG_HOME,
    GLAB_CONFIG_DIR: source.GLAB_CONFIG_DIR,
    GITLAB_HOST: source.GITLAB_HOST,
    GLAB_TOKEN: source.GLAB_TOKEN,
    GITLAB_TOKEN: source.GITLAB_TOKEN,
    LC_ALL: "C",
    LANG: "C",
    NO_COLOR: "1",
    PAGER: "cat",
    GLAB_PAGER: "cat",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
  };
  return Object.fromEntries(Object.entries(result).filter((entry) => entry[1] !== undefined));
}

function mergeRequest(value: unknown, plan: LocalUserPublicationPlan): GitLabMergeRequest {
  return parseGitLabMergeRequest(value, {
    host: plan.project.host,
    path: plan.project.path,
    projectId: plan.project.id,
    sourceBranch: plan.proposedSourceBranch,
  });
}

/**
 * Parse one GitLab merge request for a known project and source branch. The
 * draft flag is reported, not enforced; each caller decides what a ready MR means.
 */
export function parseGitLabMergeRequest(
  value: unknown,
  expected: {
    host: string;
    path: string;
    projectId: number;
    sourceBranch: string;
  },
): GitLabMergeRequest {
  const item = object(value);
  const iid = item.iid;
  if (!Number.isSafeInteger(iid) || (iid as number) <= 0) fail("invalid-response");
  const state = item.state;
  if (state !== "opened" && state !== "closed" && state !== "merged") fail("invalid-response");
  const draft =
    item.draft === true ||
    item.work_in_progress === true ||
    (typeof item.title === "string" && /^(?:Draft:|WIP:)/u.test(item.title));
  const sourceBranch = safeString(item.source_branch, 200);
  const targetBranch = safeString(item.target_branch, 200);
  const headRevision = safeString(item.sha, 64);
  const sourceProjectId = item.source_project_id;
  const targetProjectId = item.target_project_id;
  const title = safeString(item.title, 256);
  const description = safeMultiline(item.description, 8_192);
  if (
    sourceBranch !== expected.sourceBranch ||
    !SAFE_REVISION.test(headRevision) ||
    sourceProjectId !== expected.projectId ||
    targetProjectId !== expected.projectId
  ) {
    fail("invalid-response");
  }
  return Object.freeze({
    iid: iid as number,
    url: `https://${expected.host}/${expected.path}/-/merge_requests/${iid as number}`,
    state,
    draft,
    sourceBranch,
    targetBranch,
    headRevision,
    sourceProjectId,
    targetProjectId,
    title,
    description,
  });
}

function branchMatches(pattern: string, branch: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "u").test(branch);
}

function projectAccessLevel(value: unknown): number {
  if (value === null) return 0;
  const access = object(value).access_level;
  if (
    !Number.isSafeInteger(access) ||
    (access as number) < 0 ||
    (access as number) > MAX_ACCESS_LEVEL
  )
    fail("invalid-response");
  return access as number;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("invalid-response");
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 100) fail("invalid-response");
  return value;
}

function safeString(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.includes("\0") ||
    value.includes("\r") ||
    value.includes("\n") ||
    unsafe(value)
  ) {
    fail("invalid-response");
  }
  return value;
}

function safeMultiline(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.includes("\0") ||
    value.includes("\r") ||
    /[\x01-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(value) ||
    unsafe(value)
  ) {
    fail("invalid-response");
  }
  return value;
}

/**
 * Whether GitLab text carries DocsFab's own configured credential, which
 * refuses (#1807). Text that only looks like a credential continues and is
 * recorded as a `credential-like-content` finding at `gitlab`.
 */
function unsafe(value: string): boolean {
  return containsConfiguredCredentialText(value, "gitlab");
}

function egress(value: string, roots: HostRootSet): string {
  const result = egressText(value, roots);
  if (!result.ok) fail("invalid-response");
  return result.text;
}

function metadataBindsPlan(
  plan: LocalUserPublicationPlan,
  metadata: DocsFabPublicationMetadata,
): boolean {
  const base = buildDocsFabPublicationProvenanceMarker(plan);
  if (metadata.mergeRequestCompositionMarker === undefined) {
    return (
      metadata.mergeRequestCompositionWarning === undefined &&
      metadata.mergeRequestProvenanceMarker === base
    );
  }
  const aggregate = /\baggregate=([a-f0-9]{64})\b/u.exec(
    metadata.mergeRequestCompositionMarker,
  )?.[1];
  return (
    aggregate !== undefined &&
    metadata.mergeRequestCompositionWarning !== undefined &&
    metadata.mergeRequestProvenanceMarker === `${base.slice(0, -4)} execution=${aggregate} -->`
  );
}

function isCanonicalDocsFabDraftTitle(
  value: string,
  operatorUsername: string,
  execution: boolean,
): boolean {
  const prefix = execution ? "Draft: [DocsFab] " : "Draft: [DocsFab Run] ";
  if (typeof value !== "string" || !value.startsWith(prefix)) return false;
  const summary = value.slice(prefix.length);
  const identityTokens = summary.toLocaleLowerCase("en-US").split(/[^a-z0-9._-]+/u);
  return (
    value === value.normalize("NFC") &&
    [...value].length <= 120 &&
    summary.length > 0 &&
    summary.trim() === summary &&
    !/\p{White_Space}{2,}/u.test(summary) &&
    (execution
      ? summary.startsWith(COMPOSITION_TITLE_PREFIX) &&
        summary.length > COMPOSITION_TITLE_PREFIX.length
      : !/^(?:(?:Draft|WIP)\s*:|\[|DocsFab\s*:)/iu.test(summary)) &&
    !/[<>\[\]()`!#*_~\\]/u.test(withoutEgressPlaceholders(summary)) &&
    !/\b(?:codex|chatgpt|openai|gpt(?:-[a-z0-9.]+)?|claude|anthropic|gemini|copilot)\b/iu.test(
      summary,
    ) &&
    !identityTokens.includes(operatorUsername.toLocaleLowerCase("en-US")) &&
    value.split(execution ? "[DocsFab]" : "[DocsFab Run]").length === 2 &&
    !/[\0\r\n\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(value) &&
    !unsafe(value)
  );
}

function isSafeMergeRequestDescription(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 8_192 &&
    !value.includes("\0") &&
    !value.includes("\r") &&
    !/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(value) &&
    !unsafe(value)
  );
}

function fail(code: GitLabPublisherAdapterErrorCode): never {
  throw new GitLabPublisherAdapterError(code);
}
