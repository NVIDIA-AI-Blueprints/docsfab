// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Materialize seam: prepare and materialize an authorized delivery worktree.
 */
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ChangedFileEvidence } from "../../impact/contracts.js";
import type { WorkflowOutcomeDecodeOptionsV1 } from "../../workflow-contracts/outcome.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../../json-evidence.js";
import {
  DeliveryWorktreeError,
  LocalUserPublicationPreflightError,
  localUserPublicationAdvance,
  type DeliveryWorktreeFailureCode,
  type LocalUserPublicationAuthorizationV1,
  type LocalUserPublicationPlan,
} from "../contracts.js";
import { loadVerifiedPublicationRun, type VerifiedPublicationRun } from "../preflight.js";
import { buildRunPublicationMetadata, publicationMetadataInputDigests } from "../metadata.js";
import { runtimeEgressRootSet } from "../../config/egress-roots.js";
import { DeterministicLocalGitPublisher } from "../git-publisher.js";
import { containsConfiguredCredentialInBytes } from "../../security/configured-credentials.js";
import {
  ExecFileDeliveryCommandRunner,
  capabilities,
  type DeliveryCommandResult,
  type DeliveryCommandRunner,
  type DeliveryValidationIsolation,
  type DeliveryValidationIsolator,
  type DeliveryWorktreeCapability,
  type FsIdentity,
  type GitConfigSnapshot,
  type GitTreeEntry,
  type PrepareDeliveryWorktreeInput,
  type PrepareDeliveryWorktreeResult,
  type TrustedCapability,
} from "./types.js";
import {
  assertFilesystemMatchesGitTree,
  assertIdentity,
  assertTrustedPaths,
  branchRevision,
  canonicalOwnerDirectory,
  canonicalPath,
  captureGitConfigSnapshot,
  deliveryRegistrations,
  directRefRevision,
  discoverDeliveryPartialState,
  fail,
  fileIdentity,
  identity,
  ownerOnlyDirectory,
  pathExists,
  pinnedGitCommands,
  readGitTree,
  readDirectHead,
  requireCapability,
  requireGit,
  resolveCommonGitDirectory,
  resolveGitDirectoryFromWorktree,
  runGit,
  safeRepositoryPath,
  setCapabilityState,
  text,
  verifyPinnedPatch,
  withRepositoryLock,
  within,
  gitEnvironment,
} from "./host.js";
import {
  directMetadataFingerprint,
  deliveryState,
  deliveryWorkspaceKey,
  expectedSourceTransition,
  requireConfinedValidationIsolation,
  sourceState,
  splitValidationCommand,
  validationDeniedReadPaths,
  validationEnvironment,
} from "./validate.js";
import {
  resolveValidationIsolationPolicy,
  shouldUseOperatorSupervisedValidationFallback,
} from "./validation-isolation-policy.js";
import {
  assertCurrentPreparationAuthorization,
  validateInput,
  verifyRepositoryIdentity,
  verifyRunBinding,
} from "./publish-plan.js";

/**
 * Verify and materialize an authorized patch without changing the source checkout.
 * All failures after capsule creation preserve the verified patch and any worktree.
 */
export async function prepareDeliveryWorktree(
  input: PrepareDeliveryWorktreeInput,
  commands: DeliveryCommandRunner = new ExecFileDeliveryCommandRunner(),
  isolateValidation: DeliveryValidationIsolator = requireConfinedValidationIsolation,
  editorialDecodeOptions: WorkflowOutcomeDecodeOptionsV1 = {},
): Promise<PrepareDeliveryWorktreeResult> {
  let plan: LocalUserPublicationPlan;
  const authorization = input.authorization;
  try {
    plan = structuredClone(input.plan);
  } catch {
    fail("invalid-delivery-input");
  }
  const runRecordPath = input.runRecordPath;
  const requestedRepositoryPath = input.repositoryPath;
  const requestedDeliveryRoot = input.deliveryRoot;
  const sourceBranchMode = input.sourceBranchMode ?? "create";
  const expectedSourceRevision = input.expectedSourceRevision;
  const onPrepared = input.onPrepared;
  const onValidationIsolationUnavailable = input.onValidationIsolationUnavailable;
  const clock = input.clock ?? (() => new Date());
  validateInput({
    plan,
    authorization,
    runRecordPath,
    repositoryPath: requestedRepositoryPath,
    deliveryRoot: requestedDeliveryRoot,
    sourceBranchMode,
    expectedSourceRevision,
    retainedHead: input.retainedHead,
    onPrepared,
    onValidationIsolationUnavailable,
    clock,
  });
  const repositoryPath = await canonicalOwnerDirectory(
    requestedRepositoryPath,
    "source-repository-mismatch",
    false,
  );
  const repositoryIdentity = await identity(
    repositoryPath,
    "source-repository-mismatch",
    "directory",
  );
  const authorizeMutation = (): void =>
    assertCurrentPreparationAuthorization(authorization, plan, clock);
  return withRepositoryLock(repositoryPath, authorizeMutation, () =>
    prepareDeliveryWorktreeLocked({
      plan,
      authorization,
      runRecordPath,
      requestedDeliveryRoot,
      repositoryPath,
      repositoryIdentity,
      sourceBranchMode,
      expectedSourceRevision,
      retainedHead: input.retainedHead,
      onPrepared,
      onValidationIsolationUnavailable,
      clock,
      commands,
      isolateValidation,
      editorialDecodeOptions,
    }),
  );
}

export async function prepareDeliveryWorktreeLocked(input: {
  plan: LocalUserPublicationPlan;
  authorization: LocalUserPublicationAuthorizationV1;
  runRecordPath: string;
  requestedDeliveryRoot: string;
  repositoryPath: string;
  repositoryIdentity: FsIdentity;
  commands: DeliveryCommandRunner;
  isolateValidation: DeliveryValidationIsolator;
  editorialDecodeOptions: WorkflowOutcomeDecodeOptionsV1;
  sourceBranchMode: NonNullable<PrepareDeliveryWorktreeInput["sourceBranchMode"]>;
  expectedSourceRevision?: string;
  retainedHead?: PrepareDeliveryWorktreeInput["retainedHead"];
  onPrepared?: PrepareDeliveryWorktreeInput["onPrepared"];
  onValidationIsolationUnavailable?: PrepareDeliveryWorktreeInput["onValidationIsolationUnavailable"];
  clock: () => Date;
}): Promise<PrepareDeliveryWorktreeResult> {
  const {
    plan,
    authorization,
    runRecordPath,
    requestedDeliveryRoot,
    repositoryPath,
    repositoryIdentity,
    commands: initialCommands,
    isolateValidation,
    editorialDecodeOptions,
    sourceBranchMode,
    expectedSourceRevision,
    retainedHead,
    onPrepared,
    onValidationIsolationUnavailable,
    clock,
  } = input;
  const topLevel = await requireGit(
    initialCommands,
    repositoryPath,
    ["rev-parse", "--show-toplevel"],
    "source-repository-mismatch",
  );
  if ((await canonicalPath(text(topLevel).trim())) !== repositoryPath)
    fail("source-repository-mismatch");
  const commonDirectory = text(
    await requireGit(
      initialCommands,
      repositoryPath,
      ["rev-parse", "--git-common-dir"],
      "source-repository-mismatch",
    ),
  ).trim();
  const commonPath = await canonicalPath(resolve(repositoryPath, commonDirectory));
  const sourceGitDirectory = await resolveGitDirectoryFromWorktree(
    repositoryPath,
    "source-repository-mismatch",
  );
  const directCommonPath = await resolveCommonGitDirectory(
    sourceGitDirectory,
    "source-repository-mismatch",
  );
  if (directCommonPath !== commonPath) fail("source-repository-mismatch");
  const configPath = await canonicalPath(join(commonPath, "config"));
  const sourceWorktreeConfigPath = resolve(
    repositoryPath,
    text(
      await requireGit(
        initialCommands,
        repositoryPath,
        ["rev-parse", "--git-path", "config.worktree"],
        "source-repository-mismatch",
      ),
    ).trim(),
  );
  const gitConfigSnapshot = await captureGitConfigSnapshot(initialCommands, repositoryPath, [
    configPath,
    sourceWorktreeConfigPath,
  ]);
  const commands = pinnedGitCommands(initialCommands, gitConfigSnapshot, "source-state-changed");
  // Capture the complete source baseline before reading publication artifacts or
  // creating the delivery root. If it cannot be captured, continue only far
  // enough to return a governed, explicitly cleanable failure capsule.
  const entrySourceState = await sourceState(repositoryPath, sourceGitDirectory, commonPath).catch(
    () => undefined,
  );
  let run: VerifiedPublicationRun;
  try {
    run = await loadVerifiedPublicationRun(runRecordPath, plan.run.id, editorialDecodeOptions);
  } catch (error) {
    if (error instanceof LocalUserPublicationPreflightError) {
      fail(
        error.code === "patch-mismatch" || error.code === "patch-unavailable"
          ? "patch-mismatch"
          : error.code === "patch-credential-material"
            ? "delivery-credential-material"
            : // A legal record field this caller could not decode (#2366), not a changed record.
              error.code === "run-record-contract-gap"
              ? "run-record-contract-gap"
              : "run-record-mismatch",
      );
    }
    fail("run-record-mismatch");
  }
  verifyRunBinding(run, plan);

  const recordedPath = await canonicalOwnerDirectory(
    run.sourcePath,
    "source-repository-mismatch",
    false,
  );
  if (repositoryPath !== recordedPath) fail("source-repository-mismatch");
  await verifyRepositoryIdentity(commands, repositoryPath, plan);
  const resolvedBase = text(
    await requireGit(
      commands,
      repositoryPath,
      ["rev-parse", "--verify", `${plan.baseRevision}^{commit}`],
      "base-revision-mismatch",
    ),
  ).trim();
  if (resolvedBase !== plan.baseRevision) fail("base-revision-mismatch");

  const existingSourceBranch = await directRefRevision(
    commonPath,
    `refs/heads/${plan.proposedSourceBranch}`,
    "delivery-collision",
  );
  const advance = localUserPublicationAdvance(plan);
  // An advance plan never creates or reuses its branch as a first publication
  // would, and only an advance plan may revise a published branch.
  if (
    (sourceBranchMode === "advance-published" && !advance) ||
    (advance &&
      sourceBranchMode !== "advance-published" &&
      sourceBranchMode !== "rehydrate-published" &&
      sourceBranchMode !== "reuse-retained")
  ) {
    fail("invalid-delivery-input");
  }
  const createsSourceBranch =
    sourceBranchMode === "create"
      ? true
      : sourceBranchMode === "reuse-existing" ||
          sourceBranchMode === "rehydrate-published" ||
          sourceBranchMode === "advance-published" ||
          sourceBranchMode === "reuse-retained"
        ? false
        : existingSourceBranch === undefined;
  // A retry may find the child commit on the local branch before its committed
  // receipt was persisted. Pin that exact revision through materialization,
  // then prove the complete deterministic commit before accepting the worktree.
  const unrecordedAdvanceCommit =
    Boolean(advance) &&
    sourceBranchMode === "advance-published" &&
    existingSourceBranch !== undefined &&
    existingSourceBranch !== advance?.lastRecordedHead &&
    existingSourceBranch !== advance?.observedHead;
  const requiredSourceRevision =
    sourceBranchMode === "reuse-retained"
      ? retainedHead?.branchRevision
      : sourceBranchMode === "rehydrate-published"
        ? expectedSourceRevision
        : advance && sourceBranchMode === "advance-published"
          ? existingSourceBranch
          : plan.baseRevision;
  if (
    (createsSourceBranch && existingSourceBranch !== undefined) ||
    (!createsSourceBranch && existingSourceBranch !== requiredSourceRevision)
  ) {
    fail("delivery-collision");
  }

  assertCurrentPreparationAuthorization(authorization, plan, clock);
  const authorizeMutation = (): void =>
    assertCurrentPreparationAuthorization(authorization, plan, clock);
  const deliveryRoot = await secureDeliveryRoot(requestedDeliveryRoot, authorizeMutation);
  if (within(repositoryPath, deliveryRoot.path) || within(deliveryRoot.path, repositoryPath)) {
    fail("delivery-root-unsafe");
  }
  const capsuleName = deliveryCapsuleName(plan);
  const capsulePath = join(deliveryRoot.path, capsuleName);
  const worktreePath = join(capsulePath, "repository");
  const patchPath = join(capsulePath, "verified.patch");
  try {
    authorizeMutation();
    await assertIdentity(
      deliveryRoot.path,
      deliveryRoot.identity,
      "delivery-root-unsafe",
      "directory",
    );
    if (sourceBranchMode !== "reuse-retained") await mkdir(capsulePath, { mode: 0o700 });
  } catch (error) {
    if (error instanceof DeliveryWorktreeError) throw error;
    fail("delivery-collision");
  }
  const capsuleIdentity = await identity(capsulePath, "delivery-root-unsafe", "directory");
  let patchIdentity: FsIdentity;
  if (sourceBranchMode === "reuse-retained") {
    patchIdentity = await identity(patchPath, "patch-mismatch", "file");
  } else {
    authorizeMutation();
    patchIdentity = await writePrivateExact(patchPath, run.patchBytes, authorizeMutation);
  }
  const capability = createCapability({
    plan,
    artifactStoreRoot: resolve(dirname(runRecordPath), "..", "artifacts"),
    workflow: run.workflow,
    authorization,
    repositoryPath,
    repositoryIdentity,
    sourceGitDirectory,
    commonGitDirectory: commonPath,
    gitConfigSnapshot,
    deliveryRootPath: deliveryRoot.path,
    deliveryRootIdentity: deliveryRoot.identity,
    capsulePath,
    capsuleIdentity,
    worktreePath,
    patchPath,
    patchIdentity,
    changedFiles: run.changedFiles,
    createsSourceBranch,
    expectedSourceBranchRevision: createsSourceBranch ? undefined : requiredSourceRevision,
    ...(retainedHead
      ? {
          retainedHeadShape: retainedHead.shape,
          expectedDeliveryHeadRevision: retainedHead.revision,
        }
      : {}),
    workflowOutcome: run.workflowOutcome,
    compositionExecution: run.compositionExecution,
  });

  if (!entrySourceState) return failedResult(capability, "source-state-changed");
  let result: PrepareDeliveryWorktreeResult;
  try {
    result = await materializeDeliveryWorktree({
      capability,
      plan,
      run,
      commands,
      isolateValidation,
      unrecordedAdvanceCommit,
      onPrepared,
      onValidationIsolationUnavailable,
      clock,
    });
  } catch (error) {
    result = failedResult(
      capability,
      error instanceof DeliveryWorktreeError ? error.code : "worktree-creation-failed",
    );
  }
  const sourceAfter = await sourceState(repositoryPath, sourceGitDirectory, commonPath).catch(
    () => undefined,
  );
  if (
    !sourceAfter ||
    !expectedSourceTransition(
      entrySourceState,
      sourceAfter,
      plan,
      requireCapability(capability).branchCreated,
    )
  ) {
    return failedResult(capability, "source-state-changed");
  }
  return result;
}

export async function materializeDeliveryWorktree(input: {
  capability: DeliveryWorktreeCapability;
  plan: LocalUserPublicationPlan;
  run: VerifiedPublicationRun;
  commands: DeliveryCommandRunner;
  isolateValidation: DeliveryValidationIsolator;
  unrecordedAdvanceCommit: boolean;
  onPrepared?: PrepareDeliveryWorktreeInput["onPrepared"];
  onValidationIsolationUnavailable?: PrepareDeliveryWorktreeInput["onValidationIsolationUnavailable"];
  clock: () => Date;
}): Promise<PrepareDeliveryWorktreeResult> {
  const {
    capability,
    plan,
    run,
    commands,
    isolateValidation,
    unrecordedAdvanceCommit,
    onPrepared,
    onValidationIsolationUnavailable,
    clock,
  } = input;
  const trusted = requireCapability(capability);
  const authorizeMutation = (): void =>
    assertCurrentPreparationAuthorization(trusted.publicationAuthorization, plan, clock);
  await assertTrustedPaths(trusted, false);
  const retainedPatch = await verifyPinnedPatch(trusted, "patch-mismatch");
  if (!retainedPatch.equals(run.patchBytes)) return failedResult(capability, "patch-mismatch");
  if (trusted.retainedHeadShape) {
    const retained = await verifyRetainedAttempt(
      commands,
      capability,
      run,
      plan,
      trusted,
      authorizeMutation,
    );
    if (retained !== undefined) return failedResult(capability, retained);
  } else {
    if (
      (await pathExists(trusted.worktreePath)) ||
      (await deliveryRegistrations(commands, trusted)).length > 0
    ) {
      return failedResult(capability, "delivery-collision");
    }
    const sourceRevision = await branchRevision(trusted);
    if (
      (trusted.createsSourceBranch && sourceRevision !== undefined) ||
      (!trusted.createsSourceBranch && sourceRevision !== trusted.expectedSourceBranchRevision)
    ) {
      return failedResult(capability, "delivery-collision");
    }

    const addArguments = trusted.createsSourceBranch
      ? [
          "worktree",
          "add",
          "--no-checkout",
          "-b",
          plan.proposedSourceBranch,
          trusted.worktreePath,
          plan.baseRevision,
        ]
      : ["worktree", "add", "--no-checkout", "--detach", trusted.worktreePath, plan.baseRevision];
    authorizeMutation();
    const add = await runGit(commands, addArguments, trusted.repositoryPath);
    await discoverDeliveryPartialState(commands, trusted, trusted.baseRevision);
    if (
      add.exitCode !== 0 ||
      !trusted.worktreeIdentity ||
      !trusted.worktreeRegistered ||
      (trusted.createsSourceBranch && !trusted.branchCreated)
    ) {
      return failedResult(capability, "worktree-creation-failed");
    }
    await assertTrustedPaths(
      trusted,
      Boolean(trusted.worktreeIdentity && !trusted.worktreeRemoved),
    );
    authorizeMutation();
    if (
      (await runGit(commands, ["read-tree", plan.baseRevision], trusted.worktreePath)).exitCode !==
      0
    ) {
      return failedResult(capability, "patch-application-failed");
    }
    let checked: DeliveryCommandResult;
    try {
      checked = await runPatchGit(commands, trusted, run.patchBytes, [
        "apply",
        "--check",
        "--cached",
        "--binary",
        "-",
      ]);
    } catch (error) {
      await restoreCleanBase(commands, trusted).catch(() => undefined);
      throw error;
    }
    if (checked.exitCode !== 0) {
      await restoreCleanBase(commands, trusted);
      return failedResult(capability, "patch-conflict");
    }
    let applied: DeliveryCommandResult;
    try {
      applied = await runPatchGit(
        commands,
        trusted,
        run.patchBytes,
        ["apply", "--cached", "--binary", "-"],
        authorizeMutation,
      );
    } catch (error) {
      await restoreCleanBase(commands, trusted).catch(() => undefined);
      throw error;
    }
    if (applied.exitCode !== 0) {
      await restoreCleanBase(commands, trusted);
      return failedResult(capability, "patch-application-failed");
    }
    authorizeMutation();
    const authorizedTree = text(
      await requireGit(commands, trusted.worktreePath, ["write-tree"], "patch-application-failed"),
    ).trim();
    trusted.authorizedTree = authorizedTree;
    const actualFiles = await collectObjectChangedFiles(
      commands,
      trusted.worktreePath,
      plan.baseRevision,
      authorizedTree,
    );
    if (!sameChangedFiles(actualFiles, run.changedFiles)) {
      await restoreCleanBase(commands, trusted);
      return failedResult(capability, "patch-path-mismatch");
    }
    if (unrecordedAdvanceCommit) {
      try {
        const commitMessage = buildRunPublicationMetadata(
          plan,
          run,
          runtimeEgressRootSet({ checkouts: [trusted.worktreePath] }),
        ).commitMessage;
        await new DeterministicLocalGitPublisher().assertCommit({
          plan,
          ready: { tree: authorizedTree },
          commitMessage,
          commitRevision: trusted.expectedSourceBranchRevision!,
          cwd: trusted.worktreePath,
        });
      } catch {
        return failedResult(capability, "delivery-collision");
      }
    }
    try {
      const tree = await readGitTree(commands, trusted.worktreePath, authorizedTree);
      // DocsFab's own configured credentials never reach published output
      // (#1807). In the patch text a binary hunk is zlib and base85, and a
      // UTF-16 file is binary, so the preflight screen of the patch cannot see
      // a value in either. Every changed blob is screened as the push would
      // carry it, before anything is written to the worktree.
      if (changedBlobsHoldConfiguredCredential(tree, actualFiles)) {
        await restoreCleanBase(commands, trusted);
        return failedResult(capability, "delivery-credential-material");
      }
      await materializeGitTree(trusted.worktreePath, tree, authorizeMutation);
      await assertFilesystemMatchesGitTree(trusted.worktreePath, tree, "patch-application-failed");
      trusted.authorizedEntries = tree;
    } catch (error) {
      if (error instanceof DeliveryWorktreeError) throw error;
      return failedResult(capability, "patch-application-failed");
    }
  }

  await verifyPatchCopy(trusted, run.patchBytes);
  if (onPrepared) {
    authorizeMutation();
    await onPrepared({
      workspaceKey: deliveryWorkspaceKey(trusted),
      baseRevision: trusted.baseRevision,
    });
  }

  await assertTrustedPaths(trusted, Boolean(trusted.worktreeIdentity && !trusted.worktreeRemoved));
  const deliveryBeforeValidation = await deliveryState(capability);
  const validation = splitValidationCommand(plan.validationCommand);
  let validationHome: string;
  if (trusted.retainedHeadShape) {
    authorizeMutation();
    validationHome = await mkdtemp(join(tmpdir(), "docsfab-replay-validation-"));
  } else {
    validationHome = join(trusted.capsulePath, "validation-home");
  }
  const isolationPolicy = resolveValidationIsolationPolicy({
    authorityBasis: plan.authorityBasis,
  });
  try {
    authorizeMutation();
    if (!trusted.retainedHeadShape) await mkdir(validationHome, { mode: 0o700 });
    authorizeMutation();
    await mkdir(join(validationHome, "tmp"), { mode: 0o700 });
    let isolation: DeliveryValidationIsolation;
    try {
      authorizeMutation();
      isolation = await isolateValidation(
        {
          worktreePath: trusted.worktreePath,
          scratchPath: validationHome,
          deniedReadPaths: await validationDeniedReadPaths(trusted),
          deniedReadRoots: [
            trusted.repositoryPath,
            trusted.sourceGitDirectory,
            trusted.commonGitDirectory,
          ],
        },
        commands,
        trusted.worktreePath,
      );
    } catch (error) {
      if (error instanceof DeliveryWorktreeError) throw error;
      if (shouldUseOperatorSupervisedValidationFallback(isolationPolicy, error)) {
        onValidationIsolationUnavailable?.(
          error instanceof Error ? error.message : "Validation isolation unavailable.",
        );
        trusted.validationIsolationMode = "operator-supervised";
        isolation = { commandPrefix: [] };
      } else {
        return failedResult(capability, "validation-isolation-unavailable");
      }
    }
    if (isolation.commandPrefix.length > 0) {
      trusted.validationIsolationMode = "confined";
    }
    const command = isolation.commandPrefix[0] ?? validation.command;
    const args =
      isolation.commandPrefix.length === 0
        ? validation.args
        : [...isolation.commandPrefix.slice(1), validation.command, ...validation.args];
    authorizeMutation();
    const validationResult = await commands.run(command, args, trusted.worktreePath, {
      env: validationEnvironment(validationHome),
      timeoutMs: 10 * 60_000,
    });
    if (validationResult.exitCode !== 0) return failedResult(capability, "validation-failed");
    await assertTrustedPaths(trusted, true);
    const deliveryAfterValidation = await deliveryState(capability);
    if (deliveryBeforeValidation !== deliveryAfterValidation) {
      return failedResult(capability, "validation-mutated-delivery");
    }
    await verifyPatchCopy(trusted, run.patchBytes);
    trusted.readyStateSha256 = deliveryAfterValidation;
    setCapabilityState(capability, "ready");
    return { status: "ready", worktree: capability };
  } finally {
    if (trusted.retainedHeadShape) await rm(validationHome, { recursive: true, force: true });
  }
}

async function verifyRetainedAttempt(
  commands: DeliveryCommandRunner,
  capability: DeliveryWorktreeCapability,
  run: VerifiedPublicationRun,
  plan: LocalUserPublicationPlan,
  trusted: TrustedCapability,
  authorizeMutation: () => void,
): Promise<DeliveryWorktreeFailureCode | undefined> {
  const expectedShape = trusted.retainedHeadShape!;
  const expectedRevision = trusted.expectedDeliveryHeadRevision!;
  const branchRef = `refs/heads/${trusted.branch}`;
  try {
    const gitDirectory = await resolveGitDirectoryFromWorktree(
      trusted.worktreePath,
      "delivery-collision",
    );
    const head = await readDirectHead(gitDirectory, "delivery-collision");
    const branchRevisionNow = await directRefRevision(
      trusted.commonGitDirectory,
      branchRef,
      "delivery-collision",
    );
    if (
      branchRevisionNow === undefined ||
      branchRevisionNow !== trusted.expectedSourceBranchRevision
    )
      return "delivery-collision";
    if (expectedShape === "detached-base" || expectedShape === "detached-commit") {
      if (
        head.branch !== undefined ||
        head.revision !== plan.baseRevision ||
        expectedRevision !== plan.baseRevision
      )
        return "delivery-collision";
    } else {
      if (
        head.branch !== branchRef ||
        head.revision !== undefined ||
        (expectedShape === "attached-base" &&
          (expectedRevision !== plan.baseRevision || branchRevisionNow !== plan.baseRevision)) ||
        (expectedShape === "attached-commit" &&
          (expectedRevision !== branchRevisionNow || expectedRevision === plan.baseRevision))
      )
        return "delivery-collision";
    }
    trusted.deliveryGitDirectory = gitDirectory;
    trusted.worktreeIdentity = await identity(
      trusted.worktreePath,
      "delivery-collision",
      "directory",
    );
    await discoverDeliveryPartialState(
      commands,
      trusted,
      expectedShape === "detached-base" || expectedShape === "detached-commit"
        ? plan.baseRevision
        : branchRevisionNow,
    );
    if (!trusted.worktreeRegistered) return "delivery-collision";

    authorizeMutation();
    const scratch = await mkdtemp(join(tmpdir(), "docsfab-replay-index-"));
    let authorizedTree: string;
    let currentIndexTree: string;
    try {
      const indexPath = join(scratch, "index");
      const env = { GIT_INDEX_FILE: indexPath };
      authorizeMutation();
      const seeded = await runGit(
        commands,
        ["read-tree", plan.baseRevision],
        trusted.worktreePath,
        { env },
      );
      if (seeded.exitCode !== 0) return "patch-application-failed";
      authorizeMutation();
      const applied = await runGit(
        commands,
        ["apply", "--cached", "--binary", "-"],
        trusted.worktreePath,
        { env, stdin: run.patchBytes },
      );
      if (applied.exitCode !== 0) return "patch-conflict";
      authorizeMutation();
      const written = await runGit(commands, ["write-tree"], trusted.worktreePath, { env });
      if (written.exitCode !== 0) return "patch-application-failed";
      authorizedTree = text(written.stdout).trim();
      const retainedIndexPath = join(trusted.deliveryGitDirectory!, "index");
      const before = await directMetadataFingerprint(retainedIndexPath, "delivery-collision");
      const retainedIndex = await readFile(retainedIndexPath).catch(() =>
        fail("delivery-collision"),
      );
      if (!before.equals(await directMetadataFingerprint(retainedIndexPath, "delivery-collision")))
        return "delivery-collision";
      const copiedIndex = join(scratch, "retained-index");
      authorizeMutation();
      await writePrivateExact(copiedIndex, retainedIndex, authorizeMutation);
      authorizeMutation();
      const retainedTree = await runGit(commands, ["write-tree"], trusted.worktreePath, {
        env: { GIT_INDEX_FILE: copiedIndex },
      });
      if (retainedTree.exitCode !== 0) return "delivery-collision";
      currentIndexTree = text(retainedTree.stdout).trim();
      if (!before.equals(await directMetadataFingerprint(retainedIndexPath, "delivery-collision")))
        return "delivery-collision";
      if (expectedShape === "attached-commit" || expectedShape === "detached-commit") {
        const commitMessage = buildRunPublicationMetadata(
          plan,
          run,
          runtimeEgressRootSet({ checkouts: [trusted.worktreePath] }),
        ).commitMessage;
        const commitVerifier = new DeterministicLocalGitPublisher({
          run: async (command, args, cwd, options) => {
            if (args.includes("write-tree")) authorizeMutation();
            return commands.run(command, args, cwd, {
              ...options,
              env: { ...options.env, GIT_INDEX_FILE: copiedIndex },
            });
          },
        });
        await commitVerifier.assertCommit({
          plan,
          ready: { tree: authorizedTree },
          commitMessage,
          commitRevision:
            expectedShape === "detached-commit" ? branchRevisionNow : expectedRevision,
          cwd: trusted.worktreePath,
        });
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    if (currentIndexTree !== authorizedTree) return "delivery-collision";
    const actualFiles = await collectObjectChangedFiles(
      commands,
      trusted.worktreePath,
      plan.baseRevision,
      authorizedTree,
    );
    if (!sameChangedFiles(actualFiles, run.changedFiles)) return "patch-path-mismatch";
    const entries = await readGitTree(commands, trusted.worktreePath, authorizedTree);
    if (changedBlobsHoldConfiguredCredential(entries, actualFiles))
      return "delivery-credential-material";
    await assertFilesystemMatchesGitTree(trusted.worktreePath, entries, "delivery-collision");
    trusted.authorizedTree = authorizedTree;
    trusted.authorizedEntries = entries;
    await assertTrustedPaths(trusted, true);
    return undefined;
  } catch (error) {
    if (error instanceof DeliveryWorktreeError) return error.code;
    return "delivery-collision";
  }
}

/** Returns the exact preserved patch bytes only from the live, inode-bound capability. */
export async function readPreservedDeliveryPatch(
  worktree: DeliveryWorktreeCapability,
): Promise<Uint8Array> {
  const trusted = requireCapability(worktree);
  await assertTrustedPaths(
    trusted,
    trusted.worktreeIdentity !== undefined && !trusted.worktreeRemoved,
  );
  return verifyPinnedPatch(trusted, "patch-mismatch");
}

export async function restoreCleanBase(
  commands: DeliveryCommandRunner,
  trusted: TrustedCapability,
): Promise<void> {
  if (
    (await runGit(commands, ["read-tree", trusted.baseRevision], trusted.worktreePath)).exitCode !==
    0
  ) {
    fail("patch-application-failed");
  }
  const entries = await readGitTree(commands, trusted.worktreePath, trusted.baseRevision);
  await materializeGitTree(trusted.worktreePath, entries);
  await assertFilesystemMatchesGitTree(trusted.worktreePath, entries, "patch-application-failed");
}

export function deliveryCapsuleName(plan: LocalUserPublicationPlan): string {
  const run = plan.run.id
    .toLowerCase()
    .replace(/[^a-z0-9._-]/gu, "-")
    .slice(0, 40);
  const digest = createHash("sha256")
    .update(plan.sha256)
    .update("\0")
    .update(plan.run.recordSha256)
    .update("\0")
    .update(plan.patch.sha256)
    .digest("hex")
    .slice(0, 24);
  return `${run}-${digest}`;
}

export function createCapability(input: {
  plan: LocalUserPublicationPlan;
  artifactStoreRoot: string;
  workflow: VerifiedPublicationRun["workflow"];
  authorization: LocalUserPublicationAuthorizationV1;
  repositoryPath: string;
  repositoryIdentity: FsIdentity;
  sourceGitDirectory: string;
  commonGitDirectory: string;
  gitConfigSnapshot: GitConfigSnapshot;
  deliveryRootPath: string;
  deliveryRootIdentity: FsIdentity;
  capsulePath: string;
  capsuleIdentity: FsIdentity;
  worktreePath: string;
  patchPath: string;
  patchIdentity: FsIdentity;
  changedFiles: ChangedFileEvidence[];
  createsSourceBranch: boolean;
  expectedSourceBranchRevision: string | undefined;
  retainedHeadShape?: "attached-base" | "attached-commit" | "detached-base" | "detached-commit";
  expectedDeliveryHeadRevision?: string;
  workflowOutcome: string;
  compositionExecution?: VerifiedPublicationRun["compositionExecution"];
}): DeliveryWorktreeCapability {
  const capability: DeliveryWorktreeCapability = {
    schemaVersion: 1,
    kind: "docsfab-delivery-worktree-capability",
    runId: input.plan.run.id,
    planSha256: input.plan.sha256,
    repositoryPath: input.repositoryPath,
    capsulePath: input.capsulePath,
    worktreePath: input.worktreePath,
    patchPath: input.patchPath,
    branch: input.plan.proposedSourceBranch,
    baseRevision: input.plan.baseRevision,
    patchSha256: input.plan.patch.sha256,
    changedFilesSha256: changedFilesDigest(input.changedFiles),
    state: "failed",
  };
  capabilities.set(capability, {
    plan: structuredClone(input.plan),
    artifactStoreRoot: input.artifactStoreRoot,
    workflow: input.workflow,
    changedFiles: structuredClone(input.changedFiles),
    repositoryPath: input.repositoryPath,
    repositoryIdentity: input.repositoryIdentity,
    sourceGitDirectory: input.sourceGitDirectory,
    commonGitDirectory: input.commonGitDirectory,
    gitConfigSnapshot: input.gitConfigSnapshot,
    deliveryRootPath: input.deliveryRootPath,
    deliveryRootIdentity: input.deliveryRootIdentity,
    capsulePath: input.capsulePath,
    capsuleIdentity: input.capsuleIdentity,
    worktreePath: input.worktreePath,
    branch: input.plan.proposedSourceBranch,
    baseRevision: input.plan.baseRevision,
    planSha256: input.plan.sha256,
    runId: input.plan.run.id,
    recordSha256: input.plan.run.recordSha256,
    patchSha256: input.plan.patch.sha256,
    targetBranch: input.plan.targetBranch.name,
    remoteName: input.plan.remote.name,
    projectId: input.plan.project.id,
    publicationAuthorization: input.authorization,
    patchIdentity: input.patchIdentity,
    worktreeRemoved: false,
    worktreeRegistered: false,
    branchCreated: false,
    createsSourceBranch: input.createsSourceBranch,
    expectedSourceBranchRevision: input.expectedSourceBranchRevision,
    ...(input.retainedHeadShape
      ? {
          retainedHeadShape: input.retainedHeadShape,
          expectedDeliveryHeadRevision: input.expectedDeliveryHeadRevision,
        }
      : {}),
    metadataInputDigests: publicationMetadataInputDigests(
      input.workflowOutcome,
      input.changedFiles.map((file) => file.path),
      input.compositionExecution,
    ),
    branchDeleted: false,
    state: "failed",
  });
  return capability;
}

/** Whether a blob the change adds or alters holds one of DocsFab's own configured credentials. */
function changedBlobsHoldConfiguredCredential(
  tree: readonly GitTreeEntry[],
  changed: readonly ChangedFileEvidence[],
): boolean {
  const written = new Set(
    changed.filter((file) => file.status !== "deleted").map((file) => file.path),
  );
  return tree.some(
    (entry) => written.has(entry.path) && containsConfiguredCredentialInBytes(entry.bytes),
  );
}

export function failedResult(
  worktree: DeliveryWorktreeCapability,
  code: DeliveryWorktreeFailureCode,
): PrepareDeliveryWorktreeResult {
  setCapabilityState(worktree, "failed");
  worktree.failureCode = code;
  return { status: "failed", code, worktree };
}

export async function collectObjectChangedFiles(
  commands: DeliveryCommandRunner,
  worktreePath: string,
  baseRevision: string,
  tree: string,
): Promise<ChangedFileEvidence[]> {
  const output = await requireGit(
    commands,
    worktreePath,
    [
      "diff-tree",
      "--no-commit-id",
      "--no-ext-diff",
      "--no-textconv",
      "-r",
      "--name-status",
      "-z",
      "--find-renames",
      "--find-copies",
      "--find-copies-harder",
      baseRevision,
      tree,
      "--",
    ],
    "patch-application-failed",
  );
  const fields = output.toString("utf8").split("\0");
  if (fields.at(-1) === "") fields.pop();
  const files: ChangedFileEvidence[] = [];
  for (let index = 0; index < fields.length; ) {
    const statusField = fields[index++];
    if (!statusField || !/^[AMDRCT][0-9]*$/u.test(statusField)) fail("patch-path-mismatch");
    const statusCode = statusField[0]!;
    if (statusCode === "R" || statusCode === "C") {
      const previousPath = fields[index++];
      const path = fields[index++];
      if (
        !previousPath ||
        !path ||
        !safeRepositoryPath(previousPath) ||
        !safeRepositoryPath(path)
      ) {
        fail("patch-path-mismatch");
      }
      files.push({
        path,
        previousPath,
        status: statusCode === "R" ? "renamed" : "copied",
      });
    } else {
      const path = fields[index++];
      if (!path || !safeRepositoryPath(path)) fail("patch-path-mismatch");
      files.push({
        path,
        status: statusCode === "A" ? "added" : statusCode === "D" ? "deleted" : "modified",
      });
    }
  }
  return files;
}

export async function materializeGitTree(
  root: string,
  entries: readonly GitTreeEntry[],
  authorizeMutation: () => void = () => undefined,
): Promise<void> {
  const directories = new Set<string>();
  for (const entry of entries) {
    const segments = entry.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }
  for (const directory of [...directories].sort(
    (left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right),
  )) {
    const path = join(root, ...directory.split("/"));
    authorizeMutation();
    await mkdir(path, { mode: 0o755 });
    authorizeMutation();
    await chmod(path, 0o755);
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  for (const entry of entries) {
    const path = join(root, ...entry.path.split("/"));
    if (entry.mode === "120000") {
      const target = entry.bytes.toString("utf8");
      if (!Buffer.from(target).equals(entry.bytes) || target.includes("\0")) {
        fail("patch-application-failed");
      }
      authorizeMutation();
      await symlink(target, path);
      continue;
    }
    authorizeMutation();
    const handle = await open(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      entry.mode === "100755" ? 0o755 : 0o644,
    );
    try {
      authorizeMutation();
      await handle.writeFile(entry.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    authorizeMutation();
    await chmod(path, entry.mode === "100755" ? 0o755 : 0o644);
  }
}

export function sameChangedFiles(
  actual: ChangedFileEvidence[],
  expected: ChangedFileEvidence[],
): boolean {
  return changedFilesDigest(actual) === changedFilesDigest(expected);
}

export function changedFilesDigest(files: ChangedFileEvidence[]): string {
  const normalized = [...files]
    .map((file) => ({
      path: file.path,
      status: file.status,
      ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
    }))
    .sort((left, right) => changedFileKey(left).localeCompare(changedFileKey(right)));
  return createHash("sha256")
    .update(canonicalizeJsonEvidence(normalized as unknown as JsonEvidenceValue))
    .digest("hex");
}

export function changedFileKey(file: ChangedFileEvidence): string {
  return `${file.status}\0${file.previousPath ?? ""}\0${file.path}`;
}

export async function secureDeliveryRoot(
  path: string,
  authorizeMutation: () => void,
): Promise<{ path: string; identity: FsIdentity }> {
  if (!isAbsolute(path)) fail("delivery-root-unsafe");
  try {
    authorizeMutation();
    await mkdir(path, { recursive: true, mode: 0o700 });
    const canonical = await realpath(resolve(path));
    const details = await lstat(path);
    if (details.isSymbolicLink() || !ownerOnlyDirectory(details)) {
      fail("delivery-root-unsafe");
    }
    return { path: canonical, identity: fileIdentity(details) };
  } catch (error) {
    if (error instanceof DeliveryWorktreeError) throw error;
    fail("delivery-root-unsafe");
  }
}

export async function writePrivateExact(
  path: string,
  bytes: Buffer,
  authorizeMutation: () => void,
): Promise<FsIdentity> {
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  authorizeMutation();
  const handle = await open(
    path,
    fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
    0o600,
  ).catch(() => fail("delivery-collision"));
  try {
    authorizeMutation();
    await handle.writeFile(bytes);
    await handle.sync();
    const details = await handle.stat();
    const pathDetails = await lstat(path);
    const copied = Buffer.alloc(bytes.byteLength);
    if (bytes.byteLength > 0) await handle.read(copied, 0, bytes.byteLength, 0);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      uid === undefined ||
      !details.isFile() ||
      details.uid !== uid ||
      pathDetails.isSymbolicLink() ||
      !pathDetails.isFile() ||
      details.dev !== pathDetails.dev ||
      details.ino !== pathDetails.ino ||
      details.size !== bytes.byteLength ||
      (details.mode & 0o077) !== 0 ||
      !copied.equals(bytes)
    )
      fail("patch-mismatch");
    return fileIdentity(details);
  } finally {
    await handle.close();
  }
}

export async function verifyPatchCopy(
  trusted: TrustedCapability,
  expectedBytes: Buffer,
): Promise<void> {
  await assertTrustedPaths(trusted, trusted.worktreeIdentity !== undefined);
  await assertIdentity(trusted.capsulePath, trusted.capsuleIdentity, "patch-mismatch", "directory");
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      join(trusted.capsulePath, "verified.patch"),
      fsConstants.O_RDONLY | noFollow,
    );
    const before = await handle.stat();
    if (
      before.dev !== trusted.patchIdentity.dev ||
      before.ino !== trusted.patchIdentity.ino ||
      before.uid !== trusted.patchIdentity.uid ||
      before.mode !== trusted.patchIdentity.mode ||
      before.size !== expectedBytes.byteLength
    )
      fail("patch-mismatch");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    await assertIdentity(
      join(trusted.capsulePath, "verified.patch"),
      trusted.patchIdentity,
      "patch-mismatch",
      "file",
    );
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      !bytes.equals(expectedBytes) ||
      createHash("sha256").update(bytes).digest("hex") !== trusted.patchSha256
    )
      fail("patch-mismatch");
  } catch (error) {
    if (error instanceof DeliveryWorktreeError) throw error;
    fail("patch-mismatch");
  } finally {
    await handle?.close();
  }
}

export async function runPatchGit(
  commands: DeliveryCommandRunner,
  trusted: TrustedCapability,
  expectedBytes: Buffer,
  args: readonly string[],
  authorizeMutation?: () => void,
): Promise<DeliveryCommandResult> {
  await verifyPatchCopy(trusted, expectedBytes);
  authorizeMutation?.();
  const result = await runGit(commands, args, trusted.worktreePath, {
    stdin: expectedBytes,
  });
  await verifyPatchCopy(trusted, expectedBytes);
  return result;
}
