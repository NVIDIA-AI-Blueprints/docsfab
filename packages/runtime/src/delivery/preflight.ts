// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile, type ExecFileException } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  canonicalizeJsonEvidence,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../json-evidence.js";
import {
  LOCAL_USER_MINIMUM_PUSH_ACCESS_LEVEL,
  assertLocalUserPublicationAdvance,
  assertLocalUserPublicationPlan,
  deterministicLocalUserSourceBranch,
  canonicalLocalUserGitIdentity,
  localUserGitIdentitySha256,
  localUserPublicationPlanSha256,
  type LocalUserPublicationAdvanceV1,
  type LocalUserPublicationFailureCode,
  type LocalUserPublicationPlan,
  type LocalUserPublicationPreflightDetails,
} from "./contracts.js";
import { gitEnvironment as publisherGitEnvironment } from "./git-environment.js";
import {
  GIT_CONFIGURATION_LIST_ARGS,
  GIT_CONFIGURATION_LISTING_LIMIT,
  HOST_GIT_CONFIG_FLAGS,
  assessGitConfigurationList,
  displayGitConfigurationOrigin,
  resolveGitConfigurationPaths,
} from "./git-config-policy.js";
import { GitLabPublisherAdapterError, parseGitLabMergeRequest } from "./gitlab-adapter.js";
import type { ScmDeliveryReceiptStore } from "./receipt-store.js";
import type { ScmDeliveryRecord } from "./receipt.js";
import type { ReadOnlyCommandResult } from "./command-types.js";
import {
  classifyGlabCommandFailure,
  publicationCodeForGlabAuthClass,
  tokenProbeFromExitCode,
} from "./glab-auth-diagnosis.js";
import { assertRunRevisionPublishableForGitLabTarget } from "./revision-freshness.js";
import type { PublicationRunRecordDecodeOptionsV1 } from "./run-record.js";
import { buildRunPublicationMetadata, hasExactDocsFabPublicationMetadata } from "./metadata.js";
import {
  DocumentationValidationError,
  selectDocumentationValidationProfile,
} from "./validation-profile.js";
import { validationBackendPolicySha256 } from "./worktree/validation-backend.js";
import {
  DocumentationValidationCandidateError,
  DocumentationValidationPatchConflictError,
  documentationCandidateInputTreeSha256,
  documentationRepositoryIdentitySha256,
  withDocumentationValidationCandidate,
} from "./documentation-validation-candidate.js";
import { DurableArtifactStore } from "../artifacts/store.js";
import {
  deriveDocumentationSourceApplicability,
  storeDocumentationSourceApplicability,
} from "../repository/documentation-source-applicability.js";
import { isDocumentationSourceConfigurationPath } from "../repository/documentation-source-support.js";
import { formatLimitExceeded, limit } from "../config/limits.js";
import { fail, object, SAFE_ID } from "./preflight/primitives.js";
import {
  branchRuleMatches,
  parseGitLabRemote,
  safeBranch,
  safeProjectPath,
  safeProtectionPattern,
} from "./preflight/target-syntax.js";
import type { ParsedRemote } from "./preflight/target-syntax.js";
import {
  loadVerifiedPublicationRun,
  type VerifiedPublicationRun,
} from "./preflight/run-admission.js";

export { parseGitLabRemote };
export {
  loadVerifiedPublicationRun,
  reloadVerifiedPublicationRun,
  loadVerifiedCheckoutRun,
  rejectStateDirectoryParentOfRunStore,
} from "./preflight/run-admission.js";
export type { VerifiedPublicationRun } from "./preflight/run-admission.js";
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SAFE_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_VALIDATION = /^[A-Za-z0-9][A-Za-z0-9 ._/:@+,-]{0,199}$/u;
const GITLAB_PROJECT_GID = /^gid:\/\/gitlab\/Project\/([1-9][0-9]*)$/u;
/** GraphQL variables carry fullPath; the query itself is host- and path-free. */
const GITLAB_PROJECT_FULL_PATH_QUERY =
  "query($fullPath: ID!) { project(fullPath: $fullPath) { id fullPath } }";
const SAFE_GIT_CONFIG = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.trustExitCode=false",
  "-c",
  "pager.status=false",
  "-c",
  "pager.diff=false",
] as const;

export type { ReadOnlyCommandResult } from "./command-types.js";

export interface ReadOnlyCommandRunner {
  run(
    command: "git" | "glab" | "gh",
    args: readonly string[],
    cwd: string,
    options?: {
      env?: NodeJS.ProcessEnv;
      /**
       * Largest stdout, in bytes, before the command is stopped and the result
       * carries `failure: "output-limit"`. Absent, the runner's own default applies.
       */
      maxOutputBytes?: number;
    },
  ): Promise<ReadOnlyCommandResult>;
}

export interface LocalUserPublicationPreflightInput {
  runId: string;
  runRecordPath: string;
  repositoryPath: string;
  remoteName?: string;
  targetBranch?: string;
  proposedSourceBranch?: string;
  validationCommand?: string;
  draftMergeRequest: true;
  /** Advance an existing DocsFab-minted MR branch instead of creating one. */
  advance?: LocalUserPublicationAdvanceV1;
}

/** Host state an advance preflight reads; a first publication needs none of it. */
export interface LocalUserPublicationPreflightContext {
  /** The store holding the parent's receipt and plan; an advance refuses without it. */
  readonly receiptStore?: Pick<ScmDeliveryReceiptStore, "load" | "loadPlan">;
  /** Decode options for the parent's run record, which an editorial parent needs. */
  readonly parentEditorialDecodeOptions?: PublicationRunRecordDecodeOptionsV1;
  /**
   * Builds the private run base plus patch that the default validation binds
   * to (#2359). A test whose checkout is not a Git repository passes its own.
   */
  readonly validationCandidate?: typeof withDocumentationValidationCandidate;
  /**
   * The environment the host publisher's Git will run with; the process
   * environment by default. Preflight reads the Git identity and the Git
   * configuration with it, so what it binds and checks is what the publisher
   * commits as and reads (#2362, #2363).
   */
  readonly environment?: NodeJS.ProcessEnv;
}

export interface LocalUserGitLabTargetObserveInput {
  readonly repositoryPath: string;
  readonly remoteName?: string;
  readonly targetBranch?: string;
}

/** Read-only GitLab target observation shared by `--draft-mr` freshness and preflight. */
export interface LocalUserGitLabTargetObservation {
  readonly repositoryPath: string;
  readonly headRevision: string;
  readonly headBranch: string;
  readonly remoteName: string;
  readonly remote: {
    readonly host: string;
    readonly projectPath: string;
    readonly transport: "ssh" | "https";
  };
  readonly project: {
    readonly id: number;
    readonly pathWithNamespace: string;
    readonly defaultBranch: string;
    readonly accessLevel: number;
  };
  readonly target: {
    readonly name: string;
    readonly protected: boolean;
    readonly revision: string;
  };
}

interface GitLabProject {
  id: number;
  pathWithNamespace: string;
  defaultBranch: string;
  accessLevel: number;
}

interface GitLabBranch {
  name: string;
  protected: boolean;
  revision: string;
}

interface ProtectedBranchRule {
  name: string;
}

export class ExecFileReadOnlyCommandRunner implements ReadOnlyCommandRunner {
  public run(
    command: "git" | "glab" | "gh",
    args: readonly string[],
    cwd: string,
    options: { env?: NodeJS.ProcessEnv; maxOutputBytes?: number } = {},
  ): Promise<ReadOnlyCommandResult> {
    return new Promise((resolveResult) => {
      execFile(
        command,
        [...args],
        {
          cwd,
          encoding: "utf8",
          env: options.env,
          maxBuffer: limit("delivery.readOnlyCommandMaxBufferBytes").value,
          timeout: limit("delivery.readOnlyCommandTimeoutMs").value,
          // Node counts the bound in bytes, as the publisher's runner does, so a bound given
          // to both readers stops both at the same output.
          ...(options.maxOutputBytes !== undefined ? { maxBuffer: options.maxOutputBytes } : {}),
        },
        (error, stdout, stderr) => resolveResult(commandOutcome(error, stdout, stderr)),
      );
    });
  }
}

function commandOutcome(
  error: ExecFileException | null,
  stdout: unknown,
  stderr: unknown,
): ReadOnlyCommandResult {
  return {
    exitCode: error ? 1 : 0,
    stdout: typeof stdout === "string" ? stdout : "",
    stderr: typeof stderr === "string" ? stderr : "",
    // Only the stop a caller can act on: a bound it set was crossed.
    ...(error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
      ? { failure: "output-limit" as const }
      : {}),
  };
}

export async function observeLocalUserGitLabTarget(
  input: LocalUserGitLabTargetObserveInput,
  commands: ReadOnlyCommandRunner = new ExecFileReadOnlyCommandRunner(),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LocalUserGitLabTargetObservation> {
  if (typeof input.repositoryPath !== "string" || !isAbsolute(input.repositoryPath)) {
    fail("invalid-input");
  }
  const repositoryPath = await canonicalDirectory(input.repositoryPath).catch(() =>
    fail("not-a-git-repository"),
  );
  await requireGit(
    commands,
    repositoryPath,
    ["rev-parse", "--is-inside-work-tree"],
    "not-a-git-repository",
  );
  const topLevel = await requireGit(
    commands,
    repositoryPath,
    ["rev-parse", "--show-toplevel"],
    "not-a-git-repository",
  );
  const canonicalTopLevel = await canonicalDirectory(topLevel.trim()).catch(() =>
    fail("not-a-git-repository"),
  );
  if (canonicalTopLevel !== repositoryPath) fail("not-repository-root");
  await rejectExecutableGitConfiguration(commands, repositoryPath);
  const headBranch = (
    await requireGit(
      commands,
      repositoryPath,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      "detached-head",
    )
  ).trim();
  if (!safeBranch(headBranch)) fail("detached-head");
  const headRevision = (
    await requireGit(
      commands,
      repositoryPath,
      ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"],
      "head-revision-invalid",
    )
  ).trim();
  if (!REVISION.test(headRevision)) fail("head-revision-invalid");

  const remoteName = await selectRemote(commands, repositoryPath, input.remoteName);
  const fetchRemote = parseGitLabRemote(
    await singleRemoteUrl(commands, repositoryPath, remoteName, false),
  );
  const remote = parseGitLabRemote(
    await singleRemoteUrl(commands, repositoryPath, remoteName, true),
  );
  if (
    fetchRemote.host !== remote.host ||
    fetchRemote.projectPath.toLowerCase() !== remote.projectPath.toLowerCase()
  ) {
    fail("project-mismatch");
  }
  await rejectRefusedGitConfiguration(commands, repositoryPath, remote.host, environment);
  await requireCommand(commands, "glab", ["version"], repositoryPath, "glab-unavailable");
  await requireGlabHostAuthentication(commands, repositoryPath, remote.host);
  const project = await gitLabProject(commands, repositoryPath, remote);
  if (project.pathWithNamespace.toLowerCase() !== remote.projectPath.toLowerCase()) {
    fail("project-mismatch");
  }
  const targetName = input.targetBranch ?? project.defaultBranch;
  if (!safeBranch(targetName)) fail("invalid-input");
  const target = await gitLabBranch(commands, repositoryPath, remote.host, project.id, targetName);
  if (target.name !== targetName) fail("target-branch-missing");
  return {
    repositoryPath,
    headRevision,
    headBranch,
    remoteName,
    remote: {
      host: remote.host,
      projectPath: remote.projectPath,
      transport: remote.transport,
    },
    project: {
      id: project.id,
      pathWithNamespace: project.pathWithNamespace,
      defaultBranch: project.defaultBranch,
      accessLevel: project.accessLevel,
    },
    target: {
      name: target.name,
      protected: target.protected,
      revision: target.revision,
    },
  };
}

export async function preflightLocalUserGitLabPublication(
  input: LocalUserPublicationPreflightInput,
  commands: ReadOnlyCommandRunner = new ExecFileReadOnlyCommandRunner(),
  editorialDecodeOptions: PublicationRunRecordDecodeOptionsV1 = {},
  context: LocalUserPublicationPreflightContext = {},
): Promise<LocalUserPublicationPlan> {
  validateInput(input);
  const advance = input.advance;
  const parent = advance ? await loadAdvanceParent(advance, context.receiptStore) : undefined;
  const run = await loadVerifiedPublicationRun(
    input.runRecordPath,
    input.runId,
    editorialDecodeOptions,
  );
  if (advance && run.revision !== advance.observedHead) {
    advanceMismatch("observedHead", advance.observedHead, run.revision);
  }
  // An advance stays on the parent's target branch; an explicit one must agree.
  const targetBranch = parent ? parent.receipt.targetBranch : input.targetBranch;
  if (
    parent &&
    input.targetBranch !== undefined &&
    input.targetBranch !== parent.receipt.targetBranch
  ) {
    advanceMismatch("targetBranch", parent.receipt.targetBranch, input.targetBranch);
  }
  const recordedSourcePath = await canonicalDirectory(run.sourcePath).catch(() =>
    fail("repository-mismatch"),
  );
  const observation = await observeLocalUserGitLabTarget(
    {
      repositoryPath: input.repositoryPath,
      ...(input.remoteName ? { remoteName: input.remoteName } : {}),
      ...(targetBranch ? { targetBranch } : {}),
    },
    commands,
    context.environment,
  );
  if (observation.repositoryPath !== recordedSourcePath) fail("repository-mismatch");
  if (
    parent &&
    (observation.project.id !== parent.receipt.repository.projectId ||
      observation.remote.host !== parent.receipt.repository.host ||
      observation.project.pathWithNamespace !== parent.receipt.repository.path)
  ) {
    advanceMismatch(
      "project",
      String(parent.receipt.repository.projectId),
      String(observation.project.id),
    );
  }
  const repositoryPath = observation.repositoryPath;
  const remoteName = observation.remoteName;
  const remote = observation.remote;
  const project = observation.project;
  const target = observation.target;
  const targetName = target.name;

  await requireSuccess(
    commands,
    "git",
    ["cat-file", "-e", `${run.revision}^{commit}`],
    repositoryPath,
    "run-revision-missing",
  );

  const user = await gitLabUser(commands, repositoryPath, remote.host);
  const gitIdentity = await resolveLocalUserGitIdentity(
    commands,
    repositoryPath,
    remote.host,
    user,
    context.environment,
  );
  const gitIdentitySha256 = localUserGitIdentitySha256(gitIdentity.name, gitIdentity.email);
  if (project.accessLevel < LOCAL_USER_MINIMUM_PUSH_ACCESS_LEVEL) fail("insufficient-push-access");

  const revisionDetails: LocalUserPublicationPreflightDetails = {
    runRevision: run.revision,
    gitlabTargetRevision: target.revision,
    gitlabTargetBranch: target.name,
  };
  if (advance && parent) {
    // An advance starts from the MR head, which never descends into the
    // target; it must descend from the head DocsFab last recorded instead.
    await assertAdvanceObservation({
      advance,
      parent,
      commands,
      repositoryPath,
      host: remote.host,
      projectId: project.id,
      targetBranch: target.name,
      username: user.username,
      runRecordPath: input.runRecordPath,
      parentEditorialDecodeOptions: context.parentEditorialDecodeOptions ?? {},
      store: context.receiptStore!,
    });
  } else {
    await assertRunRevisionPublishableForGitLabTarget(
      {
        runRevision: run.revision,
        gitlabTargetRevision: target.revision,
        projectId: project.id,
        host: remote.host,
        repositoryPath,
      },
      commands,
      revisionDetails,
    );
  }

  if (
    advance &&
    input.proposedSourceBranch !== undefined &&
    input.proposedSourceBranch !== advance.sourceBranch
  ) {
    advanceMismatch("sourceBranch", advance.sourceBranch, input.proposedSourceBranch);
  }
  const sourceBranch =
    advance?.sourceBranch ??
    input.proposedSourceBranch ??
    deterministicLocalUserSourceBranch(run.id, run.revision, run.recordSha256, run.patch.sha256);
  if (!safeBranch(sourceBranch)) fail("unsafe-source-branch");
  if (sourceBranch === project.defaultBranch) fail("source-branch-is-default");
  if (sourceBranch === targetName) fail("source-branch-is-target");
  const protectionRules = await protectedBranchRules(
    commands,
    repositoryPath,
    remote.host,
    project.id,
  );
  if (protectionRules.some((rule) => branchRuleMatches(rule.name, sourceBranch))) {
    fail("source-branch-protected");
  }

  const selectedValidation = await selectDefaultDocumentationValidation(run, {
    projectId: project.id,
    host: remote.host,
    projectPath: project.pathWithNamespace,
    artifactStoreRoot: resolve(dirname(input.runRecordPath), "..", "artifacts"),
    candidateParentDirectory: resolve(dirname(input.runRecordPath), "..", "validation-candidates"),
    ...(context.validationCandidate ? { validationCandidate: context.validationCandidate } : {}),
  });
  const validationCommand = input.validationCommand ?? selectedValidation.entrypointCommand;
  if (!safeValidationCommand(validationCommand)) fail("invalid-input");
  const documentationValidation =
    validationCommand === selectedValidation.entrypointCommand
      ? selectedValidation.binding
      : undefined;

  if (advance && user.id === undefined) fail("gitlab-response-invalid");
  const common = {
    kind: "docsfab-local-user-gitlab-publication-plan",
    deliveryMode: "local-user",
    authorityBasis: "interactive-once",
    run: { id: run.id, recordSha256: run.recordSha256 },
    project: {
      id: project.id,
      host: remote.host,
      path: project.pathWithNamespace,
    },
    remote: { name: remoteName, transport: remote.transport },
    baseRevision: run.revision,
    targetBranch: { name: targetName, protected: target.protected },
    proposedSourceBranch: sourceBranch,
    patch: {
      format: "git-diff",
      sha256: run.patch.sha256,
      byteLength: run.patch.byteLength,
      changedFileCount: run.changedFileCount,
    },
    validationCommand,
    ...(documentationValidation ? { documentationValidation } : {}),
    mergeRequest: { draft: true },
    fallback: { mode: "patch-only", preserved: true },
  } as const;
  const checks = {
    repository: "passed",
    remote: "passed",
    gitIdentity: "configured",
    gitlabAuthentication: "authenticated",
    pushAccess: "allowed",
    sourceBranch: "unprotected",
  } as const;
  const identity = {
    git: "configured",
    gitIdentitySha256,
    gitlabUsername: user.username,
  } as const;
  if (advance) {
    const planWithoutDigest = {
      schemaVersion: 3,
      ...common,
      identity: { ...identity, gitlabUserId: user.id! },
      checks: { ...checks, revision: "descends-from-recorded-head" },
      advance: structuredClone(advance),
    } as const;
    return {
      ...planWithoutDigest,
      sha256: localUserPublicationPlanSha256(planWithoutDigest),
    };
  }
  const planWithoutDigest = {
    schemaVersion: 2,
    ...common,
    identity,
    checks: {
      ...checks,
      revision:
        target.revision.toLowerCase() === run.revision.toLowerCase()
          ? "current"
          : "ancestor-of-target",
    },
  } as const;
  const sha256 = localUserPublicationPlanSha256(planWithoutDigest);
  return { ...planWithoutDigest, sha256 };
}

interface AdvanceParent {
  readonly receipt: ScmDeliveryRecord;
  readonly plan: LocalUserPublicationPlan;
}

/**
 * Load and cross-check the parent delivery an advance names. Each field the
 * caller asserts must equal the stored receipt or plan; nothing is taken from
 * the request alone.
 */
async function loadAdvanceParent(
  advance: LocalUserPublicationAdvanceV1,
  store: LocalUserPublicationPreflightContext["receiptStore"],
): Promise<AdvanceParent> {
  if (!store) fail("revision-receipt-store-missing");
  const receipt = await store.load(advance.parent.idempotencyKey).catch(() =>
    fail("revision-parent-record-unavailable", {
      revision: { field: "receipt" },
    }),
  );
  if (!receipt) advanceMismatch("idempotencyKey", advance.parent.idempotencyKey, "absent");
  if (receipt.sha256 !== advance.parent.deliveryReceiptSha256) {
    advanceMismatch("deliveryReceiptSha256", advance.parent.deliveryReceiptSha256, receipt.sha256);
  }
  if (receipt.state !== "opened" || receipt.disposition !== "succeeded") {
    advanceMismatch("state", "opened/succeeded", `${receipt.state}/${receipt.disposition}`);
  }
  if (receipt.planSha256 !== advance.parent.planSha256) {
    advanceMismatch("planSha256", advance.parent.planSha256, receipt.planSha256);
  }
  if (receipt.run.id !== advance.parent.runId) {
    advanceMismatch("runId", advance.parent.runId, receipt.run.id);
  }
  if (receipt.run.recordSha256 !== advance.parent.recordSha256) {
    advanceMismatch("recordSha256", advance.parent.recordSha256, receipt.run.recordSha256);
  }
  if (receipt.sourceBranch !== advance.sourceBranch) {
    advanceMismatch("sourceBranch", receipt.sourceBranch, advance.sourceBranch);
  }
  if (receipt.repository.projectId !== advance.mergeRequest.projectId) {
    advanceMismatch(
      "projectId",
      String(receipt.repository.projectId),
      String(advance.mergeRequest.projectId),
    );
  }
  const recordedIid = receipt.evidence.mergeRequest?.iid;
  if (recordedIid !== advance.mergeRequest.iid) {
    advanceMismatch("mergeRequestIid", String(recordedIid), String(advance.mergeRequest.iid));
  }
  const recordedHead = receipt.evidence.push?.remoteRevision;
  if (recordedHead !== advance.lastRecordedHead) {
    advanceMismatch("lastRecordedHead", String(recordedHead), advance.lastRecordedHead);
  }
  const plan = store.loadPlan
    ? await store.loadPlan(advance.parent.planSha256).catch(() => undefined)
    : undefined;
  if (!plan || plan.sha256 !== receipt.planSha256) {
    fail("revision-parent-record-unavailable", { revision: { field: "plan" } });
  }
  const parentOrdinal = plan.schemaVersion === 3 ? plan.advance.ordinal : 0;
  if (advance.ordinal !== parentOrdinal + 1) {
    advanceMismatch("ordinal", String(parentOrdinal + 1), String(advance.ordinal));
  }
  return { receipt, plan };
}

/**
 * Read-only D1/D2 observation for an advance: the requester, the MR, the
 * branch head on GitLab, local ancestry, and the parent's root provenance.
 * Every refusal here precedes the receipt claim and any write.
 */
async function assertAdvanceObservation(input: {
  advance: LocalUserPublicationAdvanceV1;
  parent: AdvanceParent;
  commands: ReadOnlyCommandRunner;
  repositoryPath: string;
  host: string;
  projectId: number;
  targetBranch: string;
  username: string;
  runRecordPath: string;
  parentEditorialDecodeOptions: PublicationRunRecordDecodeOptionsV1;
  store: NonNullable<LocalUserPublicationPreflightContext["receiptStore"]>;
}): Promise<void> {
  const { advance, parent, commands, repositoryPath } = input;
  const parentUsername = parent.plan.identity.gitlabUsername;
  if (input.username !== parentUsername) {
    fail("revision-requester-mismatch", {
      revision: {
        field: "gitlabUsername",
        expected: parentUsername,
        observed: input.username,
      },
    });
  }
  const value = await gitLabJson(
    commands,
    repositoryPath,
    input.host,
    `projects/${input.projectId}/merge_requests/${advance.mergeRequest.iid}`,
  );
  let mergeRequest: ReturnType<typeof parseGitLabMergeRequest>;
  try {
    mergeRequest = parseGitLabMergeRequest(value, {
      host: input.host,
      path: parent.receipt.repository.path,
      projectId: input.projectId,
      sourceBranch: advance.sourceBranch,
    });
  } catch (error) {
    if (!(error instanceof GitLabPublisherAdapterError)) throw error;
    fail("revision-mr-not-open", {
      revision: { field: "mergeRequest", observed: "not-this-branch" },
    });
  }
  if (mergeRequest.iid !== advance.mergeRequest.iid || mergeRequest.state !== "opened") {
    fail("revision-mr-not-open", {
      revision: {
        field: "state",
        expected: "opened",
        observed: mergeRequest.state,
      },
    });
  }
  if (!mergeRequest.draft) {
    fail("revision-mr-not-open", {
      revision: { field: "state", expected: "draft", observed: "ready" },
    });
  }
  if (mergeRequest.targetBranch !== input.targetBranch) {
    fail("revision-mr-not-open", {
      revision: {
        field: "targetBranch",
        expected: input.targetBranch,
        observed: mergeRequest.targetBranch,
      },
    });
  }
  const branchHead = await gitLabBranchHead(
    commands,
    repositoryPath,
    input.host,
    input.projectId,
    advance.sourceBranch,
  );
  if (branchHead !== advance.observedHead) {
    fail("revision-head-moved", {
      revision: {
        field: "sourceBranch",
        expected: advance.observedHead,
        observed: branchHead ?? "deleted",
      },
    });
  }
  if (mergeRequest.headRevision !== advance.observedHead) {
    fail("revision-head-moved", {
      revision: {
        field: "mergeRequest",
        expected: advance.observedHead,
        observed: mergeRequest.headRevision,
      },
    });
  }
  // A shallow history can hide a true ancestor, which would read as a rewrite.
  const shallow = await runGit(commands, ["rev-parse", "--is-shallow-repository"], repositoryPath);
  if (shallow.exitCode !== 0 || shallow.stdout.trim() !== "false") {
    fail("revision-shallow-repository");
  }
  // The read-only runner reports only success or failure, so a missing object
  // is ruled out before ancestry; only then does a failure mean a rewrite.
  const present = await runGit(
    commands,
    ["cat-file", "-e", "--end-of-options", `${advance.lastRecordedHead}^{commit}`],
    repositoryPath,
  );
  if (present.exitCode !== 0) {
    fail("revision-object-missing", {
      revision: {
        field: "lastRecordedHead",
        observed: advance.lastRecordedHead,
      },
    });
  }
  const ancestry = await runGit(
    commands,
    [
      "merge-base",
      "--is-ancestor",
      "--end-of-options",
      advance.lastRecordedHead,
      advance.observedHead,
    ],
    repositoryPath,
  );
  if (ancestry.exitCode !== 0) {
    fail("revision-head-rewritten", {
      revision: {
        field: "observedHead",
        expected: `descendant of ${advance.lastRecordedHead}`,
        observed: advance.observedHead,
      },
    });
  }
  // The MR carries the marker of the chain's first publication, so a revision
  // of a revision still checks the root's metadata.
  const root = await loadAdvanceRootPlan(parent.plan, input.store);
  if (!root) fail("revision-parent-record-unavailable", { revision: { field: "plan" } });
  const rootRun = await loadVerifiedPublicationRun(
    join(dirname(input.runRecordPath), `${root.run.id}.json`),
    root.run.id,
    input.parentEditorialDecodeOptions,
  ).catch(() => fail("revision-parent-record-unavailable", { revision: { field: "runRecord" } }));
  if (rootRun.recordSha256 !== root.run.recordSha256) {
    fail("revision-parent-record-unavailable", { revision: { field: "runRecord" } });
  }
  let rootMetadata: ReturnType<typeof buildRunPublicationMetadata>;
  try {
    rootMetadata = buildRunPublicationMetadata(root, rootRun);
  } catch {
    fail("revision-parent-record-unavailable", { revision: { field: "metadata" } });
  }
  if (
    !hasExactDocsFabPublicationMetadata(mergeRequest.title, mergeRequest.description, rootMetadata)
  ) {
    fail("revision-root-marker-mismatch");
  }
}

/**
 * The first publication of an advance chain, whose MR every revision reuses.
 * Each step must lower the ordinal by one down to the root's 0, so the walk
 * ends; an unavailable or inconsistent link yields undefined.
 */
export async function loadAdvanceRootPlan(
  plan: LocalUserPublicationPlan,
  store: Pick<ScmDeliveryReceiptStore, "loadPlan">,
): Promise<LocalUserPublicationPlan | undefined> {
  let current = plan;
  while (current.schemaVersion === 3) {
    const previous = await store
      .loadPlan?.(current.advance.parent.planSha256)
      .catch(() => undefined);
    if (!previous || previous.sha256 !== current.advance.parent.planSha256) return undefined;
    const ordinal = previous.schemaVersion === 3 ? previous.advance.ordinal : 0;
    if (ordinal !== current.advance.ordinal - 1) return undefined;
    current = previous;
  }
  return current;
}

function advanceMismatch(field: string, expected: string, observed: string): never {
  fail("revision-parent-mismatch", { revision: { field, expected, observed } });
}

/** The GitLab head of one exact branch, or undefined when GitLab reports none. */
async function gitLabBranchHead(
  commands: ReadOnlyCommandRunner,
  cwd: string,
  host: string,
  projectId: number,
  branch: string,
): Promise<string | undefined> {
  const result = await commands.run(
    "glab",
    [
      "api",
      "--hostname",
      host,
      `projects/${projectId}/repository/branches/${encodeURIComponent(branch)}`,
    ],
    cwd,
  );
  if (result.exitCode !== 0) return undefined;
  const value = parseApiJson(result.stdout);
  if (
    !object(value) ||
    value.name !== branch ||
    !object(value.commit) ||
    typeof value.commit.id !== "string" ||
    !REVISION.test(value.commit.id)
  ) {
    fail("gitlab-response-invalid");
  }
  return value.commit.id;
}

export function serializeLocalUserPublicationPlan(plan: LocalUserPublicationPlan): string {
  assertLocalUserPublicationPlan(plan);
  return canonicalizeJsonEvidence(plan as unknown as JsonEvidenceValue);
}

async function selectRemote(
  commands: ReadOnlyCommandRunner,
  cwd: string,
  requested: string | undefined,
): Promise<string> {
  if (requested !== undefined) {
    if (!SAFE_REMOTE.test(requested)) fail("invalid-input");
    const remotes = await remoteNames(commands, cwd);
    if (!remotes.includes(requested)) fail("missing-remote");
    return requested;
  }
  const remotes = await remoteNames(commands, cwd);
  if (remotes.length === 0) fail("missing-remote");
  if (remotes.includes("origin")) return "origin";
  if (remotes.length === 1) return remotes[0]!;
  fail("ambiguous-remote");
}

async function remoteNames(commands: ReadOnlyCommandRunner, cwd: string): Promise<string[]> {
  const result = await runGit(commands, ["remote"], cwd);
  if (result.exitCode !== 0) fail("missing-remote");
  const remotes = result.stdout.split(/\r?\n/u).filter(Boolean);
  if (remotes.some((name) => !SAFE_REMOTE.test(name)) || new Set(remotes).size !== remotes.length) {
    fail("ambiguous-remote");
  }
  return remotes;
}

async function singleRemoteUrl(
  commands: ReadOnlyCommandRunner,
  cwd: string,
  remote: string,
  push: boolean,
): Promise<string> {
  const result = await runGit(
    commands,
    ["remote", "get-url", ...(push ? ["--push"] : []), "--all", remote],
    cwd,
  );
  if (result.exitCode !== 0) fail("missing-remote");
  const urls = result.stdout.split(/\r?\n/u).filter(Boolean);
  if (urls.length !== 1) fail("ambiguous-remote-url");
  return urls[0]!;
}

async function gitLabUser(
  commands: ReadOnlyCommandRunner,
  cwd: string,
  host: string,
): Promise<{ username: string; id?: number; name?: string; email?: string }> {
  const value = await gitLabJson(commands, cwd, host, "user");
  if (!object(value) || typeof value.username !== "string" || !SAFE_USERNAME.test(value.username)) {
    fail("gitlab-response-invalid");
  }
  return {
    username: value.username,
    ...(typeof value.id === "number" && Number.isSafeInteger(value.id) && value.id > 0
      ? { id: value.id }
      : {}),
    ...(typeof value.name === "string" && value.name.trim() ? { name: value.name } : {}),
    ...(typeof value.email === "string" && value.email.trim() ? { email: value.email } : {}),
  };
}

/**
 * The Git identity a publication commits as: the operator's configured
 * `user.name` and `user.email`, else the GitLab profile of the authenticated
 * user. `environment` is the one the publisher's Git runs with (the process
 * environment by default), so the identity preflight binds into the plan is
 * the identity the publisher reads back before every mutation (#2362).
 */
export async function resolveLocalUserGitIdentity(
  commands: ReadOnlyCommandRunner,
  cwd: string,
  host: string,
  user?: { username: string; name?: string; email?: string },
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ name: string; email: string }> {
  const fromGit = await readOptionalGitIdentity(commands, cwd, environment);
  if (fromGit) return fromGit;
  const resolved = user ?? (await gitLabUser(commands, cwd, host));
  const name = resolved.name?.trim() || resolved.username;
  const email = resolved.email?.trim() || `${resolved.username}@users.noreply.${host}`;
  try {
    return canonicalLocalUserGitIdentity(name, email);
  } catch {
    fail("git-identity-missing");
  }
}

/**
 * Reads `user.name` and `user.email` through the publisher's Git environment,
 * less the SSH agent socket and login names a read does not need
 * (`configurationReadEnvironment`), so an identity set only in the global or
 * system configuration counts, as it does for the publisher and for Git
 * itself. The isolated preflight environment cannot see it: a plan used to
 * bind the GitLab profile while the publisher committed as the global
 * identity, and that publication stopped.
 * `git config --get` runs no configured command; executable repository
 * configuration is still refused before this read.
 */
async function readOptionalGitIdentity(
  commands: ReadOnlyCommandRunner,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ name: string; email: string } | undefined> {
  const env = configurationReadEnvironment(environment);
  const nameResult = await commands.run(
    "git",
    [...SAFE_GIT_CONFIG, "config", "--get", "user.name"],
    cwd,
    { env },
  );
  const emailResult = await commands.run(
    "git",
    [...SAFE_GIT_CONFIG, "config", "--get", "user.email"],
    cwd,
    { env },
  );
  const name = nameResult.exitCode === 0 ? nameResult.stdout : "";
  const email = emailResult.exitCode === 0 ? emailResult.stdout : "";
  if (!name.trim() && !email.trim()) return undefined;
  if (!name.trim() || !email.trim()) fail("git-identity-missing");
  try {
    return canonicalLocalUserGitIdentity(name, email);
  } catch {
    fail("git-identity-missing");
  }
}

async function gitLabProject(
  commands: ReadOnlyCommandRunner,
  cwd: string,
  remote: ParsedRemote,
): Promise<GitLabProject> {
  const projectId = await gitLabProjectIdFromFullPath(commands, cwd, remote);
  const value = await gitLabJson(commands, cwd, remote.host, `projects/${projectId}`);
  if (
    !object(value) ||
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    value.id !== projectId ||
    typeof value.path_with_namespace !== "string" ||
    !safeProjectPath(value.path_with_namespace) ||
    typeof value.default_branch !== "string" ||
    !safeBranch(value.default_branch) ||
    !object(value.permissions)
  ) {
    fail("gitlab-response-invalid");
  }
  const projectAccess = accessLevel(value.permissions.project_access);
  const groupAccess = accessLevel(value.permissions.group_access);
  return {
    id: value.id,
    pathWithNamespace: value.path_with_namespace,
    defaultBranch: value.default_branch,
    accessLevel: Math.max(projectAccess, groupAccess),
  };
}

async function gitLabProjectIdFromFullPath(
  commands: ReadOnlyCommandRunner,
  cwd: string,
  remote: ParsedRemote,
): Promise<number> {
  const result = await commands.run(
    "glab",
    [
      "api",
      "--hostname",
      remote.host,
      "graphql",
      "-f",
      `query=${GITLAB_PROJECT_FULL_PATH_QUERY}`,
      "-f",
      `fullPath=${remote.projectPath}`,
    ],
    cwd,
  );
  if (result.exitCode !== 0) {
    fail(await classifyFailedGlabCommand(commands, cwd, remote.host, result, "api"));
  }
  const value = parseApiJson(result.stdout);
  if (!object(value) || !object(value.data) || !object(value.data.project)) {
    fail("gitlab-response-invalid");
  }
  const project = value.data.project;
  if (
    typeof project.id !== "string" ||
    typeof project.fullPath !== "string" ||
    !safeProjectPath(project.fullPath)
  ) {
    fail("gitlab-response-invalid");
  }
  if (project.fullPath.toLowerCase() !== remote.projectPath.toLowerCase()) {
    fail("project-mismatch");
  }
  return parseGitLabProjectGid(project.id);
}

function parseGitLabProjectGid(value: string): number {
  const match = GITLAB_PROJECT_GID.exec(value);
  if (!match) fail("gitlab-response-invalid");
  const id = Number(match[1]);
  if (!Number.isSafeInteger(id) || id <= 0 || String(id) !== match[1]) {
    fail("gitlab-response-invalid");
  }
  return id;
}

async function gitLabBranch(
  commands: ReadOnlyCommandRunner,
  cwd: string,
  host: string,
  projectId: number,
  branch: string,
): Promise<GitLabBranch> {
  const result = await commands.run(
    "glab",
    [
      "api",
      "--hostname",
      host,
      `projects/${projectId}/repository/branches/${encodeURIComponent(branch)}`,
    ],
    cwd,
  );
  if (result.exitCode !== 0) fail("target-branch-missing");
  const value = parseApiJson(result.stdout);
  if (
    !object(value) ||
    typeof value.name !== "string" ||
    typeof value.protected !== "boolean" ||
    !object(value.commit) ||
    typeof value.commit.id !== "string" ||
    !REVISION.test(value.commit.id)
  ) {
    fail("gitlab-response-invalid");
  }
  return {
    name: value.name,
    protected: value.protected,
    revision: value.commit.id,
  };
}

async function protectedBranchRules(
  commands: ReadOnlyCommandRunner,
  cwd: string,
  host: string,
  projectId: number,
): Promise<ProtectedBranchRule[]> {
  const value = await gitLabJson(
    commands,
    cwd,
    host,
    `projects/${projectId}/protected_branches?per_page=100`,
  );
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) =>
        !object(entry) || typeof entry.name !== "string" || !safeProtectionPattern(entry.name),
    )
  )
    fail("gitlab-response-invalid");
  if (value.length === 100) fail("protected-branch-check-incomplete");
  return value.map((entry) => ({ name: (entry as { name: string }).name }));
}

async function gitLabJson(
  commands: ReadOnlyCommandRunner,
  cwd: string,
  host: string,
  endpoint: string,
): Promise<JsonEvidenceValue> {
  const result = await commands.run("glab", ["api", "--hostname", host, endpoint], cwd);
  if (result.exitCode !== 0) {
    fail(await classifyFailedGlabCommand(commands, cwd, host, result, "api"));
  }
  return parseApiJson(result.stdout);
}

function parseApiJson(stdout: string): JsonEvidenceValue {
  try {
    return parseJsonEvidence(stdout);
  } catch {
    fail("gitlab-response-invalid");
  }
}

async function requireGit(
  commands: ReadOnlyCommandRunner,
  cwd: string,
  args: readonly string[],
  code: LocalUserPublicationFailureCode,
): Promise<string> {
  const result = await runGit(commands, args, cwd);
  if (result.exitCode !== 0 || !result.stdout.trim()) fail(code);
  return result.stdout;
}

async function requireCommand(
  commands: ReadOnlyCommandRunner,
  command: "git" | "glab",
  args: readonly string[],
  cwd: string,
  code: LocalUserPublicationFailureCode,
): Promise<string> {
  const result = await commands.run(command, args, cwd);
  if (result.exitCode !== 0 || !result.stdout.trim()) fail(code);
  return result.stdout;
}

async function requireSuccess(
  commands: ReadOnlyCommandRunner,
  command: "git" | "glab",
  args: readonly string[],
  cwd: string,
  code: LocalUserPublicationFailureCode,
): Promise<void> {
  const result =
    command === "git" ? await runGit(commands, args, cwd) : await commands.run(command, args, cwd);
  if (result.exitCode !== 0) fail(code);
}

async function requireGlabHostAuthentication(
  commands: ReadOnlyCommandRunner,
  cwd: string,
  host: string,
): Promise<void> {
  const result = await commands.run("glab", ["auth", "status", "--hostname", host], cwd);
  if (result.exitCode === 0) return;
  fail(await classifyFailedGlabCommand(commands, cwd, host, result, "auth-status"));
}

async function classifyFailedGlabCommand(
  commands: ReadOnlyCommandRunner,
  cwd: string,
  host: string,
  result: ReadOnlyCommandResult,
  kind: "auth-status" | "api",
): Promise<LocalUserPublicationFailureCode> {
  const probe = await commands.run("glab", ["config", "get", "token", "--host", host], cwd);
  const cls = classifyGlabCommandFailure({
    kind,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    tokenProbe: tokenProbeFromExitCode(probe.exitCode),
  });
  if (cls === "ok") return "gitlab-response-invalid";
  return publicationCodeForGlabAuthClass(cls);
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: "/dev/null",
    XDG_CONFIG_HOME: "/dev/null",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    // Like the hosted trusted Git path, ignore local graft metadata when
    // proving the published branch's ancestry.
    GIT_GRAFT_FILE: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS: "/usr/bin/false",
    GIT_PAGER: "cat",
    GIT_ALLOW_PROTOCOL: "file",
  };
}

async function runGit(
  commands: ReadOnlyCommandRunner,
  args: readonly string[],
  cwd: string,
): Promise<ReadOnlyCommandResult> {
  return commands.run("git", [...SAFE_GIT_CONFIG, ...args], cwd, {
    env: gitEnvironment(),
  });
}

/**
 * The publisher's Git environment, less what a configuration read does not
 * need: the SSH agent socket and the login names.
 */
function configurationReadEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = publisherGitEnvironment(environment);
  for (const name of ["SSH_AUTH_SOCK", "USER", "LOGNAME"]) delete env[name];
  return env;
}

/**
 * Refuse, before any model call, a Git setting the host publisher would
 * refuse (#2363). This reads the configuration the publisher will read, this
 * checkout with the operator's global and system files, under the publisher's
 * Git environment and the publisher's output bound, and applies the
 * publisher's own policy to it (`git-config-policy.ts`). A refusal names the
 * setting and where it is set. A listing that fails, overruns the bound, or does
 * not parse is `git-checkout-unverified`, as it is at publication; an overrun
 * names the limit. `git config --list` runs no configured command.
 */
async function rejectRefusedGitConfiguration(
  commands: ReadOnlyCommandRunner,
  cwd: string,
  host: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const bound = limit(GIT_CONFIGURATION_LISTING_LIMIT);
  const result = await commands.run(
    "git",
    [...HOST_GIT_CONFIG_FLAGS, ...GIT_CONFIGURATION_LIST_ARGS],
    cwd,
    { env: configurationReadEnvironment(environment), maxOutputBytes: bound.value },
  );
  if (result.failure === "output-limit") {
    fail("git-checkout-unverified", { limitRefusal: formatLimitExceeded(bound) });
  }
  if (result.exitCode !== 0) fail("git-checkout-unverified");
  const assessment = assessGitConfigurationList(
    result.stdout,
    await resolveGitConfigurationPaths({
      home: environment.HOME,
      host,
      repositoryRoots: [cwd],
    }),
  );
  if (assessment.status === "unreadable") fail("git-checkout-unverified");
  if (assessment.status === "refused") {
    fail("git-configuration-refused", {
      configuration: {
        key: assessment.setting,
        // `~` would hide where such a file is: a relative `HOME` names a path in the checkout.
        origin: assessment.reason
          ? assessment.origin
          : displayGitConfigurationOrigin(assessment.origin, environment.HOME),
        ...(assessment.reason ? { reason: assessment.reason } : {}),
      },
    });
  }
}

async function rejectExecutableGitConfiguration(
  commands: ReadOnlyCommandRunner,
  cwd: string,
): Promise<void> {
  const result = await runGit(commands, ["config", "--local", "--null", "--list"], cwd);
  if (result.exitCode !== 0) fail("unsafe-git-configuration");
  for (const entry of result.stdout.split("\0").filter(Boolean)) {
    const key = entry.slice(0, entry.indexOf("\n")).toLowerCase();
    if (
      /^(?:include(?:if\..*)?\.path|core\.(?:hookspath|fsmonitor)|diff\.external|diff\..*\.(?:command|textconv)|filter\..*\.(?:clean|smudge|process|required))$/su.test(
        key,
      )
    ) {
      fail("unsafe-git-configuration");
    }
  }
}

function validateInput(input: LocalUserPublicationPreflightInput): void {
  if (input.advance !== undefined) assertLocalUserPublicationAdvance(input.advance);
  if (
    input.draftMergeRequest !== true ||
    typeof input.runId !== "string" ||
    !SAFE_ID.test(input.runId) ||
    typeof input.runRecordPath !== "string" ||
    typeof input.repositoryPath !== "string" ||
    !isAbsolute(input.runRecordPath) ||
    !isAbsolute(input.repositoryPath)
  )
    fail("invalid-input");
}

async function canonicalDirectory(path: string): Promise<string> {
  return realpath(resolve(path));
}

function safeValidationCommand(value: string): boolean {
  return (
    SAFE_VALIDATION.test(value) &&
    value.trim() === value &&
    !/\b(?:token|secret|password|credential|bearer)\b/iu.test(value)
  );
}

/**
 * Bind the default documentation validation to the candidate delivery validates
 * (#2359): the run base plus the verified patch, read from Git objects into a
 * private copy under DocsFab's state root and removed afterwards. Deriving it
 * from the operator checkout instead names a tree delivery never sees.
 */
async function selectDefaultDocumentationValidation(
  run: VerifiedPublicationRun,
  host: {
    projectId: number;
    host: string;
    projectPath: string;
    artifactStoreRoot: string;
    candidateParentDirectory: string;
    validationCandidate?: typeof withDocumentationValidationCandidate;
  },
) {
  try {
    const changedPaths = run.changedFiles.flatMap((file) => [
      ...(file.previousPath && file.status === "renamed"
        ? [{ path: file.previousPath, status: "deleted" as const }]
        : []),
      {
        path: file.path,
        status:
          file.status === "unknown"
            ? ("modified" as const)
            : file.status === "untracked"
              ? ("added" as const)
              : file.status,
      },
    ]);
    const derive = (candidateRoot: string) =>
      deriveDocumentationSourceApplicability({
        candidateRoot,
        repositoryIdentitySha256: documentationRepositoryIdentitySha256({
          host: host.host,
          path: host.projectPath,
          projectId: host.projectId,
        }),
        baseRevision: run.revision,
        candidateInputTreeSha256: documentationCandidateInputTreeSha256({
          baseRevision: run.revision,
          patchSha256: run.patch.sha256,
        }),
        changedPaths,
        baseConfigurationPaths: run.changedFiles
          .filter((file) => file.status === "deleted" || file.status === "renamed")
          .flatMap((file) => [file.previousPath ?? file.path])
          .filter(isDocumentationSourceConfigurationPath),
        authorizedRootConfigurationChange: false,
      });
    let applicability: Awaited<ReturnType<typeof derive>>;
    try {
      applicability = await (host.validationCandidate ?? withDocumentationValidationCandidate)(
        {
          repositoryPath: run.sourcePath,
          baseRevision: run.revision,
          patchBytes: run.patchBytes,
          parentDirectory: host.candidateParentDirectory,
        },
        derive,
      );
    } catch (error) {
      // Git or the filesystem failed to build the copy: refuse with a cause
      // instead of binding a tree delivery never validates.
      if (error instanceof DocumentationValidationCandidateError) {
        fail("validation-candidate-unavailable");
      }
      if (!(error instanceof DocumentationValidationPatchConflictError)) throw error;
      // The patch does not apply to the run base. Delivery runs the same
      // `git apply --check` and refuses first, with its own code
      // (patch-conflict), so bind the checkout as before and let that refusal
      // name the cause.
      applicability = await derive(run.sourcePath);
    }
    await storeDocumentationSourceApplicability(
      new DurableArtifactStore(host.artifactStoreRoot),
      applicability,
    );
    return selectDocumentationValidationProfile({
      workflow: run.workflow,
      changedPaths: run.changedFiles.flatMap((file) =>
        file.previousPath ? [file.path, file.previousPath] : [file.path],
      ),
      hostPolicySha256: validationBackendPolicySha256(),
      applicabilitySha256: applicability.applicabilitySha256,
    });
  } catch (error) {
    if (error instanceof DocumentationValidationError) fail("invalid-input");
    throw error;
  }
}

function accessLevel(value: JsonEvidenceValue | undefined): number {
  if (
    !object(value) ||
    typeof value.access_level !== "number" ||
    !Number.isSafeInteger(value.access_level) ||
    value.access_level < 0 ||
    value.access_level > 100
  )
    return 0;
  return value.access_level;
}
