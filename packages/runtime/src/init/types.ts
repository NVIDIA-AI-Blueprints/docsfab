// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types and constants for DocsFab init seams.
 */
import type { FileHandle } from "node:fs/promises";

import type { ReadOnlyCommandResult } from "../delivery/command-types.js";
import type { InitRemediationId } from "../operator/remediation-contracts.js";
import type { PrivateGitignorePlan } from "./gitignore.js";

export const DOCSFAB_PROJECT_CONFIG_FILE = ".docsfab.json";
export const SAFE_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
export const SAFE_USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
export const SHA256 = /^[a-f0-9]{64}$/u;
export const MAX_CONFIG_BYTES = 8 * 1024;
export const SAFE_BRANCH = /^(?![-/.])(?!.*(?:\.\.|@\{|\/\/))[^\0-\x20\x7f~^:?*[\\]{1,200}$/u;
export const SAFE_GIT_CONFIG = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.trustExitCode=false",
  "-c",
  "pager.status=false",
] as const;

export interface DocsFabProjectConfigV1 {
  schemaVersion: 1;
  gitlab: { remote: string; defaultBranch: string };
  provider: { configuration: "host" };
  storage: { scope: "user-private" };
  /** Repository-relative documentation trees. Omitted keeps a full-tree index walk. */
  documentationRoots?: readonly string[];
}

export interface DocsFabPrivateRoots {
  runs: string;
  evidence: string;
  delivery: string;
  receipts: string;
}

export type InitProviderStatus = "ready" | "partial" | "missing";
export type InitDoctorStatus = "ready" | "profile-diagnostics-required" | "diagnostics-required";
export const COMMIT_DOCSFAB_JSON_ACTION = "commit-docsfab-json" as const;
export type InitCommitNextAction = typeof COMMIT_DOCSFAB_JSON_ACTION;
export type InitNextAction = InitRemediationId;
export type InitApplyNextAction = InitRemediationId | InitCommitNextAction;

export interface DocsFabInitPlan {
  schemaVersion: 1;
  kind: "docsfab-init-plan";
  sha256: string;
  projectConfig: DocsFabProjectConfigV1;
  change: "create" | "update" | "none";
  repository: "detected";
  repositoryBindingSha256: string;
  configPreimageSha256: string;
  gitignore: PrivateGitignorePlan;
  changedPaths: readonly string[];
  gitlabAuthentication: "configured" | "missing" | "unreachable";
  gitlabProject: "ready" | "unavailable";
  gitlabBindingSha256: string | null;
  providerConfiguration: InitProviderStatus;
  profileStatus: "current" | "stale" | "unknown" | "unavailable";
  privateRoots: readonly ["runs", "evidence", "delivery", "receipts"];
  doctor: InitDoctorStatus;
  nextActions: InitNextAction[];
}

export interface CommandRunner {
  run(
    command: "git" | "glab",
    args: readonly string[],
    cwd: string,
    options?: { env?: NodeJS.ProcessEnv },
  ): Promise<ReadOnlyCommandResult>;
}

export interface DocsFabInitPrompt {
  chooseRemote(candidates: readonly string[]): Promise<string>;
  confirm(plan: DocsFabInitPlan): Promise<boolean>;
}

export interface DocsFabInitMutationHooks {
  afterLockAcquired?(): Promise<void>;
  beforeConfigCommit?(): Promise<void>;
  atConfigPublication?(): Promise<void>;
  configureTemporary?(handle: FileHandle): Promise<void>;
  afterConfigPublished?(): Promise<void>;
  /** Test/host seam invoked immediately after a durable mutation boundary. */
  afterMutationBoundary?(boundary: DocsFabInitMutationBoundary): Promise<void>;
}

export type DocsFabInitMutationBoundary =
  | "lock-prepared"
  | "lock-created"
  | "lock-owner-synced"
  | "lock-parent-synced"
  | "journal-created"
  | "journal-synced"
  | "journal-renamed"
  | "journal-directory-synced"
  | "temporary-created"
  | "temporary-synced"
  | "temporary-directory-synced"
  | "preimage-renamed"
  | "preimage-directory-synced"
  | "config-linked"
  | "config-directory-synced"
  | "temporary-unlinked"
  | "temporary-unlink-directory-synced"
  | "backup-unlinked"
  | "backup-unlink-directory-synced"
  | "receipt-renamed"
  | "receipt-directory-synced"
  | "lock-owner-unlinked"
  | "lock-removed"
  | "lock-release-parent-synced";

export interface DocsFabInitDependencies {
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  commands?: CommandRunner;
  interactive?: boolean;
  prompt?: DocsFabInitPrompt;
  inspectProvider?: () => Promise<{
    status: InitProviderStatus;
    profileStatus: DocsFabInitPlan["profileStatus"];
  }>;
  checkDoctor?: () => Promise<boolean | InitDoctorStatus>;
  inspectReadiness?: (input: {
    cwd: string;
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
  }) => Promise<ReadonlyArray<{ area: string; status: "ready" | "blocked" }>>;
  mutationHooks?: DocsFabInitMutationHooks;
  log(message: string): void;
}

export interface DocsFabInitArguments {
  repositoryPath: string;
  remote?: string;
  nonInteractive: boolean;
  apply: boolean;
  approvePlanSha256?: string;
  json: boolean;
}

export interface RemoteCandidate {
  name: string;
  host: string;
  projectPath: string;
}

export interface RepositoryDiscovery {
  path: string;
  candidates: RemoteCandidate[];
  trackingRemote?: string;
  pushDefault?: string;
}

export interface RepositoryApprovalIdentity {
  sha256: string;
}

export interface FileIdentity {
  dev: number;
  ino: number;
  uid: number;
  mode: number;
  nlink: number;
  size: number;
}

export interface DirectoryPin {
  path: string;
  identity: FileIdentity;
  private: boolean;
}

export interface ExistingConfig {
  state: "absent" | "file";
  preimageSha256: string;
  value?: DocsFabProjectConfigV1;
  bytes?: Buffer;
  identity?: FileIdentity;
}

export interface InitLockOwnerV1 {
  schemaVersion: 1;
  kind: "docsfab-init-lock-owner";
  leaseId: string;
  pid: number;
  uid: number;
  processBirthIdentity: string;
  issuedAtMs: number;
  expiresAtMs: number;
}

export interface InitLockOwnerV2 {
  schemaVersion: 2;
  kind: "docsfab-init-lock-owner";
  leaseId: string;
  pid: number;
  uid: number;
  processBirthIdentity: string;
  issuedAtMs: number;
  expiresAtMs: number;
}

export type InitLockOwner = InitLockOwnerV1 | InitLockOwnerV2;

export interface LockOwnerSnapshot {
  value: InitLockOwner;
  bytes: Buffer;
  identity: FileIdentity;
  sha256: string;
}

export interface InitLockLease {
  directory: DirectoryPin;
  owner: LockOwnerSnapshot;
}

export interface StoragePins {
  pins: DirectoryPin[];
  projectRoot: DirectoryPin;
  lockPath: string;
  journalPath: string;
  journalAnchorPath: string;
  receiptPath: string;
  lock?: InitLockLease;
}

export interface InitJournalV1 {
  schemaVersion: 1;
  kind: "docsfab-init-journal";
  transactionId: string;
  repositoryBindingSha256: string;
  configPreimageSha256: string;
  targetSha256: string;
  temporaryObjectSha256: string;
  previousReceiptPreimageSha256: string;
  change: "create" | "update";
  phase: "prepared" | "preimage-detached" | "published";
}

export interface JournalSnapshot {
  value: InitJournalV1;
  bytes: Buffer;
  identity: FileIdentity;
  sha256: string;
}

export interface ConfigurationRootSnapshot {
  path: string;
  exists: boolean;
  pins: DirectoryPin[];
}

export interface ApplyResult {
  configChanged: boolean;
  cleanupRequired: boolean;
}
