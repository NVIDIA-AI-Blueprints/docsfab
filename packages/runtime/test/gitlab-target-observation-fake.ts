// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic git/glab seam for the shared GitLab target observation.
 *
 * The doctor draft-MR readiness path drives the real
 * `observeLocalUserGitLabTarget` and `planLocalUserPublicationFreshness`, so
 * tests fake the commands rather than the resolution. Every response here is a
 * plausible real payload; nothing short-circuits the resolver.
 */
import type { ReadOnlyCommandResult, ReadOnlyCommandRunner } from "../src/delivery/preflight.js";

/** Strip the hardened `-c key=value` prefix pairs the publication path passes. */
export function withoutGitConfigFlags(args: readonly string[]): readonly string[] {
  let index = 0;
  while (args[index] === "-c" && typeof args[index + 1] === "string") index += 2;
  return args.slice(index);
}

export interface GitLabTargetFixture {
  readonly host: string;
  readonly projectPath: string;
  readonly projectId: number;
  readonly branch: string;
  readonly revision: string;
  /**
   * Operator access on the project. DocsFab needs at least
   * `LOCAL_USER_MINIMUM_PUSH_ACCESS_LEVEL` (30, Developer) to push a source
   * branch, so a fixture must be able to express a non-publishable operator.
   */
  readonly accessLevel?: number;
}

/**
 * Responses for the observation steps that doctor's own checks do not already
 * answer. Returns undefined for every other key so callers keep their defaults.
 */
export function observeGitLabTargetResponse(
  key: string,
  fixture: GitLabTargetFixture,
): { exitCode: number; stdout: string } | undefined {
  switch (key) {
    case "git rev-parse --is-inside-work-tree":
      return { exitCode: 0, stdout: "true\n" };
    case "git config --local --null --list":
      return { exitCode: 0, stdout: "" };
    case "git config --includes --show-origin --null --list":
      return { exitCode: 0, stdout: "" };
    case "git rev-parse --verify --end-of-options HEAD^{commit}":
      return { exitCode: 0, stdout: `${fixture.revision}\n` };
    case "git remote":
      return { exitCode: 0, stdout: "origin\n" };
    case "git remote get-url --push --all origin":
      return {
        exitCode: 0,
        stdout: `https://${fixture.host}/${fixture.projectPath}.git\n`,
      };
    case "glab version":
      return { exitCode: 0, stdout: "glab 1.0\n" };
    default:
      break;
  }
  if (key.startsWith(`glab api --hostname ${fixture.host} `)) {
    return { exitCode: 0, stdout: gitLabApiBody(key, fixture) };
  }
  return undefined;
}

function gitLabApiBody(key: string, fixture: GitLabTargetFixture): string {
  const endpoint = key.slice(`glab api --hostname ${fixture.host} `.length);
  if (endpoint.startsWith("graphql")) {
    return `${JSON.stringify({
      data: {
        project: {
          id: `gid://gitlab/Project/${fixture.projectId}`,
          fullPath: fixture.projectPath,
        },
      },
    })}\n`;
  }
  if (endpoint === `projects/${fixture.projectId}`) {
    return `${JSON.stringify({
      id: fixture.projectId,
      path_with_namespace: fixture.projectPath,
      default_branch: fixture.branch,
      permissions: {
        project_access: { access_level: fixture.accessLevel ?? 40 },
        group_access: null,
      },
    })}\n`;
  }
  return `${JSON.stringify({
    name: fixture.branch,
    protected: true,
    commit: { id: fixture.revision },
  })}\n`;
}

export interface DraftMrSeamFixture {
  readonly repositoryPath: string;
  readonly host: string;
  readonly projectPath: string;
  readonly projectId: number;
  readonly headBranch: string;
  readonly headRevision: string;
  readonly targetBranch: string;
  readonly targetRevision: string;
  /** Operator access on the project; below 30 the operator cannot push. */
  readonly accessLevel?: number;
  /** Local object database holds the observed GitLab target commit. */
  readonly targetObjectLocal?: boolean;
  /** `git merge-base --is-ancestor <head> <target>` succeeds. */
  readonly targetContainsHead?: boolean;
  /** `git merge-base --is-ancestor <target> <head>` succeeds. */
  readonly headContainsTarget?: boolean;
  readonly remote?: "present" | "missing";
  /** `git config --includes --show-origin --null --list`: the effective Git configuration with origins. */
  readonly effectiveConfig?: string;
  readonly glab?: "present" | "missing";
  readonly auth?: "ok" | "unauthenticated";
  readonly api?: "ok" | "unreachable";
}

/**
 * Full read-only seam for the draft-MR readiness scenarios. One fixture yields
 * one observable repository; divergent branch and commit identities make a
 * swapped structured field impossible to pass.
 */
export class DraftMrSeamCommands implements ReadOnlyCommandRunner {
  readonly calls: string[] = [];

  constructor(private readonly fixture: DraftMrSeamFixture) {}

  async run(
    command: "git" | "glab" | "gh",
    args: readonly string[],
    _cwd: string,
  ): Promise<ReadOnlyCommandResult> {
    if (command === "gh") throw new Error("GitLab fixture does not support gh.");
    const key = `${command} ${withoutGitConfigFlags(args).join(" ")}`;
    this.calls.push(key);
    const result = this.respond(key);
    return { stderr: "", ...result };
  }

  private respond(key: string): ReadOnlyCommandResult {
    const fixture = this.fixture;
    const url = `https://${fixture.host}/${fixture.projectPath}.git\n`;
    const fail = { exitCode: 1, stdout: "", stderr: "" };
    switch (key) {
      // Doctor's own repository checks.
      case "git --version":
        return ok("git version 2.50.0\n");
      case "git rev-parse --verify HEAD^{commit}":
        return ok(`${fixture.headRevision}\n`);
      case `git cat-file -e ${fixture.headRevision}^{commit}`:
        return ok("");
      case "git config --get user.name":
        return ok("Operator\n");
      case "git config --get user.email":
        return ok("operator@example.test\n");
      case "git ls-tree --name-only HEAD -- .docsfab.json":
        return ok(".docsfab.json\n");
      case "git status --porcelain=v1 --untracked-files=all":
        return ok("");
      case "glab --version":
        return fixture.glab === "missing" ? fail : ok("glab 1.0\n");
      // Shared GitLab target observation.
      case "git rev-parse --is-inside-work-tree":
        return ok("true\n");
      case "git rev-parse --show-toplevel":
        return ok(`${fixture.repositoryPath}\n`);
      case "git config --local --null --list":
        return ok("");
      case "git config --includes --show-origin --null --list":
        return ok(fixture.effectiveConfig ?? "");
      case "git symbolic-ref --quiet --short HEAD":
        return ok(`${fixture.headBranch}\n`);
      case "git rev-parse --verify --end-of-options HEAD^{commit}":
        return ok(`${fixture.headRevision}\n`);
      case "git remote":
        return fixture.remote === "missing" ? ok("") : ok("origin\n");
      case "git remote get-url --all origin":
      case "git remote get-url --push --all origin":
        return fixture.remote === "missing" ? fail : ok(url);
      case "glab version":
        return fixture.glab === "missing" ? fail : ok("glab 1.0\n");
      case `glab auth status --hostname ${fixture.host}`:
        return fixture.auth === "unauthenticated"
          ? { exitCode: 1, stdout: "", stderr: "not logged in to gitlab\n" }
          : ok("");
      case `glab config get token --host ${fixture.host}`:
        return ok("");
      case `git cat-file -e ${fixture.targetRevision}^{commit}`:
        return fixture.targetObjectLocal === false ? fail : ok("");
      case `git merge-base --is-ancestor ${fixture.headRevision} ${fixture.targetRevision}`:
        return fixture.targetContainsHead ? ok("") : fail;
      case `git merge-base --is-ancestor ${fixture.targetRevision} ${fixture.headRevision}`:
        return fixture.headContainsTarget ? ok("") : fail;
      default:
        break;
    }
    if (key.startsWith(`glab api --hostname ${fixture.host} `)) {
      if (fixture.api === "unreachable") {
        return { exitCode: 1, stdout: "", stderr: "dial tcp: i/o timeout\n" };
      }
      return ok(
        gitLabApiBody(key, {
          host: fixture.host,
          projectPath: fixture.projectPath,
          projectId: fixture.projectId,
          branch: fixture.targetBranch,
          revision: fixture.targetRevision,
          ...(fixture.accessLevel === undefined ? {} : { accessLevel: fixture.accessLevel }),
        }),
      );
    }
    return fail;
  }
}

function ok(stdout: string): ReadOnlyCommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}
