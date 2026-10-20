// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalDigest } from "../content-ir/canonical.js";
import type { HostOperationExecutor } from "../execution/contracts.js";
import type { ChangeEvidence } from "../impact/contracts.js";
import type { RepositoryTarget } from "../repository/contracts.js";
import { GitPatchEvidenceCollector } from "../repository/evidence.js";
import type { RepositoryWorkspace } from "../repository/workspace/contracts.js";
import type { WorkflowSearchCoordinator } from "../workflow-contracts/contracts.js";
import type { AuthoringCandidateV1 } from "./authoring-candidate.js";
import type {
  DocumentationPlanCreateConversionV1,
  PlannedTargetCollisionV1,
} from "./plan-binding.js";
import {
  admitAuthoringCandidate1,
  captureFailedAuthoringPartial,
  materializeSelectedAuthoringEvidence,
  observeAuthoringRevisionWorkspace,
  plannedTargetCollisions,
  prepareAuthoringRevisionWorkspace,
  resetAuthoringRevisionWorkspace,
  sealAuthoringCandidate,
  type AuthoringCandidateCaptureV1,
  type AuthoringFailedPartialCaptureV1,
  type AuthoringRevisionWorkspaceV1,
  type AuthoringUpdateGrantV1,
  type AuthoringWorkspaceSnapshotV1,
} from "./authoring-workspace-host.js";
import type {
  SourceObligationLedger,
  SourceObligationSourceObserver,
} from "./source-obligation.js";

export interface AuthoringActiveWorkspaceV1 {
  readonly workspacePath: string;
  readonly repositoryWorkspace: RepositoryWorkspace;
  readonly search: WorkflowSearchCoordinator;
  readonly sourceObserver: SourceObligationSourceObserver;
  readonly hostOperations: HostOperationExecutor;
  readonly repositoryEvidence: GitPatchEvidenceCollector;
}

export interface AuthoringRevisionSessionV1 extends AuthoringActiveWorkspaceV1 {
  readonly candidate0: AuthoringCandidateCaptureV1;
  readonly hostSession: AuthoringRevisionWorkspaceV1;
}

export interface AuthoringCandidateLifecycleV1 {
  /**
   * The planned CREATE targets the original repository revision already
   * holds, observed before any page is written so plan admission can convert
   * the one an UPDATE can start from and refuse the rest by name.
   */
  plannedTargetCollisions(input: {
    writePaths: readonly string[];
  }): Promise<readonly PlannedTargetCollisionV1[]>;
  sealCandidate0(input: {
    runId: string;
    repository: RepositoryTarget;
    planDigest: string;
    writePaths: readonly string[];
    sourceLedger: SourceObligationLedger;
    signal?: AbortSignal;
  }): Promise<AuthoringCandidateCaptureV1>;
  prepareRevision(input: {
    runId: string;
    repository: RepositoryTarget;
    candidate0: AuthoringCandidateCaptureV1;
    /** The admitted plan's CREATE-to-UPDATE conversion, when it has one. */
    createConvertedToUpdate?: Pick<DocumentationPlanCreateConversionV1, "path" | "baseSha256">;
    sourceLedger: SourceObligationLedger;
    signal?: AbortSignal;
  }): Promise<AuthoringRevisionSessionV1>;
  sealCandidate1(input: {
    session: AuthoringRevisionSessionV1;
    runId: string;
    repository: RepositoryTarget;
    planDigest: string;
    writePaths: readonly string[];
    sourceLedger: SourceObligationLedger;
    signal?: AbortSignal;
  }): Promise<AuthoringCandidateCaptureV1>;
  /**
   * The paths the revision writer changed from candidate 0, observed without
   * sealing candidate 1, for the in-attempt accounting check.
   */
  observeRevisionChangedPaths(input: {
    session: AuthoringRevisionSessionV1;
    signal?: AbortSignal;
  }): Promise<readonly string[]>;
  /**
   * Restore the revision workspace to exactly candidate 0 before a bounded
   * retry of the revision writer; refuses unless the restore is exact.
   */
  resetRevision(input: {
    session: AuthoringRevisionSessionV1;
    signal?: AbortSignal;
  }): Promise<void>;
  captureFailedPartial(input: {
    session: AuthoringRevisionSessionV1;
    repository: RepositoryTarget;
    signal?: AbortSignal;
  }): Promise<AuthoringFailedPartialCaptureV1>;
  materializeSelected(input: {
    capture: AuthoringCandidateCaptureV1;
    repository: RepositoryTarget;
    revisionSession?: AuthoringRevisionSessionV1;
  }): Promise<ChangeEvidence>;
  dispose(session: AuthoringRevisionSessionV1): Promise<void>;
}

export class LocalAuthoringCandidateLifecycle implements AuthoringCandidateLifecycleV1 {
  public constructor(
    private readonly source: {
      workspace: RepositoryWorkspace;
      evidenceCollector: GitPatchEvidenceCollector;
      search: WorkflowSearchCoordinator;
      sourceObserver: SourceObligationSourceObserver;
      hostOperations?: HostOperationExecutor;
      artifactDirectory: string;
      /** A hosted run's write grant for modifying an existing page. */
      updateGrant?: AuthoringUpdateGrantV1;
    },
  ) {}

  public async plannedTargetCollisions(
    input: Parameters<AuthoringCandidateLifecycleV1["plannedTargetCollisions"]>[0],
  ): Promise<readonly PlannedTargetCollisionV1[]> {
    return plannedTargetCollisions(
      this.source.workspace,
      input.writePaths,
      this.source.updateGrant,
    );
  }

  public async sealCandidate0(
    input: Parameters<AuthoringCandidateLifecycleV1["sealCandidate0"]>[0],
  ): Promise<AuthoringCandidateCaptureV1> {
    return sealAuthoringCandidate({
      ...input,
      ordinal: 0,
      originalRevision: input.repository.revision,
      workspace: this.source.workspace,
      evidenceCollector: this.source.evidenceCollector,
    });
  }

  public async prepareRevision(
    input: Parameters<AuthoringCandidateLifecycleV1["prepareRevision"]>[0],
  ): Promise<AuthoringRevisionSessionV1> {
    const hostSession = await prepareAuthoringRevisionWorkspace({
      ...input,
      sourceWorkspace: this.source.workspace,
      artifactDirectory: this.source.artifactDirectory,
    });
    return Object.freeze({
      candidate0: input.candidate0,
      hostSession,
      workspacePath: hostSession.workspace.path,
      repositoryWorkspace: hostSession.workspace,
      search: hostSession.searchCoordinator,
      sourceObserver: hostSession.sourceObserver,
      hostOperations: hostSession.hostOperations,
      repositoryEvidence: hostSession.evidenceCollector,
    });
  }

  public async sealCandidate1(
    input: Parameters<AuthoringCandidateLifecycleV1["sealCandidate1"]>[0],
  ): Promise<AuthoringCandidateCaptureV1> {
    const capture = await sealAuthoringCandidate({
      runId: input.runId,
      ordinal: 1,
      originalRevision: input.repository.revision,
      planDigest: input.planDigest,
      writePaths: input.writePaths,
      workspace: input.session.hostSession.workspace,
      repository: input.repository,
      evidenceCollector: input.session.hostSession.evidenceCollector,
      sourceLedger: input.sourceLedger,
      signal: input.signal,
    });
    return admitAuthoringCandidate1(
      input.session.hostSession,
      capture.candidate,
      input.repository,
      input.sourceLedger,
      input.signal,
    );
  }

  public async observeRevisionChangedPaths(
    input: Parameters<AuthoringCandidateLifecycleV1["observeRevisionChangedPaths"]>[0],
  ): Promise<readonly string[]> {
    const snapshot = await observeAuthoringRevisionWorkspace(
      input.session.hostSession,
      input.signal,
    );
    return authoringRevisionChangedPaths(input.session.candidate0.snapshot, snapshot);
  }

  public async resetRevision(
    input: Parameters<AuthoringCandidateLifecycleV1["resetRevision"]>[0],
  ): Promise<void> {
    await resetAuthoringRevisionWorkspace(
      input.session.hostSession,
      this.source.workspace,
      input.signal,
    );
  }

  public async captureFailedPartial(
    input: Parameters<AuthoringCandidateLifecycleV1["captureFailedPartial"]>[0],
  ): Promise<AuthoringFailedPartialCaptureV1> {
    return captureFailedAuthoringPartial(input.session.hostSession, input.repository, input.signal);
  }

  public async materializeSelected(
    input: Parameters<AuthoringCandidateLifecycleV1["materializeSelected"]>[0],
  ): Promise<ChangeEvidence> {
    const workspace =
      input.capture.candidate.ordinal === 0
        ? this.source.workspace
        : input.revisionSession?.hostSession.workspace;
    if (!workspace) {
      throw new Error("Selected revised candidate has no authenticated revision workspace.");
    }
    return materializeSelectedAuthoringEvidence(input.capture, {
      candidate: input.capture.candidate,
      repository: input.repository,
      workspace,
    });
  }

  public async dispose(session: AuthoringRevisionSessionV1): Promise<void> {
    await session.hostSession.dispose();
  }

  public sourceWorkspace(): AuthoringActiveWorkspaceV1 {
    if (!this.source.hostOperations) {
      throw new Error("CREATE V3 requires a host operation executor for candidate checks.");
    }
    return Object.freeze({
      workspacePath: this.source.workspace.path,
      repositoryWorkspace: this.source.workspace,
      search: this.source.search,
      sourceObserver: this.source.sourceObserver,
      hostOperations: this.source.hostOperations,
      repositoryEvidence: this.source.evidenceCollector,
    });
  }
}

export function authoringCandidateForOrdinal(
  captures: readonly AuthoringCandidateCaptureV1[],
  ordinal: 0 | 1,
): AuthoringCandidateV1 {
  const candidate = captures[ordinal]?.candidate;
  if (!candidate || candidate.ordinal !== ordinal) {
    throw new Error("Authoring candidate history is incomplete for the selected workflow phase.");
  }
  return candidate;
}

/** Host faults of the revision writer's bounded replay, each catalogued. */
export const AUTHORING_REVISION_REPLAY_FAULT_CODES = Object.freeze([
  "authoring-revision-reset-failed",
  "authoring-revision-observation-failed",
] as const);

export type AuthoringRevisionReplayFaultCode =
  (typeof AUTHORING_REVISION_REPLAY_FAULT_CODES)[number];

const REPLAY_FAULT_MESSAGES: Readonly<Record<AuthoringRevisionReplayFaultCode, string>> =
  Object.freeze({
    "authoring-revision-reset-failed":
      "The authoring revision workspace could not be restored to candidate 0 before a retry.",
    "authoring-revision-observation-failed":
      "The authoring revision workspace could not be observed to check the writer's accounting.",
  });

/**
 * A host fault while the revision writer's replay restored or observed its
 * workspace. Terminal: no reply can repair it. The failure classifier reads
 * the code, not the message. The host error stays a non-enumerable `cause`,
 * so enumerating serializers do not copy it.
 */
export class AuthoringRevisionReplayError extends Error {
  public readonly code: AuthoringRevisionReplayFaultCode;

  public constructor(code: AuthoringRevisionReplayFaultCode, cause: unknown) {
    super(REPLAY_FAULT_MESSAGES[code], { cause });
    this.name = "AuthoringRevisionReplayError";
    this.code = code;
  }
}

/** Paths changed by the correction writer relative to sealed candidate zero. */
export function authoringRevisionChangedPaths(
  before: AuthoringWorkspaceSnapshotV1,
  after: AuthoringWorkspaceSnapshotV1,
): readonly string[] {
  const left = new Map(before.entries.map((entry) => [entry.path, canonicalDigest(entry)]));
  const right = new Map(after.entries.map((entry) => [entry.path, canonicalDigest(entry)]));
  return Object.freeze(
    [...new Set([...left.keys(), ...right.keys()])]
      .filter((path) => left.get(path) !== right.get(path))
      .sort(),
  );
}
