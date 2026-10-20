// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Documentation maturity cascade — host tracker observation layer.
 * Resolves repository, project, transport, credentials, and time for selection.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import { types as nodeUtilTypes } from "node:util";
import { promisify } from "node:util";

import { sanitizeGitLabIssue } from "../../roadmap/gitlab-readonly.js";
import {
  internalDocumentationMaturityTrackerSnapshotState,
  type InternalDocumentationMaturityTrackerSnapshot,
} from "../tracker-snapshot-authority-internal.js";
import type { RoadmapProjectIdentity } from "../../roadmap/contracts/ledger.js";
import type { SanitizedRoadmapIssue } from "../../roadmap/planning.js";
import { verifyActiveRepositoryWorkspace } from "../../repository/workspace/tracked-read.js";
import type { RepositoryWorkspace } from "../../repository/workspace/contracts.js";
import type { DocumentationMaturityRepositoryBindingV1 } from "../contracts.js";
import {
  MAXIMUM_GITLAB_ELAPSED_MS,
  MAXIMUM_GITLAB_ISSUE_PAGE_BYTES,
  MAXIMUM_GITLAB_METADATA_BYTES,
  MAXIMUM_GITLAB_PAGES,
  MAXIMUM_GITLAB_TOTAL_BYTES,
  MAXIMUM_TRACKER_ISSUES,
  TRACKER_OBSERVATION_LIFETIME_MS,
  authenticAssessments,
  authenticTrackerObservations,
  canonicalDigest,
  decodeDocumentationMaturityCascadeAssessment,
  deepFreeze,
  DocumentationMaturityCascadeError,
  boundedInteger,
  denseArray,
  exactShallow,
  fail,
  normalizeTrackerIssues,
  type AuthenticTrackerObservationState,
  type DocumentationMaturityCascadeAssessmentV1,
  type DocumentationMaturityCascadeErrorCode,
  type DocumentationMaturityCascadeTrackerObservationV1,
} from "./dialect.js";
import { isDnsHostname } from "../../shared/dns-hostname.js";

const hostExecFile = promisify(execFile);
const hostMonotonicNow = performance.now.bind(performance);
const hostTimeOrigin = performance.timeOrigin;
const GITLAB_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/u;
const hostProjectConfiguration = snapshotHostGitLabConfiguration(process.env);
const hostGlabExecutable = snapshotHostGlabExecutable(process.env);
const hostGlabEnvironment = Object.freeze({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
  ...(process.env.XDG_CONFIG_HOME === undefined
    ? {}
    : {
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      }),
  ...(process.env.GLAB_CONFIG_DIR === undefined
    ? {}
    : {
        GLAB_CONFIG_DIR: process.env.GLAB_CONFIG_DIR,
      }),
  ...(process.env.GITLAB_TOKEN === undefined ? {} : { GITLAB_TOKEN: process.env.GITLAB_TOKEN }),
  ...(process.env.PRIVATE_TOKEN === undefined ? {} : { PRIVATE_TOKEN: process.env.PRIVATE_TOKEN }),
  LANG: "C",
  LC_ALL: "C",
});

/**
 * Host observation boundary. Repository, project, transport, credentials, and
 * time are resolved here; none can be supplied by the workflow caller.
 */
export async function observeDocumentationMaturityCascadeTracker(inputValue: {
  assessment: DocumentationMaturityCascadeAssessmentV1;
  workspace: RepositoryWorkspace;
}): Promise<DocumentationMaturityCascadeTrackerObservationV1> {
  const input = exactShallow(inputValue, ["assessment", "workspace"], "invalid-input");
  const assessmentValue = input.assessment;
  const assessmentState =
    assessmentValue && typeof assessmentValue === "object"
      ? authenticAssessments.get(assessmentValue)
      : undefined;
  if (!assessmentState) fail("invalid-assessment");
  const authenticAssessment = assessmentValue as DocumentationMaturityCascadeAssessmentV1;
  const assessment = decodeDocumentationMaturityCascadeAssessment(assessmentValue);
  const workspace = await verifyBoundWorkspace(
    input.workspace,
    assessment.repository,
    assessmentState.sourcePath,
    "invalid-tracker-observation",
  );
  const observationBudget = { startedAt: hostMonotonicNow(), bytes: 0 };
  const project = await resolveBoundGitLabProject(
    assessmentState.sourcePath,
    assessment.repository.revision,
    observationBudget,
  );
  await verifyBoundWorkspace(
    workspace,
    assessment.repository,
    assessmentState.sourcePath,
    "invalid-tracker-observation",
  );
  let issues: SanitizedRoadmapIssue[];
  try {
    issues = normalizeTrackerIssues(await observeBoundGitLabIssues(project, observationBudget));
  } catch {
    fail("invalid-tracker-observation");
  }
  await verifyBoundWorkspace(
    workspace,
    assessment.repository,
    assessmentState.sourcePath,
    "invalid-tracker-observation",
  );
  const observedAtMonotonicMs = hostMonotonicNow();
  const observedAtEpochMs = hostTimeOrigin + observedAtMonotonicMs;
  if (!Number.isFinite(observedAtEpochMs) || !Number.isFinite(observedAtMonotonicMs)) {
    fail("invalid-tracker-observation");
  }
  const observedAt = new Date(observedAtEpochMs).toISOString();
  const expiresAtEpochMs = observedAtEpochMs + TRACKER_OBSERVATION_LIFETIME_MS;
  const expiresAt = new Date(expiresAtEpochMs).toISOString();
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-documentation-maturity-cascade-tracker-observation" as const,
    repository: assessment.repository,
    projectSha256: canonicalDigest(project),
    observedAt,
    expiresAt,
    issues,
  };
  const observation = deepFreeze({ ...body, observationSha256: canonicalDigest(body) });
  authenticTrackerObservations.set(observation, {
    assessment: authenticAssessment,
    assessmentSha256: assessment.assessmentSha256,
    assessmentRepository: assessment.repository,
    workspace,
    project,
    observedAtEpochMs,
    expiresAtEpochMs,
    observedAtMonotonicMs,
    expiresAtMonotonicMs: observedAtMonotonicMs + TRACKER_OBSERVATION_LIFETIME_MS,
    snapshot: observation,
  });
  return observation;
}

/**
 * Production auto-mode bridge for a single host-authenticated GitLab issue
 * snapshot. The opaque source is minted only by the GET-only GitLab reader.
 */
export async function observeDocumentationMaturityCascadeTrackerFromHostSnapshot(inputValue: {
  assessment: DocumentationMaturityCascadeAssessmentV1;
  workspace: RepositoryWorkspace;
  source: InternalDocumentationMaturityTrackerSnapshot;
}): Promise<DocumentationMaturityCascadeTrackerObservationV1> {
  const input = exactShallow(inputValue, ["assessment", "workspace", "source"], "invalid-input");
  const assessmentValue = input.assessment;
  const assessmentState =
    assessmentValue && typeof assessmentValue === "object"
      ? authenticAssessments.get(assessmentValue)
      : undefined;
  const sourceState =
    input.source && typeof input.source === "object"
      ? internalDocumentationMaturityTrackerSnapshotState(
          input.source as InternalDocumentationMaturityTrackerSnapshot,
        )
      : undefined;
  if (!assessmentState) fail("invalid-assessment");
  if (!sourceState) fail("invalid-tracker-observation");
  const authenticAssessment = assessmentValue as DocumentationMaturityCascadeAssessmentV1;
  const assessment = decodeDocumentationMaturityCascadeAssessment(assessmentValue);
  const workspace = await verifyBoundWorkspace(
    input.workspace,
    assessment.repository,
    assessmentState.sourcePath,
    "invalid-tracker-observation",
  );
  const observedAtMonotonicMs = sourceState.observedAtMonotonicMs;
  const observedAtEpochMs = sourceState.observedAtEpochMs;
  const now = hostMonotonicNow();
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(observedAtEpochMs) ||
    !Number.isFinite(observedAtMonotonicMs) ||
    now < observedAtMonotonicMs ||
    now >= observedAtMonotonicMs + TRACKER_OBSERVATION_LIFETIME_MS
  ) {
    fail("invalid-tracker-observation");
  }
  const observedAt = new Date(observedAtEpochMs).toISOString();
  const expiresAtEpochMs = observedAtEpochMs + TRACKER_OBSERVATION_LIFETIME_MS;
  const issues = normalizeTrackerIssues(sourceState.issues);
  const project = sourceState.project;
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-documentation-maturity-cascade-tracker-observation" as const,
    repository: assessment.repository,
    projectSha256: canonicalDigest(project),
    observedAt,
    expiresAt: new Date(expiresAtEpochMs).toISOString(),
    issues,
  };
  const observation = deepFreeze({ ...body, observationSha256: canonicalDigest(body) });
  authenticTrackerObservations.set(observation, {
    assessment: authenticAssessment,
    assessmentSha256: assessment.assessmentSha256,
    assessmentRepository: assessment.repository,
    workspace,
    project,
    observedAtEpochMs,
    expiresAtEpochMs,
    observedAtMonotonicMs,
    expiresAtMonotonicMs: observedAtMonotonicMs + TRACKER_OBSERVATION_LIFETIME_MS,
    snapshot: observation,
  });
  return observation;
}

export async function verifyBoundWorkspace(
  workspaceValue: unknown,
  repository: DocumentationMaturityRepositoryBindingV1,
  sourcePath: string,
  code: DocumentationMaturityCascadeErrorCode,
): Promise<RepositoryWorkspace> {
  let workspace: RepositoryWorkspace;
  try {
    workspace = await verifyActiveRepositoryWorkspace(workspaceValue);
  } catch {
    fail(code);
  }
  if (
    workspace.sourcePath !== sourcePath ||
    workspace.revision !== repository.revision ||
    createHash("sha256").update(workspace.sourcePath).digest("hex") !== repository.identitySha256
  ) {
    fail("repository-mismatch");
  }
  return workspace;
}

export interface HostGitLabConfiguration {
  host: string;
  fullPath: string;
  projectId: number;
  sshPort: number;
}

export interface HostExecutableIdentity {
  path: string;
  dev: number;
  ino: number;
  uid: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface HostObservationBudget {
  startedAt: number;
  bytes: number;
}

export async function resolveBoundGitLabProject(
  sourcePath: string,
  revision: string,
  budget: HostObservationBudget = { startedAt: hostMonotonicNow(), bytes: 0 },
): Promise<RoadmapProjectIdentity> {
  const configuration = hostProjectConfiguration;
  if (!configuration) fail("invalid-tracker-observation");
  let stdout: string;
  try {
    ({ stdout } = await hostExecFile(
      "/usr/bin/git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.attributesFile=/dev/null",
        "-c",
        "core.excludesFile=/dev/null",
        "-C",
        sourcePath,
        "remote",
        "-v",
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: "/dev/null",
          XDG_CONFIG_HOME: "/dev/null",
          LANG: "C",
          LC_ALL: "C",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "/usr/bin/false",
        },
      },
    ));
  } catch {
    fail("invalid-tracker-observation");
  }
  const bindings = new Map<string, NonNullable<ReturnType<typeof parseGitLabRemote>>>();
  for (const line of stdout.split("\n")) {
    const match = /^\S+\s+(\S+)\s+\(fetch\)$/u.exec(line);
    if (!match) continue;
    const binding = parseGitLabRemote(match[1]!);
    if (binding)
      bindings.set(
        `${binding.host}/${binding.fullPath}/${binding.transport}/${binding.sshPort ?? "https"}`,
        binding,
      );
  }
  if (bindings.size !== 1) fail("invalid-tracker-observation");
  const binding = [...bindings.values()][0]!;
  if (
    binding.host !== configuration.host ||
    binding.fullPath !== configuration.fullPath ||
    (binding.transport === "ssh" && binding.sshPort !== configuration.sshPort)
  ) {
    fail("repository-mismatch");
  }
  const metadata = (
    await runBoundedGlabJson(
      `projects/${encodeURIComponent(configuration.fullPath)}`,
      MAXIMUM_GITLAB_METADATA_BYTES,
      budget,
    )
  ).value;
  const project = snapshotGitLabProjectMetadata(metadata, configuration);
  const commit = (
    await runBoundedGlabJson(
      `projects/${configuration.projectId}/repository/commits/${revision}`,
      MAXIMUM_GITLAB_METADATA_BYTES,
      budget,
    )
  ).value;
  assertGitLabCommitRevision(commit, revision);
  return deepFreeze(project);
}

export function parseGitLabRemote(value: string): {
  host: string;
  fullPath: string;
  transport: "https" | "ssh";
  sshPort: number | null;
} | null {
  let host: string;
  let path: string;
  let transport: "https" | "ssh";
  let sshPort: number | null;
  const scp = /^git@([^:/]+):(.+)$/u.exec(value);
  if (scp) {
    host = scp[1]!;
    path = scp[2]!;
    transport = "ssh";
    sshPort = 22;
  } else {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return null;
    }
    const validPort =
      parsed.port === "" ||
      (parsed.protocol === "ssh:" &&
        /^[1-9][0-9]{0,4}$/u.test(parsed.port) &&
        Number(parsed.port) <= 65_535);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") ||
      !validPort ||
      parsed.search ||
      parsed.hash ||
      (parsed.username && parsed.username !== "git") ||
      parsed.password
    ) {
      return null;
    }
    host = parsed.hostname;
    path = parsed.pathname.replace(/^\//u, "");
    transport = parsed.protocol === "ssh:" ? "ssh" : "https";
    sshPort = transport === "ssh" ? Number(parsed.port || "22") : null;
  }
  const fullPath = path.endsWith(".git") ? path.slice(0, -4) : path;
  if (!isDnsHostname(host) || !GITLAB_PATH.test(fullPath)) return null;
  return { host, fullPath, transport, sshPort };
}

export function snapshotGitLabProjectMetadata(
  value: unknown,
  configuration: HostGitLabConfiguration,
): RoadmapProjectIdentity {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail("invalid-tracker-observation");
  const keys = Reflect.ownKeys(value);
  if (keys.length > 256 || keys.some((key) => typeof key !== "string")) {
    fail("invalid-tracker-observation");
  }
  const read = (key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
      fail("invalid-tracker-observation");
    }
    return descriptor.value;
  };
  const id = boundedInteger(read("id"), 1, Number.MAX_SAFE_INTEGER, "invalid-tracker-observation");
  const fullPath = read("path_with_namespace");
  const webUrl = read("web_url");
  if (
    id !== configuration.projectId ||
    fullPath !== configuration.fullPath ||
    webUrl !== `https://${configuration.host}/${configuration.fullPath}`
  ) {
    fail("repository-mismatch");
  }
  return {
    provider: "gitlab",
    host: configuration.host,
    fullPath: configuration.fullPath,
    projectId: configuration.projectId,
  };
}

export async function observeBoundGitLabIssues(
  project: RoadmapProjectIdentity,
  budget: HostObservationBudget = { startedAt: hostMonotonicNow(), bytes: 0 },
): Promise<SanitizedRoadmapIssue[]> {
  const issues: SanitizedRoadmapIssue[] = [];
  for (let page = 1; page <= MAXIMUM_GITLAB_PAGES; page += 1) {
    const response = await runBoundedGlabJson(
      `projects/${project.projectId}/issues?scope=all&state=all&per_page=100&page=${page}`,
      MAXIMUM_GITLAB_ISSUE_PAGE_BYTES,
      budget,
    );
    const values = denseArray(response.value, 100, "invalid-tracker-observation");
    for (const value of values) {
      try {
        issues.push(sanitizeGitLabIssue(value));
      } catch {
        fail("invalid-tracker-observation");
      }
      if (issues.length > MAXIMUM_TRACKER_ISSUES) fail("invalid-tracker-observation");
    }
    if (values.length < 100) return issues;
  }
  fail("invalid-tracker-observation");
}

export async function runBoundedGlabJson(
  endpoint: string,
  maximumBytes: number,
  budget: HostObservationBudget,
): Promise<{ value: unknown; byteLength: number }> {
  const elapsed = hostMonotonicNow() - budget.startedAt;
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= MAXIMUM_GITLAB_ELAPSED_MS) {
    fail("invalid-tracker-observation");
  }
  let stdout: string;
  try {
    ({ stdout } = await hostExecFile(
      assertCurrentHostGlabExecutable(),
      ["api", "--hostname", hostProjectConfiguration!.host, endpoint],
      {
        encoding: "utf8",
        timeout: Math.max(1, Math.floor(MAXIMUM_GITLAB_ELAPSED_MS - elapsed)),
        maxBuffer: maximumBytes,
        env: hostGlabEnvironment,
      },
    ));
  } catch {
    fail("invalid-tracker-observation");
  }
  const byteLength = Buffer.byteLength(stdout);
  budget.bytes += byteLength;
  const finalElapsed = hostMonotonicNow() - budget.startedAt;
  if (
    byteLength > maximumBytes ||
    budget.bytes > MAXIMUM_GITLAB_TOTAL_BYTES ||
    !Number.isFinite(finalElapsed) ||
    finalElapsed < 0 ||
    finalElapsed >= MAXIMUM_GITLAB_ELAPSED_MS
  )
    fail("invalid-tracker-observation");
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    fail("invalid-tracker-observation");
  }
  return { value, byteLength };
}

export function snapshotHostGlabExecutable(
  environment: NodeJS.ProcessEnv,
): HostExecutableIdentity | null {
  const configured = environment.DOCSFAB_ROADMAP_GLAB_PATH;
  if (!configured || !isAbsolute(configured)) return null;
  try {
    const canonical = realpathSync(configured);
    const metadata = lstatSync(configured);
    if (
      canonical !== configured ||
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      (metadata.mode & 0o022) !== 0 ||
      (typeof process.getuid === "function" &&
        metadata.uid !== process.getuid() &&
        metadata.uid !== 0)
    ) {
      return null;
    }
    return Object.freeze({
      path: canonical,
      dev: metadata.dev,
      ino: metadata.ino,
      uid: metadata.uid,
      mode: metadata.mode,
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
      ctimeMs: metadata.ctimeMs,
    });
  } catch {
    return null;
  }
}

export function assertCurrentHostGlabExecutable(): string {
  const expected = hostGlabExecutable;
  if (!expected) fail("invalid-tracker-observation");
  try {
    const canonical = realpathSync(expected.path);
    const metadata = lstatSync(expected.path);
    if (
      canonical !== expected.path ||
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.dev !== expected.dev ||
      metadata.ino !== expected.ino ||
      metadata.uid !== expected.uid ||
      metadata.mode !== expected.mode ||
      metadata.size !== expected.size ||
      metadata.mtimeMs !== expected.mtimeMs ||
      metadata.ctimeMs !== expected.ctimeMs ||
      (metadata.mode & 0o022) !== 0
    ) {
      fail("invalid-tracker-observation");
    }
  } catch (error) {
    if (error instanceof DocumentationMaturityCascadeError) throw error;
    fail("invalid-tracker-observation");
  }
  return expected.path;
}

export function assertGitLabCommitRevision(value: unknown, revision: string): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail("invalid-tracker-observation");
  const keys = Reflect.ownKeys(value);
  if (keys.length > 256 || keys.some((key) => typeof key !== "string")) {
    fail("invalid-tracker-observation");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "id");
  if (
    !descriptor ||
    !Object.hasOwn(descriptor, "value") ||
    !descriptor.enumerable ||
    descriptor.value !== revision
  )
    fail("repository-mismatch");
}

export function snapshotHostGitLabConfiguration(
  environment: NodeJS.ProcessEnv,
): HostGitLabConfiguration | null {
  const host = environment.DOCSFAB_ROADMAP_GITLAB_HOST;
  const fullPath = environment.DOCSFAB_ROADMAP_GITLAB_FULL_PATH;
  const projectIdText = environment.DOCSFAB_ROADMAP_GITLAB_PROJECT_ID;
  const sshPortText = environment.DOCSFAB_ROADMAP_GITLAB_SSH_PORT;
  const projectId = Number(projectIdText);
  const sshPort = Number(sshPortText);
  if (
    !host ||
    !isDnsHostname(host) ||
    !fullPath ||
    !GITLAB_PATH.test(fullPath) ||
    fullPath.endsWith(".git") ||
    fullPath.split("/").some((part) => part === "." || part === "..") ||
    projectIdText !== String(projectId) ||
    sshPortText !== String(sshPort) ||
    !Number.isSafeInteger(projectId) ||
    projectId < 1 ||
    !Number.isSafeInteger(sshPort) ||
    sshPort < 1 ||
    sshPort > 65_535
  )
    return null;
  return Object.freeze({ host, fullPath, projectId, sshPort });
}
