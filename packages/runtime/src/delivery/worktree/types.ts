// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Delivery worktree shared types, host-only capability state, and command runner.
 * Layering: host/validate/publish-plan/materialize depend on this module.
 */
import { spawn } from "node:child_process";
import {
  type DeliveryWorktreeFailureCode,
  type DeliveryValidationFailureEvidence,
  type LocalUserPublicationAuthorizationV1,
  type LocalUserPublicationPlan,
} from "../contracts.js";
import { type ScmPublishedTerminalEvidence } from "../receipt.js";
import type { WorkflowName } from "../../workflow-contracts/contracts.js";
import type { ChangedFileEvidence } from "../../impact/contracts.js";
import { publicationMetadataInputDigests } from "../metadata.js";
import type { DocumentationCheckStatus } from "../structural-documentation-validator.js";

export const MAX_COMMAND_OUTPUT = 4 * 1024 * 1024;
export const CAPABILITY_CONFIRMATION = "discard-failed-or-uncommitted-delivery";
export const SAFE_GIT_CONFIG = [
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
export interface FsIdentity {
  dev: number;
  ino: number;
  uid: number;
  mode: number;
}
export interface GitMetadataPin {
  path: string;
  identity?: FsIdentity;
  sha256?: string;
  bytes?: Buffer;
}
export interface GitConfigSnapshot {
  pins: GitMetadataPin[];
  validatedContexts: Set<string>;
}
export interface TrustedCapability {
  plan: LocalUserPublicationPlan;
  /** Existing host-owned durable object pool that stores source applicability. */
  artifactStoreRoot: string;
  workflow: WorkflowName;
  /** Host-verified changed-file rows, including rename/copy source paths. */
  changedFiles: ChangedFileEvidence[];
  repositoryPath: string;
  repositoryIdentity: FsIdentity;
  gitConfigSnapshot: GitConfigSnapshot;
  capsulePath: string;
  worktreePath: string;
  branch: string;
  baseRevision: string;
  planSha256: string;
  runId: string;
  recordSha256: string;
  patchSha256: string;
  targetBranch: string;
  remoteName: string;
  projectId: number;
  publicationAuthorization: LocalUserPublicationAuthorizationV1;
  deliveryRootPath: string;
  deliveryRootIdentity: FsIdentity;
  capsuleIdentity: FsIdentity;
  patchIdentity: FsIdentity;
  worktreeIdentity?: FsIdentity;
  worktreeRegistered: boolean;
  branchCreated: boolean;
  createsSourceBranch: boolean;
  retainedHeadShape?: "attached-base" | "attached-commit" | "detached-base" | "detached-commit";
  expectedDeliveryHeadRevision?: string;
  expectedSourceBranchRevision: string | undefined;
  metadataInputDigests: ReturnType<typeof publicationMetadataInputDigests>;
  authorizedTree?: string;
  authorizedEntries?: GitTreeEntry[];
  sourceGitDirectory: string;
  commonGitDirectory: string;
  deliveryGitDirectory?: string;
  readyStateSha256?: string;
  validationIsolationMode?: "confined" | "operator-supervised";
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  cleanupTombstonePath?: string;
  state: DeliveryWorktreeCapability["state"];
}
export const capabilities = new WeakMap<object, TrustedCapability>();
export const discardAuthorizations = new WeakMap<
  object,
  {
    worktree: object;
    planSha256: string;
    deleteBranch: boolean;
    snapshotSha256: string;
    branchRevision: string | undefined;
    branchFingerprint: string | undefined;
  }
>();
export const publishedCleanupAuthorizations = new WeakMap<
  object,
  {
    worktree: object;
    evidence: ScmPublishedTerminalEvidence;
    consumed: boolean;
  }
>();
export const readyAttestations = new WeakMap<object, { worktree: object; stateSha256: string }>();

export interface DeliveryCommandResult {
  exitCode: number;
  stdout: Buffer;
}

export interface DeliveryCommandRunner {
  run(
    command: string,
    args: readonly string[],
    cwd: string,
    options?: {
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
      stdin?: Uint8Array;
      maxOutputBytes?: number;
    },
  ): Promise<DeliveryCommandResult>;
}

export class ExecFileDeliveryCommandRunner implements DeliveryCommandRunner {
  public run(
    command: string,
    args: readonly string[],
    cwd: string,
    options: {
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
      stdin?: Uint8Array;
      maxOutputBytes?: number;
    } = {},
  ): Promise<DeliveryCommandResult> {
    return new Promise((resolveResult) => {
      const child = spawn(command, [...args], {
        cwd,
        env: options.env,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      let terminated = false;
      let childClosed = false;
      let inputSettled = false;
      let inputFailed = false;
      const finish = (exitCode: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveResult({ exitCode, stdout: Buffer.concat(chunks) });
      };
      const terminateTree = (): void => {
        if (terminated) return;
        terminated = true;
        try {
          if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const maybeFinish = (exitCode: number): void => {
        if (childClosed && inputSettled) finish(inputFailed ? 1 : exitCode);
      };
      const timer = setTimeout(() => {
        terminateTree();
        finish(1);
      }, options.timeoutMs ?? 30_000);
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > (options.maxOutputBytes ?? MAX_COMMAND_OUTPUT)) {
          terminateTree();
          finish(1);
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      child.once("error", () => {
        inputSettled = true;
        inputFailed = true;
        terminateTree();
        finish(1);
      });
      child.stdin.once("error", () => {
        inputSettled = true;
        inputFailed = true;
        terminateTree();
        if (childClosed) finish(1);
      });
      child.once("close", (code) => {
        childClosed = true;
        maybeFinish(code === 0 ? 0 : 1);
      });
      child.stdin.end(options.stdin ? Buffer.from(options.stdin) : undefined, () => {
        inputSettled = true;
        maybeFinish(0);
      });
    });
  }
}

export interface PrepareDeliveryWorktreeInput {
  plan: LocalUserPublicationPlan;
  authorization: LocalUserPublicationAuthorizationV1;
  runRecordPath: string;
  repositoryPath: string;
  deliveryRoot: string;
  /**
   * Resume only after an exact receipt proves this source branch was already
   * created. `advance-published` revises a DocsFab-minted branch from the
   * plan's observed head; only an advance plan may use it.
   */
  sourceBranchMode?:
    | "create"
    | "reuse-existing"
    | "create-or-reuse"
    | "rehydrate-published"
    | "advance-published"
    | "reuse-retained";
  /** Exact commit recorded by a durable committed-or-later receipt. */
  expectedSourceRevision?: string;
  /** Exact retained worktree shape accepted for a verified same-attempt replay. */
  retainedHead?: {
    readonly shape: "attached-base" | "attached-commit" | "detached-base" | "detached-commit";
    readonly revision: string;
    readonly branchRevision: string;
  };
  /** Host receipt boundary after patch materialization and before validation. */
  onPrepared?: (evidence: { workspaceKey: string; baseRevision: string }) => Promise<void>;
  /**
   * Warns when an interactive-once host lacks confined validation (for example,
   * Docker Desktop stopped) and falls back to operator-supervised validation.
   * Nested execute hosts fail closed instead.
   */
  onValidationIsolationUnavailable?: (message: string) => void;
  /** Trusted clock seam for authorization checks immediately before mutations. */
  clock?: () => Date;
}

export interface DeliveryValidationIsolation {
  commandPrefix: string[];
}

export interface DeliveryValidationIsolationRequest {
  worktreePath: string;
  scratchPath: string;
  deniedReadPaths: string[];
  deniedReadRoots: string[];
}

/**
 * Trusted host-selected isolator. Plan, config, environment, CLI flags, and
 * model output cannot name or construct it.
 */
export type DeliveryValidationIsolator = (
  request: DeliveryValidationIsolationRequest,
  commands: DeliveryCommandRunner,
  cwd: string,
) => Promise<DeliveryValidationIsolation>;

/** Host-only capability. Never serialize this object into model input or durable run evidence. */
export interface DeliveryWorktreeCapability {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-delivery-worktree-capability";
  readonly runId: string;
  readonly planSha256: string;
  readonly repositoryPath: string;
  readonly capsulePath: string;
  readonly worktreePath: string;
  readonly patchPath: string;
  readonly branch: string;
  readonly baseRevision: string;
  readonly patchSha256: string;
  readonly changedFilesSha256: string;
  state: "ready" | "failed" | "archived" | "cleaned";
  failureCode?: DeliveryWorktreeFailureCode;
}

/** Safe, plan-bound projection of a freshly revalidated host-only ready capability. */
export interface DeliveryWorktreeReadyAttestation {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-delivery-worktree-ready-attestation";
  readonly runId: string;
  readonly planSha256: string;
  readonly worktreePath: string;
  readonly baseRevision: string;
  readonly tree: string;
  readonly workspaceKey: string;
  readonly patch: {
    readonly sha256: string;
    readonly byteLength: number;
  };
  readonly validation: {
    readonly commandSha256: string;
    readonly stateSha256: string;
    readonly profileId?: string;
    readonly profileVersion?: string;
    readonly checkIds?: readonly string[];
    readonly selectorInputSha256?: string;
    readonly validatorIdentity?: string;
    readonly candidateTreeSha256?: string;
    readonly checkSetSha256?: string;
    readonly applicabilitySha256?: string;
    readonly backendIdentity?: string;
    readonly resultSha256?: string;
    /** Ordered host structural outcomes, sealed with the candidate-tree digest. */
    readonly results?: readonly { id: string; status: DocumentationCheckStatus }[];
  };
  readonly metadata: {
    readonly workflowOutcomeSha256: string;
    readonly changedPathsSha256: string;
    readonly selectedCompositionId?: string;
    readonly compositionEvidenceSha256?: string;
    readonly compositionAggregateSha256?: string;
    readonly compositionMarkerSha256?: string;
  };
}

export type PrepareDeliveryWorktreeResult =
  | { status: "ready"; worktree: DeliveryWorktreeCapability }
  | {
      status: "failed";
      code: DeliveryWorktreeFailureCode;
      worktree: DeliveryWorktreeCapability;
      validation?: DeliveryValidationFailureEvidence;
    };

export interface DeliveryDiscardAuthorization {
  readonly kind: "docsfab-delivery-discard-authorization";
}

export interface PublishedDeliveryCleanupAuthorization {
  readonly kind: "docsfab-published-delivery-cleanup-authorization";
}

export type CleanupDeliveryWorktreeInput =
  | { mode: "published"; authorization: PublishedDeliveryCleanupAuthorization }
  | {
      mode: "operator-discard";
      authorization: DeliveryDiscardAuthorization;
    };

export interface EffectiveGitConfigEntry {
  origin: string;
  key: string;
  value: string;
}

export interface DeliveryRegistration {
  path: string;
  gitDirectory: string;
  head?: string;
  branch?: string;
}

export interface GitTreeEntry {
  path: string;
  mode: "100644" | "100755" | "120000";
  oid: string;
  bytes: Buffer;
}

export interface SourceState {
  checkoutSha256: string;
  filesystemSha256: string;
  refs: Map<string, string>;
}
