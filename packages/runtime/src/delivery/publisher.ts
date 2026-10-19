// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  LocalUserPublicationPreflightError,
  LOCAL_USER_MINIMUM_PUSH_ACCESS_LEVEL,
  assertCurrentLocalUserPublicationAuthorization,
  assertLocalUserPublicationPlan,
  containsConfiguredCredentialText,
  localUserPublicationAdvance,
  requireFreshDocumentationPlanForMutation,
  type LocalUserPublicationAuthorizationV1,
  type LocalUserPublicationPlan,
} from "./contracts.js";
import type { VerifiedPublicationRun } from "./preflight.js";
import {
  confirmScmDeliveryObservation,
  createScmDeliveryRecord,
  failScmDeliveryRecord,
  issueScmPublishedTerminalCapability,
  recordScmDeliveryProgress,
  reconcileScmDelivery,
  recoverScmDeliveryPatch,
  scmDeliveryFailureNextAction,
  scmDeliveryIdempotencyKey,
  validationEvidenceFromReadyAttestation,
  type ScmDeliveryFailureCode,
  type ScmDeliveryObservationV1,
  type ScmDeliveryRecord,
  type ScmDeliveryState,
  type ScmPublishedTerminalCapability,
} from "./receipt.js";
import type { ScmDeliveryReceiptStore } from "./receipt-store.js";
import {
  assertDeliveryWorktreeReadyAttestation,
  readPreservedDeliveryPatch,
  type DeliveryWorktreeCapability,
  type DeliveryWorktreeReadyAttestation,
} from "./worktree.js";
import {
  buildDocsFabPublicationMetadata,
  buildRunPublicationMetadata,
  hasExactDocsFabPublicationMetadata,
  publicationMetadataInputDigests,
  compositionPublicationBindingFromMetadata,
  type DocsFabPublicationMetadata,
} from "./metadata.js";
import {
  DeterministicLocalGitPublisher,
  GitPublisherError,
  type LocalGitPublisher,
} from "./git-publisher.js";
import {
  GitLabPublisherAdapterError,
  LocalUserGitLabPublisherAdapter,
  type GitLabMergeRequest,
  type GitLabPublisherAdapter,
} from "./gitlab-adapter.js";
import { runtimeEgressRootSet } from "../config/egress-roots.js";
import { deepFreeze } from "../contract-kit/freeze.js";
import type { PublicationEvidenceProjectionV1 } from "../publication/index.js";
import type { CredentialFinding } from "../security/credential-findings.js";
import type { HostRootSet } from "../security/egress.js";
import type { WorkflowOutcomeEnvelopeV1, WorkflowName } from "../workflow-contracts/contracts.js";

const RANK: Record<ScmDeliveryState, number> = {
  planned: 0,
  prepared: 1,
  validated: 2,
  committed: 3,
  pushed: 4,
  opened: 5,
};
const mergeRequestLocks = new Map<string, Promise<void>>();

export type LocalUserGitLabPublisherFailureCode =
  | ScmDeliveryFailureCode
  | "authorization-expired"
  | "invalid-input"
  | "receipt-conflict";

export class LocalUserGitLabPublisherError extends Error {
  public readonly recoveryCommand?: string;

  public constructor(
    public readonly code: LocalUserGitLabPublisherFailureCode,
    options: { readonly recoveryCommand?: string } = {},
  ) {
    super(`Local-user GitLab publication failed (${code}).`);
    this.name = "LocalUserGitLabPublisherError";
    if (options.recoveryCommand !== undefined) this.recoveryCommand = options.recoveryCommand;
  }
}

export interface LocalUserGitLabPublisherHooks {
  /** Crash-injection seams after the commit, push, and MR advances; throwing stops the next step. */
  afterCommit?: (revision: string) => void | Promise<void>;
  afterPush?: (revision: string) => void | Promise<void>;
  afterMergeRequest?: (mergeRequest: GitLabMergeRequest) => void | Promise<void>;
}

export interface PublishLocalUserGitLabInput {
  plan: LocalUserPublicationPlan;
  authorization: LocalUserPublicationAuthorizationV1;
  worktree: DeliveryWorktreeCapability;
  readyAttestation: DeliveryWorktreeReadyAttestation;
  receiptStore: ScmDeliveryReceiptStore;
  workflowOutcome: string;
  changedPaths: readonly string[];
  workflowId?: WorkflowName;
  instruction?: string;
  requestSha256?: string | null;
  productOutcome?: WorkflowOutcomeEnvelopeV1;
  /** The run's "required check could not run" lines (#1918), for the draft MR's Notes. */
  requiredCheckLimitations?: readonly string[];
  /** Fully scoped, credential-free operator retry command supplied by the execute CLI. */
  recoveryCommand?: string;
  /**
   * Evidence projection from this run's task lineage. When absent, the commit
   * and draft-MR narrative use the bounded fallback. Passed verbatim on every
   * retry so the metadata stays deterministic.
   */
  evidence?: PublicationEvidenceProjectionV1;
  /**
   * Content-free `credential-like-content` findings from the verified run
   * record (#1807), listed in the draft MR's Notes block. Passed verbatim on
   * every retry so the metadata stays deterministic.
   */
  credentialFindings?: readonly CredentialFinding[];
  /**
   * The first publication of the chain an advance plan revises: its stored
   * plan and its verified run record. Its metadata is rebuilt from them, so MR
   * reuse checks the marker the MR was opened with. Required exactly when the
   * plan advances an existing branch.
   */
  advanceRoot?: {
    plan: LocalUserPublicationPlan;
    run: VerifiedPublicationRun;
  };
}

export interface LocalUserGitLabPublisherDependencies {
  git?: LocalGitPublisher;
  gitlab?: GitLabPublisherAdapter;
  clock?: () => Date;
  hooks?: LocalUserGitLabPublisherHooks;
  /** Test seam; production always uses the opaque attestation verifier. */
  assertReady?: (
    attestation: DeliveryWorktreeReadyAttestation,
    worktree: DeliveryWorktreeCapability,
  ) => Promise<void>;
  /** Test seam; production reads only through the opaque worktree capability. */
  readPatch?: (worktree: DeliveryWorktreeCapability) => Promise<Uint8Array>;
}

/**
 * Adapter for a trusted host publisher that must consume the existing
 * process-local interactive-once capability without serializing or minting it.
 */
export function createLocalUserPublicationAuthorityValidator(): {
  assertCurrent(input: {
    plan: LocalUserPublicationPlan;
    authorization: LocalUserPublicationAuthorizationV1;
    now: Date;
  }): void;
} {
  return Object.freeze({
    assertCurrent(input) {
      assertLocalUserPublicationPlan(input.plan);
      assertCurrentLocalUserPublicationAuthorization(input.authorization, input.plan, input.now);
    },
  });
}

export type PublishLocalUserGitLabResult =
  | {
      status: "opened";
      record: ScmDeliveryRecord;
      mergeRequest: GitLabMergeRequest & { draft: true };
      observation: ScmDeliveryObservationV1;
      terminalCapability: ScmPublishedTerminalCapability;
    }
  | {
      status: "failed";
      code: LocalUserGitLabPublisherFailureCode;
      record: ScmDeliveryRecord;
      lastConfirmedState: ScmDeliveryState;
      nextAction: string;
      recoveryCommand: string;
    };

/** Execute or reconcile the exact authorized local-user publication. */
export async function publishLocalUserGitLab(
  input: PublishLocalUserGitLabInput,
  dependencies: LocalUserGitLabPublisherDependencies = {},
): Promise<PublishLocalUserGitLabResult> {
  // Without a supplied adapter, the host's own, which counts the source checkout as repository content.
  const sourceCheckout = input.worktree?.repositoryPath;
  const git =
    dependencies.git ??
    new DeterministicLocalGitPublisher(undefined, undefined, {
      repositoryRoots: typeof sourceCheckout === "string" ? [sourceCheckout] : [],
    });
  const gitlab = dependencies.gitlab ?? new LocalUserGitLabPublisherAdapter();
  const clock = dependencies.clock ?? (() => new Date());
  const assertReady = dependencies.assertReady ?? assertDeliveryWorktreeReadyAttestation;
  const readPatch = dependencies.readPatch ?? readPreservedDeliveryPatch;
  const capabilityWorktree = input.worktree;
  const capabilityAttestation = input.readyAttestation;
  let metadata: DocsFabPublicationMetadata;
  // The metadata the MR was opened with; an advance reuses the chain root's MR.
  let rootMetadata: DocsFabPublicationMetadata;
  try {
    const plan = structuredClone(input.plan);
    assertLocalUserPublicationPlan(plan);
    deepFreeze(plan);
    const readyAttestation = deepFreeze(structuredClone(input.readyAttestation));
    const worktree = deepFreeze({
      ...structuredClone(input.worktree),
      worktreePath: readyAttestation.worktreePath,
    });
    const changedPaths = Object.freeze([...input.changedPaths]);
    input = { ...input, plan, readyAttestation, worktree, changedPaths };
    const prior = await input.receiptStore.load(scmDeliveryIdempotencyKey(input.plan));
    requireFreshDocumentationPlanForMutation(input.plan, true, prior?.disposition);
    if (
      input.recoveryCommand !== undefined &&
      (input.recoveryCommand.length === 0 ||
        input.recoveryCommand.length > 8_192 ||
        /[\0\r\n]/u.test(input.recoveryCommand) ||
        containsConfiguredCredentialText(input.recoveryCommand, "publication:recoveryCommand"))
    ) {
      throw new Error("unsafe recovery command");
    }
    currentAuthorization(input, clock);
    await assertReady(capabilityAttestation, capabilityWorktree);
    const compositionExecution = compositionPublicationBindingFromMetadata(
      input.readyAttestation.metadata,
    );
    metadata = buildDocsFabPublicationMetadata({
      plan: input.plan,
      workflowOutcome: input.workflowOutcome,
      changedPaths: input.changedPaths,
      ...(input.workflowId ? { workflowId: input.workflowId } : {}),
      ...(input.instruction !== undefined ? { instruction: input.instruction } : {}),
      ...(input.requestSha256 !== undefined ? { requestSha256: input.requestSha256 } : {}),
      ...(input.productOutcome ? { productOutcome: input.productOutcome } : {}),
      ...(input.requiredCheckLimitations
        ? { requiredCheckLimitations: input.requiredCheckLimitations }
        : {}),
      ...(input.evidence ? { evidence: input.evidence } : {}),
      ...(compositionExecution ? { compositionExecution } : {}),
      ...(input.credentialFindings ? { credentialFindings: input.credentialFindings } : {}),
      hostRoots: deliveryHostRoots(input.worktree.worktreePath),
    });
    const metadataInputs = publicationMetadataInputDigests(
      input.workflowOutcome,
      input.changedPaths,
      compositionExecution,
    );
    if (
      metadataInputs.workflowOutcomeSha256 !==
        input.readyAttestation.metadata.workflowOutcomeSha256 ||
      metadataInputs.changedPathsSha256 !== input.readyAttestation.metadata.changedPathsSha256 ||
      metadataInputs.selectedCompositionId !==
        input.readyAttestation.metadata.selectedCompositionId ||
      metadataInputs.compositionEvidenceSha256 !==
        input.readyAttestation.metadata.compositionEvidenceSha256 ||
      metadataInputs.compositionAggregateSha256 !==
        input.readyAttestation.metadata.compositionAggregateSha256 ||
      metadataInputs.compositionMarkerSha256 !==
        input.readyAttestation.metadata.compositionMarkerSha256
    ) {
      throw new Error("metadata input drift");
    }
    rootMetadata = advanceRootMetadata(input, metadata);
    await assertReady(capabilityAttestation, capabilityWorktree);
  } catch (error) {
    throw new LocalUserGitLabPublisherError(
      error instanceof LocalUserPublicationPreflightError && error.code === "authorization-expired"
        ? "authorization-expired"
        : "invalid-input",
    );
  }

  const initial = createScmDeliveryRecord({
    plan: input.plan,
    authorization: input.authorization,
    createdAt: clock().toISOString(),
  });
  let record: ScmDeliveryRecord;
  try {
    record = (await input.receiptStore.claim(initial)).record;
    if (
      record.planSha256 !== input.plan.sha256 ||
      record.idempotencyKey !== scmDeliveryIdempotencyKey(input.plan)
    ) {
      throw new Error("receipt mismatch");
    }
  } catch {
    throw new LocalUserGitLabPublisherError("receipt-conflict");
  }

  if (RANK[record.state] >= RANK.committed) {
    let observed: ScmDeliveryObservationV1;
    try {
      observed = await observeLocalUserGitLabDelivery({
        ...input,
        record,
        metadata,
        rootMetadata,
        git,
        gitlab,
        clock,
      });
    } catch (error) {
      return observationFailure(input, record, error, clock, capabilityWorktree, readPatch);
    }
    const reconciliation = reconcileScmDelivery(record, observed, input.plan);
    if (reconciliation.decision === "recover-patch-only") {
      return persistPatchRecovery(
        input,
        record,
        reconciliation.failureCode ?? "authentication-unavailable",
        reconciliation.failureCode === "authentication-unavailable" ||
          reconciliation.failureCode === "authentication-revoked"
          ? "authentication-unavailable"
          : "external-drift",
        clock,
        capabilityWorktree,
        readPatch,
      );
    }
    if (reconciliation.failureCode) {
      if (record.disposition === "succeeded") {
        return {
          status: "failed",
          code: reconciliation.failureCode,
          record,
          lastConfirmedState: record.state,
          nextAction: reconciliation.nextAction,
          recoveryCommand: recoveryCommand(input, record),
        };
      }
      return persistFailure(input, record, reconciliation.failureCode, clock);
    }
  }

  const policyFailure = await freshPolicy(input, git, gitlab, clock, rootMetadata);
  if (policyFailure) {
    return handlePolicyFailure(input, record, policyFailure, clock, capabilityWorktree, readPatch);
  }

  if (RANK[record.state] < RANK.prepared) {
    currentAuthorization(input, clock);
    await assertReady(capabilityAttestation, capabilityWorktree);
    record = await advance(input, record, {
      toState: "prepared",
      source: "executed",
      at: nextTime(record, clock),
      evidence: {
        workspaceKey: input.readyAttestation.workspaceKey,
        baseRevision: input.readyAttestation.baseRevision,
      },
    });
  }
  if (RANK[record.state] < RANK.validated) {
    currentAuthorization(input, clock);
    await assertReady(capabilityAttestation, capabilityWorktree);
    record = await advance(input, record, {
      toState: "validated",
      source: "executed",
      at: nextTime(record, clock),
      evidence: {
        ...validationEvidenceFromReadyAttestation(input.readyAttestation.validation),
      },
    });
  }

  if (RANK[record.state] < RANK.committed) {
    const failure = await freshPolicy(input, git, gitlab, clock, rootMetadata);
    if (failure) {
      return handlePolicyFailure(input, record, failure, clock, capabilityWorktree, readPatch);
    }
    await assertReady(capabilityAttestation, capabilityWorktree);
    let commit: string;
    try {
      currentAuthorization(input, clock);
      commit = await git.ensureCommit({
        plan: input.plan,
        ready: input.readyAttestation,
        commitMessage: metadata.commitMessage,
        cwd: input.worktree.worktreePath,
        assertAuthorized: () => currentAuthorization(input, clock),
      });
    } catch (error) {
      if (
        error instanceof LocalUserPublicationPreflightError &&
        error.code === "authorization-expired"
      ) {
        return handleFailure(input, record, "authorization-expired", clock);
      }
      return persistFailure(
        input,
        record,
        gitConfigurationFailure(error) ?? "commit-failed",
        clock,
      );
    }
    record = await advance(input, record, {
      toState: "committed",
      source: "executed",
      at: nextTime(record, clock),
      evidence: { sha: commit },
    });
    await dependencies.hooks?.afterCommit?.(commit);
  }

  const commit = record.evidence.commit?.sha;
  if (!commit) throw new LocalUserGitLabPublisherError("receipt-conflict");
  if (RANK[record.state] < RANK.pushed) {
    const failure = await freshPolicy(input, git, gitlab, clock, rootMetadata);
    if (failure) {
      return handlePolicyFailure(input, record, failure, clock, capabilityWorktree, readPatch);
    }
    let remote: string;
    try {
      await git.assertCommit({
        plan: input.plan,
        ready: input.readyAttestation,
        commitMessage: metadata.commitMessage,
        commitRevision: commit,
        cwd: input.worktree.worktreePath,
      });
      currentAuthorization(input, clock);
      remote = await git.ensurePush({
        plan: input.plan,
        commitRevision: commit,
        cwd: input.worktree.worktreePath,
        assertAuthorized: () => currentAuthorization(input, clock),
      });
    } catch (error) {
      if (
        error instanceof LocalUserPublicationPreflightError &&
        error.code === "authorization-expired"
      ) {
        return handleFailure(input, record, "authorization-expired", clock);
      }
      return persistFailure(
        input,
        record,
        gitConfigurationFailure(error) ??
          (error instanceof GitPublisherError && error.code === "remote-branch-conflict"
            ? "remote-drift"
            : "push-failed"),
        clock,
      );
    }
    record = await advance(input, record, {
      toState: "pushed",
      source: "executed",
      at: nextTime(record, clock),
      evidence: { remoteRevision: remote },
    });
    await dependencies.hooks?.afterPush?.(remote);
  }

  if (RANK[record.state] < RANK.opened) {
    const failure = await freshPolicy(input, git, gitlab, clock, rootMetadata);
    if (failure) {
      return handlePolicyFailure(input, record, failure, clock, capabilityWorktree, readPatch);
    }
    try {
      await git.assertCommit({
        plan: input.plan,
        ready: input.readyAttestation,
        commitMessage: metadata.commitMessage,
        commitRevision: commit,
        cwd: input.worktree.worktreePath,
      });
      const remoteRevision = await git.remoteBranchRevision(
        input.plan,
        input.worktree.worktreePath,
      );
      if (remoteRevision === undefined) {
        return persistFailure(input, record, "remote-branch-deleted", clock);
      }
      if (remoteRevision !== commit) return persistFailure(input, record, "remote-drift", clock);
    } catch {
      return persistFailure(input, record, "receipt-drift", clock);
    }
    let mergeRequest: GitLabMergeRequest;
    try {
      const createOrAdopt = () =>
        ensureMergeRequest(input, git, gitlab, metadata, rootMetadata, commit, clock);
      mergeRequest = input.receiptStore.withMergeRequestLease
        ? await input.receiptStore.withMergeRequestLease(record.idempotencyKey, createOrAdopt)
        : await withMergeRequestLock(record.idempotencyKey, createOrAdopt);
    } catch (error) {
      if (error instanceof LocalUserGitLabPublisherError) {
        return handlePolicyFailure(input, record, error.code, clock, capabilityWorktree, readPatch);
      }
      if (
        error instanceof LocalUserPublicationPreflightError &&
        error.code === "authorization-expired"
      ) {
        return handleFailure(input, record, "authorization-expired", clock);
      }
      return persistFailure(input, record, "merge-request-open-failed", clock);
    }
    record = await advance(input, record, {
      toState: "opened",
      source: "executed",
      at: nextTime(record, clock),
      evidence: {
        iid: mergeRequest.iid,
        url: mergeRequest.url,
        state: "opened",
        draft: true,
        sourceBranch: mergeRequest.sourceBranch,
        targetBranch: mergeRequest.targetBranch,
        headRevision: mergeRequest.headRevision,
      },
    });
    await dependencies.hooks?.afterMergeRequest?.(mergeRequest);
  }

  let observation: ScmDeliveryObservationV1;
  try {
    observation = await observeLocalUserGitLabDelivery({
      ...input,
      record,
      metadata,
      rootMetadata,
      git,
      gitlab,
      clock,
    });
  } catch (error) {
    return observationFailure(input, record, error, clock, capabilityWorktree, readPatch);
  }
  if (
    observation.authentication !== "available" ||
    observation.localCommit.status !== "matching" ||
    observation.remoteBranch.status !== "matching" ||
    observation.mergeRequest.status !== "opened"
  ) {
    const reconciliation = reconcileScmDelivery(record, observation, input.plan);
    return transientFailure(
      input,
      record,
      reconciliation.failureCode ?? "receipt-drift",
      reconciliation.nextAction,
    );
  }
  const confirmation = confirmScmDeliveryObservation({
    record,
    observation,
    plan: input.plan,
    authorization: input.authorization,
  });
  const terminalCapability = issueScmPublishedTerminalCapability({
    record,
    plan: input.plan,
    authorization: input.authorization,
    replay: { observation, confirmation },
  });
  return {
    status: "opened",
    record,
    mergeRequest: {
      iid: observation.mergeRequest.iid,
      url: observation.mergeRequest.url,
      state: "opened",
      draft: true,
      sourceBranch: observation.mergeRequest.sourceBranch,
      targetBranch: observation.mergeRequest.targetBranch,
      headRevision: observation.mergeRequest.headRevision,
    },
    observation,
    terminalCapability,
  };
}

export async function observeLocalUserGitLabDelivery(input: {
  plan: LocalUserPublicationPlan;
  authorization: LocalUserPublicationAuthorizationV1;
  worktree: DeliveryWorktreeCapability;
  readyAttestation: DeliveryWorktreeReadyAttestation;
  record: ScmDeliveryRecord;
  metadata: DocsFabPublicationMetadata;
  /** The metadata the MR carries; defaults to `metadata`, which an advance cannot use. */
  rootMetadata?: DocsFabPublicationMetadata;
  git: LocalGitPublisher;
  gitlab: GitLabPublisherAdapter;
  clock: () => Date;
}): Promise<ScmDeliveryObservationV1> {
  const advance = localUserPublicationAdvance(input.plan);
  const rootMetadata = input.rootMetadata ?? input.metadata;
  if (advance && input.rootMetadata === undefined) refuse("invalid-input");
  let authentication: ScmDeliveryObservationV1["authentication"] = "available";
  try {
    currentAuthorization(input, input.clock);
    const policy = await input.gitlab.inspectPolicy(input.plan, input.worktree.worktreePath);
    if (policy.username !== input.plan.identity.gitlabUsername) authentication = "revoked";
  } catch (error) {
    authentication =
      error instanceof GitLabPublisherAdapterError &&
      (error.code === "authentication-unavailable" || error.code === "host-unreachable")
        ? "unavailable"
        : "revoked";
  }
  const localRevision = await input.git.localBranchRevision(
    input.plan,
    input.worktree.worktreePath,
  );
  let localCommit: ScmDeliveryObservationV1["localCommit"] = {
    status: "absent",
  };
  if (localRevision && localRevision !== input.plan.baseRevision) {
    try {
      await input.git.assertCommit({
        plan: input.plan,
        ready: input.readyAttestation,
        commitMessage: input.metadata.commitMessage,
        commitRevision: localRevision,
        cwd: input.worktree.worktreePath,
      });
      localCommit = { status: "matching", revision: localRevision };
    } catch {
      localCommit = { status: "conflict", revision: localRevision };
    }
  }
  const remoteRevision = await input.git.remoteBranchRevision(
    input.plan,
    input.worktree.worktreePath,
  );
  const remoteBranch: ScmDeliveryObservationV1["remoteBranch"] =
    remoteRevision === undefined
      ? advance !== undefined || RANK[input.record.state] >= RANK.pushed
        ? { status: "deleted" }
        : { status: "absent" }
      : localCommit.status === "matching" && localCommit.revision === remoteRevision
        ? { status: "matching", revision: remoteRevision }
        : { status: "conflict", revision: remoteRevision };
  const requests =
    authentication === "available"
      ? await input.gitlab.findMergeRequests(input.plan, input.worktree.worktreePath)
      : [];
  let mergeRequest: ScmDeliveryObservationV1["mergeRequest"] = {
    status: "absent",
  };
  if (requests.length === 1) {
    const request = requests[0]!;
    // An advance reuses the parent's draft MR, whose head is the observed head
    // until the push and the new commit after it; reconciliation decides which
    // of the two the receipt state allows.
    const headMatches = advance
      ? request.iid === advance.mergeRequest.iid &&
        request.draft &&
        (request.headRevision === advance.observedHead ||
          (localCommit.status === "matching" && request.headRevision === localCommit.revision))
      : localCommit.status === "matching" && request.headRevision === localCommit.revision;
    const exact =
      request.sourceBranch === input.plan.proposedSourceBranch &&
      request.targetBranch === input.plan.targetBranch.name &&
      request.sourceProjectId === input.plan.project.id &&
      request.targetProjectId === input.plan.project.id &&
      hasExactDocsFabPublicationMetadata(request.title, request.description, rootMetadata) &&
      headMatches;
    mergeRequest = {
      iid: request.iid,
      url: request.url,
      status: exact ? request.state : "conflict",
      draft: true,
      sourceBranch: request.sourceBranch,
      targetBranch: request.targetBranch,
      headRevision: request.headRevision,
    };
  } else if (requests.length > 1) {
    const request = requests[0]!;
    mergeRequest = {
      iid: request.iid,
      url: request.url,
      status: "conflict",
      draft: true,
      sourceBranch: request.sourceBranch,
      targetBranch: request.targetBranch,
      headRevision: request.headRevision,
    };
  }
  return {
    schemaVersion: 1,
    kind: "docsfab-scm-delivery-observation",
    idempotencyKey: input.record.idempotencyKey,
    planSha256: input.plan.sha256,
    authentication,
    worktree: "matching",
    validation: "passed",
    localCommit,
    remoteBranch,
    mergeRequest,
  };
}

async function freshPolicy(
  input: Pick<PublishLocalUserGitLabInput, "plan" | "authorization" | "worktree">,
  git: LocalGitPublisher,
  gitlab: GitLabPublisherAdapter,
  clock: () => Date,
  rootMetadata: DocsFabPublicationMetadata,
): Promise<LocalUserGitLabPublisherFailureCode | undefined> {
  try {
    currentAuthorization(input, clock);
    if (input.plan.proposedSourceBranch === input.plan.targetBranch.name) return "remote-drift";
    const policy = await gitlab.inspectPolicy(input.plan, input.worktree.worktreePath);
    if (policy.username !== input.plan.identity.gitlabUsername) return "authentication-revoked";
    if (
      policy.projectId !== input.plan.project.id ||
      policy.projectPath !== input.plan.project.path ||
      policy.accessLevel < LOCAL_USER_MINIMUM_PUSH_ACCESS_LEVEL ||
      policy.targetBranch.name !== input.plan.targetBranch.name ||
      policy.targetBranch.protected !== input.plan.targetBranch.protected ||
      input.plan.proposedSourceBranch === policy.defaultBranch ||
      input.plan.proposedSourceBranch === policy.targetBranch.name ||
      policy.sourceBranchProtected
    ) {
      return "remote-drift";
    }
    await git.assertConfiguredIdentity(input.plan, input.worktree.worktreePath);
    const advance = localUserPublicationAdvance(input.plan);
    if (advance) {
      // The lease guards the branch, not the MR: a merge, close, or undraft
      // since preflight must stop the advance before the commit and push.
      const requests = await gitlab.findMergeRequests(input.plan, input.worktree.worktreePath);
      const refusal = advanceMergeRequestRefusal(requests, input.plan, advance, rootMetadata);
      if (refusal) return refusal;
    }
    return undefined;
  } catch (error) {
    if (error instanceof LocalUserPublicationPreflightError) {
      return error.code === "authorization-expired"
        ? "authorization-expired"
        : "authentication-revoked";
    }
    if (error instanceof GitLabPublisherAdapterError) {
      if (error.code === "authentication-unavailable") return "authentication-unavailable";
      if (error.code === "authentication-revoked") return "authentication-revoked";
      if (error.code === "host-unreachable") return "remote-drift";
    }
    return gitConfigurationFailure(error) ?? "remote-drift";
  }
}

/**
 * The checkout's own Git state, not GitLab, stopped the publication: the
 * configured identity no longer matches the one the plan bound or is gone
 * (#2362), the Git configuration holds a setting the host refuses (#2363), or
 * the Git version, remote, or configuration could not be verified (#2363).
 * Each has its own code; `remote-drift` sent the operator to reconcile GitLab,
 * which had not changed.
 */
function gitConfigurationFailure(
  error: unknown,
): "git-identity-drift" | "git-configuration-refused" | "git-checkout-unverified" | undefined {
  if (!(error instanceof GitPublisherError)) return undefined;
  if (error.code === "identity-drift" || error.code === "missing-identity") {
    return "git-identity-drift";
  }
  if (error.code === "refused-configuration") return "git-configuration-refused";
  if (error.code === "unsafe-configuration") return "git-checkout-unverified";
  return undefined;
}

async function ensureMergeRequest(
  input: PublishLocalUserGitLabInput,
  git: LocalGitPublisher,
  gitlab: GitLabPublisherAdapter,
  metadata: DocsFabPublicationMetadata,
  rootMetadata: DocsFabPublicationMetadata,
  commit: string,
  clock: () => Date,
): Promise<GitLabMergeRequest & { draft: true }> {
  await assertMergeRequestBoundary(input, git, gitlab, metadata, rootMetadata, commit, clock);
  const advance = localUserPublicationAdvance(input.plan);
  if (advance) {
    return reuseAdvancedMergeRequest(input, gitlab, rootMetadata, commit, advance);
  }
  const existing = await gitlab.findMergeRequests(input.plan, input.worktree.worktreePath);
  if (existing.length > 1) throw new Error("ambiguous merge request");
  if (existing.length === 1) {
    const request = existing[0]!;
    if (
      request.state !== "opened" ||
      request.sourceBranch !== input.plan.proposedSourceBranch ||
      request.targetBranch !== input.plan.targetBranch.name ||
      request.headRevision !== commit ||
      request.sourceProjectId !== input.plan.project.id ||
      request.targetProjectId !== input.plan.project.id ||
      !hasExactDocsFabPublicationMetadata(request.title, request.description, metadata) ||
      !request.draft
    ) {
      throw new Error("merge request conflict");
    }
    return { ...request, draft: true };
  }
  await assertMergeRequestBoundary(input, git, gitlab, metadata, rootMetadata, commit, clock);
  currentAuthorization(input, clock);
  const opened = await gitlab.openDraftMergeRequest({
    plan: input.plan,
    cwd: input.worktree.worktreePath,
    title: metadata.mergeRequestTitle,
    description: metadata.mergeRequestDescription,
    metadata,
    headRevision: commit,
    assertAuthorized: () => currentAuthorization(input, clock),
  });
  const confirmed = await gitlab.findMergeRequests(input.plan, input.worktree.worktreePath);
  if (
    confirmed.length !== 1 ||
    confirmed[0]!.iid !== opened.iid ||
    confirmed[0]!.state !== "opened" ||
    confirmed[0]!.headRevision !== commit ||
    confirmed[0]!.targetBranch !== input.plan.targetBranch.name ||
    confirmed[0]!.sourceProjectId !== input.plan.project.id ||
    confirmed[0]!.targetProjectId !== input.plan.project.id ||
    !hasExactDocsFabPublicationMetadata(confirmed[0]!.title, confirmed[0]!.description, metadata) ||
    !confirmed[0]!.draft
  ) {
    throw new Error("merge request confirmation failed");
  }
  return { ...confirmed[0]!, draft: true };
}

/**
 * Adopt the parent's draft MR for an advance; it is never created. The MR must
 * still carry the root metadata it was opened with and point at the pushed
 * commit. GitLab refreshes an MR head after a push asynchronously, so a head
 * still at the observed head is a transient open failure the retry resolves.
 */
async function reuseAdvancedMergeRequest(
  input: PublishLocalUserGitLabInput,
  gitlab: GitLabPublisherAdapter,
  rootMetadata: DocsFabPublicationMetadata,
  commit: string,
  advance: NonNullable<ReturnType<typeof localUserPublicationAdvance>>,
): Promise<GitLabMergeRequest & { draft: true }> {
  const existing = await gitlab.findMergeRequests(input.plan, input.worktree.worktreePath);
  const refusal = advanceMergeRequestRefusal(existing, input.plan, advance, rootMetadata);
  if (refusal) refuse(refusal);
  const request = existing[0]!;
  if (request.headRevision !== commit) refuse("merge-request-open-failed");
  return { ...request, draft: true };
}

/**
 * Why an advance may not reuse its MR now, or undefined when it may: the MR
 * must be the one open draft on the plan's branch, target, and project, and
 * still carry the chain root's metadata.
 */
function advanceMergeRequestRefusal(
  requests: readonly GitLabMergeRequest[],
  plan: LocalUserPublicationPlan,
  advance: NonNullable<ReturnType<typeof localUserPublicationAdvance>>,
  rootMetadata: DocsFabPublicationMetadata,
): "revision-mr-not-open" | "merge-request-changed" | undefined {
  const request = requests.length === 1 ? requests[0]! : undefined;
  if (
    !request ||
    request.iid !== advance.mergeRequest.iid ||
    request.state !== "opened" ||
    !request.draft ||
    request.sourceBranch !== plan.proposedSourceBranch ||
    request.targetBranch !== plan.targetBranch.name ||
    request.sourceProjectId !== plan.project.id ||
    request.targetProjectId !== plan.project.id
  ) {
    return "revision-mr-not-open";
  }
  if (!hasExactDocsFabPublicationMetadata(request.title, request.description, rootMetadata)) {
    return "merge-request-changed";
  }
  return undefined;
}

/**
 * The root metadata an MR reuse compares against: this run's own for a first
 * publication, the chain root's, rebuilt from its plan and run record, for an advance.
 */
function advanceRootMetadata(
  input: PublishLocalUserGitLabInput,
  metadata: DocsFabPublicationMetadata,
): DocsFabPublicationMetadata {
  const advance = localUserPublicationAdvance(input.plan);
  if (!advance) {
    if (input.advanceRoot !== undefined) {
      refuse("invalid-input");
    }
    return metadata;
  }
  const root = input.advanceRoot;
  if (
    !root ||
    root.plan.schemaVersion === 3 ||
    root.plan.proposedSourceBranch !== input.plan.proposedSourceBranch ||
    root.run.id !== root.plan.run.id ||
    root.run.recordSha256 !== root.plan.run.recordSha256
  ) {
    refuse("invalid-input");
  }
  assertLocalUserPublicationPlan(root.plan);
  return buildRunPublicationMetadata(
    root.plan,
    root.run,
    deliveryHostRoots(input.worktree.worktreePath),
  );
}

async function assertMergeRequestBoundary(
  input: PublishLocalUserGitLabInput,
  git: LocalGitPublisher,
  gitlab: GitLabPublisherAdapter,
  metadata: DocsFabPublicationMetadata,
  rootMetadata: DocsFabPublicationMetadata,
  commit: string,
  clock: () => Date,
): Promise<void> {
  const failure = await freshPolicy(input, git, gitlab, clock, rootMetadata);
  if (failure) throw new LocalUserGitLabPublisherError(failure);
  try {
    await git.assertCommit({
      plan: input.plan,
      ready: input.readyAttestation,
      commitMessage: metadata.commitMessage,
      commitRevision: commit,
      cwd: input.worktree.worktreePath,
    });
    const remoteRevision = await git.remoteBranchRevision(input.plan, input.worktree.worktreePath);
    if (remoteRevision === undefined) {
      throw new LocalUserGitLabPublisherError("remote-branch-deleted");
    }
    if (remoteRevision !== commit) throw new LocalUserGitLabPublisherError("remote-drift");
    currentAuthorization(input, clock);
  } catch (error) {
    if (
      error instanceof LocalUserGitLabPublisherError ||
      error instanceof LocalUserPublicationPreflightError
    )
      throw error;
    throw new LocalUserGitLabPublisherError("receipt-drift");
  }
}

async function advance(
  input: PublishLocalUserGitLabInput,
  record: ScmDeliveryRecord,
  progress: Parameters<typeof recordScmDeliveryProgress>[1],
): Promise<ScmDeliveryRecord> {
  const next = recordScmDeliveryProgress(record, progress, input.plan, input.authorization);
  return input.receiptStore.compareAndSwap(record.sha256, next);
}

async function persistFailure(
  input: PublishLocalUserGitLabInput,
  record: ScmDeliveryRecord,
  code: ScmDeliveryFailureCode,
  clock: () => Date,
): Promise<PublishLocalUserGitLabResult> {
  const failed = failScmDeliveryRecord(
    record,
    {
      code,
      at: nextTime(record, clock),
    },
    input.plan,
  );
  const stored = await input.receiptStore.compareAndSwap(record.sha256, failed);
  return {
    status: "failed",
    code,
    record: stored,
    lastConfirmedState: stored.state,
    nextAction: stored.failure?.nextAction ?? "review-preserved-patch",
    recoveryCommand: recoveryCommand(input, stored),
  };
}

async function observationFailure(
  input: PublishLocalUserGitLabInput,
  record: ScmDeliveryRecord,
  error: unknown,
  clock: () => Date,
  worktree: DeliveryWorktreeCapability,
  readPatch: (worktree: DeliveryWorktreeCapability) => Promise<Uint8Array>,
): Promise<PublishLocalUserGitLabResult> {
  // The checkout's own Git state stopped the observation, not GitLab and not
  // the write (#2393). Report it and leave the receipt retryable: recovering it
  // to patch-only would end publication for a setting the operator can remove.
  // A succeeded or recovered receipt is settled and cannot record a failure, so
  // the stop is reported without rewriting it. A succeeded receipt has nothing
  // left to publish, so the operator fixes the checkout. A recovered one has
  // given up publishing and keeps only the preserved patch, so removing the
  // setting cannot publish it, and the next action is to review the patch.
  const gitFailure = gitConfigurationFailure(error);
  if (gitFailure) {
    if (record.disposition === "succeeded") {
      return transientFailure(input, record, gitFailure, scmDeliveryFailureNextAction(gitFailure));
    }
    if (record.disposition === "recovered") {
      return transientFailure(input, record, gitFailure, "review-preserved-patch");
    }
    return persistFailure(input, record, gitFailure, clock);
  }
  const code: ScmDeliveryFailureCode =
    error instanceof GitLabPublisherAdapterError && error.code === "authentication-revoked"
      ? "authentication-revoked"
      : error instanceof GitLabPublisherAdapterError && error.code === "authentication-unavailable"
        ? "authentication-unavailable"
        : error instanceof GitLabPublisherAdapterError && error.code === "host-unreachable"
          ? "remote-drift"
          : "receipt-drift";
  if (record.disposition === "succeeded") {
    return transientFailure(
      input,
      record,
      code,
      code === "receipt-drift" ? "review-preserved-patch" : "restore-authentication",
    );
  }
  return persistPatchRecovery(
    input,
    record,
    code,
    code === "authentication-unavailable" || code === "authentication-revoked"
      ? "authentication-unavailable"
      : "external-drift",
    clock,
    worktree,
    readPatch,
  );
}

async function persistPatchRecovery(
  input: PublishLocalUserGitLabInput,
  record: ScmDeliveryRecord,
  code: ScmDeliveryFailureCode,
  reasonCode: "authentication-unavailable" | "external-drift",
  clock: () => Date,
  worktree: DeliveryWorktreeCapability,
  readPatch: (worktree: DeliveryWorktreeCapability) => Promise<Uint8Array>,
): Promise<PublishLocalUserGitLabResult> {
  try {
    const patchBytes = await readPatch(worktree);
    const recovered = recoverScmDeliveryPatch(
      record,
      {
        reasonCode,
        at: nextTime(record, clock),
        patchBytes,
      },
      input.plan,
    );
    const stored = await input.receiptStore.compareAndSwap(record.sha256, recovered);
    return {
      status: "failed",
      code,
      record: stored,
      lastConfirmedState: stored.state,
      nextAction: stored.recovery?.nextAction ?? "review-preserved-patch",
      recoveryCommand: recoveryCommand(input, stored),
    };
  } catch {
    return persistFailure(input, record, "receipt-drift", clock);
  }
}

function transientFailure(
  input: PublishLocalUserGitLabInput,
  record: ScmDeliveryRecord,
  code: ScmDeliveryFailureCode,
  nextAction: string,
): PublishLocalUserGitLabResult {
  return {
    status: "failed",
    code,
    record,
    lastConfirmedState: record.state,
    nextAction,
    recoveryCommand: recoveryCommand(input, record),
  };
}

function handlePolicyFailure(
  input: PublishLocalUserGitLabInput,
  record: ScmDeliveryRecord,
  code: LocalUserGitLabPublisherFailureCode,
  clock: () => Date,
  worktree: DeliveryWorktreeCapability,
  readPatch: (worktree: DeliveryWorktreeCapability) => Promise<Uint8Array>,
): Promise<PublishLocalUserGitLabResult> | PublishLocalUserGitLabResult {
  if (code === "authentication-unavailable" || code === "authentication-revoked") {
    return persistPatchRecovery(
      input,
      record,
      code,
      "authentication-unavailable",
      clock,
      worktree,
      readPatch,
    );
  }
  return handleFailure(input, record, code, clock);
}

function handleFailure(
  input: PublishLocalUserGitLabInput,
  record: ScmDeliveryRecord,
  code: LocalUserGitLabPublisherFailureCode,
  clock: () => Date,
): Promise<PublishLocalUserGitLabResult> | PublishLocalUserGitLabResult {
  if (code !== "authorization-expired" && code !== "invalid-input" && code !== "receipt-conflict") {
    return persistFailure(input, record, code, clock);
  }
  return {
    status: "failed",
    code,
    record,
    lastConfirmedState: record.state,
    nextAction: "issue-fresh-authorization",
    recoveryCommand: recoveryCommand(input, record),
  };
}

function currentAuthorization(
  input: Pick<PublishLocalUserGitLabInput, "plan" | "authorization">,
  clock: () => Date,
): void {
  assertCurrentLocalUserPublicationAuthorization(input.authorization, input.plan, clock());
}

/**
 * The run's roots plus the delivery worktree. The worktree sits under the state
 * directory, so without it a worktree path would read `$DOCSFAB_STATE_DIR/...`.
 */
function deliveryHostRoots(worktreePath: string): HostRootSet {
  return runtimeEgressRootSet({ checkouts: [worktreePath] });
}

function nextTime(record: ScmDeliveryRecord, clock: () => Date): string {
  const now = clock().getTime();
  const previous = Date.parse(record.updatedAt);
  if (!Number.isFinite(now)) throw new LocalUserGitLabPublisherError("invalid-input");
  return new Date(Math.max(now, previous + 1)).toISOString();
}

function recoveryCommand(input: PublishLocalUserGitLabInput, record: ScmDeliveryRecord): string {
  return (
    input.recoveryCommand ??
    `docsfab publish ${record.run.id} --draft-mr --execute --confirm-plan-sha256 ${record.planSha256}`
  );
}

async function withMergeRequestLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const predecessor = mergeRequestLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
  mergeRequestLocks.set(key, current);
  await predecessor;
  try {
    return await action();
  } finally {
    release();
    if (mergeRequestLocks.get(key) === current) mergeRequestLocks.delete(key);
  }
}

function refuse(code: LocalUserGitLabPublisherFailureCode): never {
  throw new LocalUserGitLabPublisherError(code);
}
