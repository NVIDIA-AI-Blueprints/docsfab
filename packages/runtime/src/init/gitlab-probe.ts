// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * GitLab / repository probe seam for DocsFab init.
 */
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { realpath } from "node:fs/promises";

import { LOCAL_USER_MINIMUM_PUSH_ACCESS_LEVEL } from "../delivery/contracts.js";
import {
  classifyGlabCommandFailure,
  tokenProbeFromExitCode,
} from "../delivery/glab-auth-diagnosis.js";
import { parseGitLabRemote } from "../delivery/preflight.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import { rejectSituation } from "../operator/situation-catalog.js";
import {
  SAFE_USERNAME,
  type CommandRunner,
  type DocsFabInitPrompt,
  type RemoteCandidate,
  type RepositoryApprovalIdentity,
  type RepositoryDiscovery,
} from "./types.js";
import {
  accessLevel,
  assertCredentialFree,
  assertSafeRemoteName,
  configuredRemotePreference,
  credentialFree,
  currentUid,
  git,
  gitLabEnvironment,
  jsonObject,
  positiveSafeInteger,
  safeBranch,
  safeJson,
} from "./shared.js";

export async function discoverRepository(
  path: string,
  commands: CommandRunner,
): Promise<RepositoryDiscovery> {
  let candidate: string;
  try {
    candidate = await realpath(resolve(path));
  } catch {
    throw new Error("The selected repository directory is unavailable.");
  }
  const top = await git(commands, candidate, ["rev-parse", "--show-toplevel"]);
  if (top.exitCode !== 0 || !top.stdout.trim())
    throw new Error("Run `docsfab init` inside an existing Git repository.");
  let repositoryPath: string;
  try {
    repositoryPath = await realpath(top.stdout.trim());
  } catch {
    throw new Error("Git returned an unavailable repository root.");
  }
  const inside = await git(commands, repositoryPath, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.exitCode !== 0 || inside.stdout.trim() !== "true")
    throw new Error("Run `docsfab init` inside an existing Git worktree.");
  const names = await git(commands, repositoryPath, ["remote"]);
  if (names.exitCode !== 0) throw new Error("Git remotes could not be inspected.");
  const remoteNames = names.stdout.split(/\r?\n/u).filter(Boolean);
  if (new Set(remoteNames).size !== remoteNames.length)
    throw new Error("Git remote names are ambiguous or unsafe.");
  for (const name of remoteNames)
    assertSafeRemoteName(name, "Git remote names are ambiguous or unsafe.");
  const candidates: RemoteCandidate[] = [];
  for (const name of remoteNames) {
    const [fetchResult, pushResult] = await Promise.all([
      git(commands, repositoryPath, ["remote", "get-url", "--all", name]),
      git(commands, repositoryPath, ["remote", "get-url", "--push", "--all", name]),
    ]);
    const fetchUrls = fetchResult.stdout.split(/\r?\n/u).filter(Boolean);
    const pushUrls = pushResult.stdout.split(/\r?\n/u).filter(Boolean);
    if (
      fetchResult.exitCode !== 0 ||
      pushResult.exitCode !== 0 ||
      fetchUrls.length !== 1 ||
      pushUrls.length !== 1
    )
      continue;
    try {
      const fetch = parseGitLabRemote(fetchUrls[0]!);
      const push = parseGitLabRemote(pushUrls[0]!);
      if (fetch.host !== push.host || fetch.projectPath !== push.projectPath) continue;
      candidates.push({
        name,
        host: fetch.host,
        projectPath: fetch.projectPath,
      });
    } catch {
      // Unsupported, ambiguous, or credential-bearing remotes are never candidates.
    }
  }
  const branchResult = await git(commands, repositoryPath, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  let trackingRemote: string | undefined;
  if (branchResult.exitCode === 0 && branchResult.stdout.trim()) {
    const branch = branchResult.stdout.trim();
    if (!safeBranch(branch)) throw new Error("The current Git branch identity is unsafe.");
    const tracking = await git(commands, repositoryPath, [
      "config",
      "--get",
      `branch.${branch}.remote`,
    ]);
    trackingRemote = configuredRemotePreference(tracking, remoteNames, "tracking remote");
  }
  const pushDefaultResult = await git(commands, repositoryPath, [
    "config",
    "--get",
    "remote.pushDefault",
  ]);
  const pushDefault = configuredRemotePreference(
    pushDefaultResult,
    remoteNames,
    "push-default remote",
  );
  return {
    path: repositoryPath,
    candidates,
    ...(trackingRemote ? { trackingRemote } : {}),
    ...(pushDefault ? { pushDefault } : {}),
  };
}

export async function selectCanonicalRemote(
  repository: RepositoryDiscovery,
  requested: string | undefined,
  interactive: boolean,
  prompt: DocsFabInitPrompt,
): Promise<RemoteCandidate> {
  if (repository.candidates.length === 0) {
    rejectSituation(
      "no-supported-gitlab-remote",
      "No supported uncredentialed GitLab remote is available for this operation.",
    );
  }
  const preferred = requested ?? repository.trackingRemote ?? repository.pushDefault;
  if (preferred) {
    const selected = repository.candidates.find((candidate) => candidate.name === preferred);
    if (!selected)
      throw new Error(
        "The canonical Git remote is not one supported uncredentialed GitLab remote.",
      );
    return selected;
  }
  if (repository.candidates.length === 1) return repository.candidates[0]!;
  if (!interactive)
    throw new Error("More than one GitLab remote was found. Re-run with --remote <name>.");
  const chosen = await prompt.chooseRemote(repository.candidates.map((entry) => entry.name));
  assertSafeRemoteName(chosen, "Choose one of the discovered GitLab remote names.");
  const selected = repository.candidates.find((candidate) => candidate.name === chosen);
  if (!selected) throw new Error("Choose one of the discovered GitLab remote names.");
  return selected;
}

export async function captureRepositoryApprovalIdentity(
  repositoryPath: string,
  selected: RemoteCandidate,
  defaultBranch: string,
  commands: CommandRunner,
): Promise<RepositoryApprovalIdentity> {
  const [revisionResult, objectFormatResult, metadata] = await Promise.all([
    git(commands, repositoryPath, ["rev-parse", "--verify", "HEAD"]),
    git(commands, repositoryPath, ["rev-parse", "--show-object-format"]),
    lstat(repositoryPath),
  ]);
  const revision = revisionResult.stdout.trim();
  const objectFormat = objectFormatResult.stdout.trim();
  if (
    revisionResult.exitCode !== 0 ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(revision) ||
    objectFormatResult.exitCode !== 0 ||
    !/^(?:sha1|sha256)$/u.test(objectFormat) ||
    (objectFormat === "sha1" ? revision.length !== 40 : revision.length !== 64) ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== currentUid()
  ) {
    throw new Error("The repository identity could not be bound to one safe revision.");
  }
  const material = {
    remote: selected.name,
    host: selected.host,
    projectPath: selected.projectPath,
    defaultBranch,
    revision,
    objectFormat,
    repositoryObject: {
      dev: metadata.dev,
      ino: metadata.ino,
      uid: metadata.uid,
    },
  } as const;
  assertCredentialFree(material, "Repository identity contained forbidden credential material.");
  return {
    sha256: createHash("sha256")
      .update(canonicalizeJsonEvidence(material as unknown as JsonEvidenceValue))
      .digest("hex"),
  };
}

export async function inspectGitLab(
  cwd: string,
  selected: RemoteCandidate,
  commands: CommandRunner,
  environment: NodeJS.ProcessEnv,
): Promise<{
  authentication: "configured" | "missing" | "unreachable";
  project: "ready" | "unavailable";
  bindingSha256: string | null;
  defaultBranch: string;
}> {
  const glabEnv = gitLabEnvironment(environment);
  const version = await commands.run("glab", ["version"], cwd, {
    env: glabEnv,
  });
  const auth =
    version.exitCode === 0
      ? await commands.run("glab", ["auth", "status", "--hostname", selected.host], cwd, {
          env: glabEnv,
        })
      : { exitCode: 1, stdout: "", stderr: "" };
  let authentication: "configured" | "missing" | "unreachable" =
    auth.exitCode === 0 ? "configured" : "missing";
  if (authentication === "missing" && version.exitCode === 0) {
    const probe = await commands.run(
      "glab",
      ["config", "get", "token", "--host", selected.host],
      cwd,
      { env: glabEnv },
    );
    const cls = classifyGlabCommandFailure({
      kind: "auth-status",
      exitCode: auth.exitCode,
      stdout: auth.stdout,
      stderr: auth.stderr,
      tokenProbe: tokenProbeFromExitCode(probe.exitCode),
    });
    if (cls === "unreachable") authentication = "unreachable";
  }
  let defaultBranch: string | undefined;
  let projectReady = false;
  let bindingSha256: string | null = null;
  if (authentication === "configured") {
    const [identityResult, projectResult] = await Promise.all([
      commands.run("glab", ["api", "--hostname", selected.host, "user"], cwd, {
        env: glabEnv,
      }),
      commands.run(
        "glab",
        [
          "api",
          "--hostname",
          selected.host,
          `projects/${encodeURIComponent(selected.projectPath)}`,
        ],
        cwd,
        { env: glabEnv },
      ),
    ]);
    const identityClass =
      identityResult.exitCode === 0
        ? "ok"
        : classifyGlabCommandFailure({
            kind: "api",
            exitCode: identityResult.exitCode,
            stdout: identityResult.stdout,
            stderr: identityResult.stderr,
          });
    if (identityClass === "unreachable") authentication = "unreachable";
    const identity = safeJson(identityResult);
    const project = safeJson(projectResult);
    const identityObject = jsonObject(identity);
    const projectObject = jsonObject(project);
    const permissions = jsonObject(projectObject?.permissions);
    if (
      projectObject &&
      typeof projectObject.default_branch === "string" &&
      !credentialFree(projectObject.default_branch)
    ) {
      throw new Error("GitLab returned an unsafe default branch identity.");
    }
    const userId =
      identityObject &&
      positiveSafeInteger(identityObject.id) &&
      typeof identityObject.username === "string" &&
      SAFE_USERNAME.test(identityObject.username) &&
      credentialFree(identityObject.username)
        ? identityObject.id
        : undefined;
    const access = permissions
      ? Math.max(accessLevel(permissions.project_access), accessLevel(permissions.group_access))
      : 0;
    if (
      projectObject &&
      projectObject.path_with_namespace === selected.projectPath &&
      positiveSafeInteger(projectObject.id) &&
      typeof projectObject.default_branch === "string" &&
      safeBranch(projectObject.default_branch)
    ) {
      assertCredentialFree(
        projectObject.default_branch,
        "GitLab returned an unsafe default branch identity.",
      );
      defaultBranch = projectObject.default_branch;
      if (userId !== undefined && access >= LOCAL_USER_MINIMUM_PUSH_ACCESS_LEVEL) {
        projectReady = true;
        bindingSha256 = createHash("sha256")
          .update(
            canonicalizeJsonEvidence({
              host: selected.host,
              projectId: projectObject.id,
              projectPath: selected.projectPath,
              userId,
              access,
            } as unknown as JsonEvidenceValue),
          )
          .digest("hex");
      }
    }
  }
  if (!defaultBranch) {
    const local = await git(commands, cwd, [
      "symbolic-ref",
      "--quiet",
      "--short",
      `refs/remotes/${selected.name}/HEAD`,
    ]);
    const prefix = `${selected.name}/`;
    const value = local.stdout.trim();
    if (
      local.exitCode === 0 &&
      value.startsWith(prefix) &&
      !credentialFree(value.slice(prefix.length))
    ) {
      throw new Error("Git returned an unsafe default branch identity.");
    }
    if (
      local.exitCode === 0 &&
      value.startsWith(prefix) &&
      safeBranch(value.slice(prefix.length))
    ) {
      defaultBranch = value.slice(prefix.length);
      assertCredentialFree(defaultBranch, "Git returned an unsafe default branch identity.");
    }
  }
  if (!defaultBranch)
    throw new Error(
      "The GitLab default branch could not be discovered. Authenticate glab or set the remote HEAD.",
    );
  return {
    authentication,
    project: projectReady ? "ready" : "unavailable",
    bindingSha256,
    defaultBranch,
  };
}
