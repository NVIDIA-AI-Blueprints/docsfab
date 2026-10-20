// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Leaf execute path for local-user GitLab publication. Host composition calls
 * this module, not `cli.ts`, so `cli.ts` can import the delivery orchestrator
 * without a value-import cycle back into the host.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  publishLocalUserGitLab,
  LocalUserGitLabPublisherError,
  type LocalUserGitLabPublisherDependencies,
} from "./publisher.js";
import { DeterministicLocalGitPublisher } from "./git-publisher.js";
import {
  preflightLocalUserGitLabPublication,
  loadAdvanceRootPlan,
  loadVerifiedPublicationRun,
  reloadVerifiedPublicationRun,
  resolveLocalUserGitIdentity,
  ExecFileReadOnlyCommandRunner,
  type ReadOnlyCommandRunner,
} from "./preflight.js";
import type { PublicationRunRecordDecodeOptionsV1 } from "./run-record.js";
import {
  assertCurrentLocalUserPublicationAuthorization,
  authorizeLocalUserPublication,
  DeliveryWorktreeError,
  LocalUserPublicationPreflightError,
  canonicalLocalUserPublicationAdvance,
  localUserPublicationAdvance,
  requireFreshDocumentationPlanForMutation,
  type DeliveryValidationFailureEvidence,
  type DeliveryWorktreeFailureCode,
  type LocalUserPublicationAdvanceV1,
  type LocalUserPublicationAuthorizationV1,
  type LocalUserPublicationPlan,
} from "./contracts.js";
import {
  ExecFileDeliveryCommandRunner,
  inspectReadyDeliveryWorktree,
  prepareDeliveryWorktree,
  type DeliveryCommandRunner,
  type DeliveryValidationIsolator,
} from "./worktree.js";
import { trustedDocumentationValidationFailureEvidence } from "./worktree/validate.js";
import {
  directRefRevision,
  resolveCommonGitDirectory,
  resolveGitDirectoryFromWorktree,
  readDirectHead,
} from "./worktree/host.js";
import { deliveryCapsuleName } from "./worktree/materialize.js";
import { FileScmDeliveryReceiptStore, type ScmDeliveryReceiptStore } from "./receipt-store.js";
import {
  clearRunDeliveryAttemptLocation,
  buildRunDeletionPreviewCommand as runDeletionPreviewCommand,
  locateRunDeliveryAttempts,
  recordRunDeliveryAttemptLocation,
} from "./run-deletion-adapter.js";
import { projectRunRetainedDeliveryV1 } from "../records/retained-delivery.js";
import { assertRunNotTombstoned, withActiveRunGate } from "../records/run-maintenance-gate.js";
import { recordOpenedRunDeliveryOrReport } from "./run-delivery-index.js";
import type { LocalUserGitLabPublicationResultV1 } from "./publication-result.js";
import { resolveDocsFabPublicationRoots } from "../config/host-paths.js";
import { resolveProjectConfigAuthority } from "../project-config-preflight.js";
import { projectPublicationEvidenceFromRunLineage } from "../publication/index.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import type { WorkflowOutcomeDecodeOptionsV1 } from "../workflow-contracts/outcome.js";
import {
  createScmDeliveryRecord,
  failScmDeliveryRecord,
  recordScmDeliveryProgress,
  scmDeliveryIdempotencyKey,
  validationEvidenceFromReadyAttestation,
  type ScmDeliveryRecord,
  type ScmDeliveryFailureCode,
} from "./receipt.js";

export interface LocalUserPublishCliDependencies {
  commands?: ReadOnlyCommandRunner;
  cwd: string;
  stateDirectory: string;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  log(message: string): void;
  stderr?: (message: string) => void;
  deliveryCommands?: DeliveryCommandRunner;
  isolateValidation?: DeliveryValidationIsolator;
  receiptStore?: ScmDeliveryReceiptStore;
  publisher?: LocalUserGitLabPublisherDependencies;
  /** Test seams for exercising CLI restart orchestration without external GitLab. */
  preflight?: typeof preflightLocalUserGitLabPublication;
  prepareWorktree?: typeof prepareDeliveryWorktree;
  inspectReady?: typeof inspectReadyDeliveryWorktree;
  loadRun?: typeof loadVerifiedPublicationRun;
  /** Process-local validators for current retained branch and editorial evidence. */
  editorialDecodeOptions?: WorkflowOutcomeDecodeOptionsV1;
  /** Trusted clock seam for authorization checks at host mutation boundaries. */
  clock?: () => Date;
  execute?: (
    args: readonly string[],
    dependencies: LocalUserPublishCliDependencies,
  ) => Promise<LocalUserPublishExecuteCliResult | undefined>;
}

interface PublishCliOptions {
  runId: string;
  repositoryPath: string;
  stateDirectory: string;
  remoteName?: string;
  targetBranch?: string;
  proposedSourceBranch?: string;
  validationCommand?: string;
}

interface PublishExecuteCliOptions extends PublishCliOptions {
  confirmedPlanSha256: string;
  deliveryRoot?: string;
  receiptRoot?: string;
}

/** Argv for `--execute` after the host has bound a fresh plan digest. */
export function localUserPublishExecuteArgv(options: PublishExecuteCliOptions): string[] {
  return [
    options.runId,
    "--repo",
    options.repositoryPath,
    "--draft-mr",
    "--execute",
    "--confirm-plan-sha256",
    options.confirmedPlanSha256,
    "--state-dir",
    options.stateDirectory,
    ...(options.validationCommand ? ["--validation-command", options.validationCommand] : []),
    ...(options.remoteName ? ["--remote", options.remoteName] : []),
    ...(options.targetBranch ? ["--target-branch", options.targetBranch] : []),
    ...(options.proposedSourceBranch ? ["--source-branch", options.proposedSourceBranch] : []),
    ...(options.deliveryRoot ? ["--delivery-root", options.deliveryRoot] : []),
    ...(options.receiptRoot ? ["--receipt-root", options.receiptRoot] : []),
  ];
}

/** Typed execute options a host passes beside argv; none has an argv flag. */
export interface LocalUserPublishExecuteOptions {
  /** Add one commit to the named DocsFab-minted draft-MR branch instead of creating one. */
  readonly advance?: LocalUserPublicationAdvanceV1;
  /** Decode options for the advance parent's run record; an editorial parent needs them. */
  readonly parentEditorialDecodeOptions?: PublicationRunRecordDecodeOptionsV1;
}

export type LocalUserPublishExecuteCliResult = {
  readonly mergeRequest?: {
    readonly iid: number;
    readonly url: string;
    readonly draft: true;
    readonly headRevision: string;
  };
  /** Typed terminal evidence for coordinators; the CLI JSON line remains stable. */
  readonly publicationResult?: LocalUserGitLabPublicationResultV1;
};

export async function runLocalUserPublishExecuteCli(
  args: readonly string[],
  dependencies: LocalUserPublishCliDependencies,
  executeOptions: LocalUserPublishExecuteOptions = {},
): Promise<LocalUserPublishExecuteCliResult | undefined> {
  const options = parseLocalUserPublishExecuteCliOptions(args, dependencies);
  return withActiveRunGate(options.stateDirectory, options.runId, async () => {
    await assertRunNotTombstoned(options.stateDirectory, options.runId);
    return runLocalUserPublishExecuteCliUnderGate(args, dependencies, executeOptions);
  });
}

async function runLocalUserPublishExecuteCliUnderGate(
  args: readonly string[],
  dependencies: LocalUserPublishCliDependencies,
  executeOptions: LocalUserPublishExecuteOptions,
): Promise<LocalUserPublishExecuteCliResult | undefined> {
  const options = parseLocalUserPublishExecuteCliOptions(args, dependencies);
  const runRecordPath = resolve(options.stateDirectory, `${options.runId}.json`);
  const repositoryPath = await realpath(options.repositoryPath);
  const resolvedRoots = await resolveExecutePublicationRoots(repositoryPath, options, dependencies);
  const existingReceiptRoot = dependencies.receiptStore
    ? undefined
    : await existingPrivatePublicationRoot(resolvedRoots.receiptRoot);
  const initialReceiptStore =
    dependencies.receiptStore ??
    (existingReceiptRoot ? new FileScmDeliveryReceiptStore(existingReceiptRoot) : undefined);
  const storedPlan = await initialReceiptStore?.loadPlan?.(options.confirmedPlanSha256);
  const plan =
    storedPlan ??
    (await (dependencies.preflight ?? preflightLocalUserGitLabPublication)(
      {
        runId: options.runId,
        runRecordPath,
        repositoryPath,
        ...(options.remoteName ? { remoteName: options.remoteName } : {}),
        ...(options.targetBranch ? { targetBranch: options.targetBranch } : {}),
        ...(options.proposedSourceBranch
          ? { proposedSourceBranch: options.proposedSourceBranch }
          : {}),
        ...(options.validationCommand ? { validationCommand: options.validationCommand } : {}),
        ...(executeOptions.advance ? { advance: executeOptions.advance } : {}),
        draftMergeRequest: true,
      },
      dependencies.commands,
      dependencies.editorialDecodeOptions ?? {},
      {
        ...(initialReceiptStore ? { receiptStore: initialReceiptStore } : {}),
        ...(executeOptions.parentEditorialDecodeOptions
          ? { parentEditorialDecodeOptions: executeOptions.parentEditorialDecodeOptions }
          : {}),
        // The environment the publisher's Git runs with below (#2393).
        ...(dependencies.environment ? { environment: dependencies.environment } : {}),
      },
    ));
  // A stored plan and a typed advance must agree; neither silently wins.
  const planAdvance = localUserPublicationAdvance(plan);
  if (
    executeOptions.advance !== undefined &&
    (planAdvance === undefined ||
      canonicalLocalUserPublicationAdvance(planAdvance) !==
        canonicalLocalUserPublicationAdvance(executeOptions.advance))
  ) {
    // hygiene: envelope — the catalog row for this code renders the action.
    throw new LocalUserPublicationPreflightError("revision-parent-mismatch", {
      revision: { field: "advance", observed: "differs from the confirmed plan" },
    });
  }
  if (plan.sha256 !== options.confirmedPlanSha256) {
    throw new Error(
      "Confirmed publication plan digest does not match fresh preflight. Retry with docsfab publish <run-id> --draft-mr.",
    );
  }
  const storedReceipt = storedPlan
    ? await initialReceiptStore?.load(scmDeliveryIdempotencyKey(plan))
    : undefined;
  requireFreshDocumentationPlanForMutation(
    plan,
    storedPlan !== undefined,
    storedReceipt?.disposition,
  );
  if (storedPlan) assertStoredPlanMatchesOptions(storedPlan, options);
  const preparationAuthorization = authorizeLocalUserPublication({
    plan,
    confirmedPlanSha256: options.confirmedPlanSha256,
    command: "publish",
    currentTime: (dependencies.clock ?? (() => new Date()))(),
  });
  const assertPreparationAuthorized = (): void =>
    assertCurrentPublicationAuthorization(
      preparationAuthorization,
      plan,
      dependencies.clock ?? (() => new Date()),
    );
  const roots = await securePublicationRoots(
    repositoryPath,
    resolvedRoots.deliveryRoot,
    resolvedRoots.receiptRoot,
    assertPreparationAuthorized,
  );
  const receiptStore = initialReceiptStore ?? new FileScmDeliveryReceiptStore(roots.receiptRoot);
  const existing = storedReceipt ?? (await receiptStore.load(scmDeliveryIdempotencyKey(plan)));
  if (existing && existing.planSha256 !== plan.sha256) {
    throw new Error("Existing publication receipt does not match fresh preflight.");
  }
  let receipt: ScmDeliveryRecord;
  if (existing) receipt = existing;
  else {
    assertPreparationAuthorized();
    const claimed = await receiptStore.claim(
      createScmDeliveryRecord({
        plan,
        authorization: preparationAuthorization,
        createdAt: new Date().toISOString(),
      }),
      plan,
      assertPreparationAuthorized,
    );
    receipt = claimed.record;
  }
  const recovery = buildRecoveryCommand(options, roots);
  const stateDirectory = await realpath(options.stateDirectory);
  let priorAttempts: string[];
  try {
    priorAttempts = await locateRunDeliveryAttempts({
      stateDirectory,
      runId: options.runId,
      recordSha256: plan.run.recordSha256,
      deliveryRoot: roots.deliveryRoot,
      planSha256: plan.sha256,
      capsuleName: deliveryCapsuleName(plan),
    });
  } catch {
    // Metadata discovery failure is reported without treating an unverified path as preserved.
    await retainAndReportDeliveryFailure({
      receipt,
      receiptStore,
      plan,
      recovery,
      retained: {
        repositoryPath: roots.repositoryPath,
        worktreePaths: [],
        cleanupPreviewCommand: buildRunDeletionPreviewCommand(options.runId, stateDirectory, roots),
      },
      worktreeCode: "delivery-collision",
      log: dependencies.log,
    });
    throw retainedAttemptCollision();
  }
  // Bind the candidate before checking its contents. An empty recorded path
  // does not authorize falling through to a different discovered legacy root.
  const selectedAttemptRoot = priorAttempts[0];
  const retainedAttemptRoot =
    selectedAttemptRoot !== undefined && !(await attemptRootHasNoResources(selectedAttemptRoot))
      ? selectedAttemptRoot
      : undefined;
  const attemptRoot = selectedAttemptRoot ?? join(roots.deliveryRoot, "attempts", randomUUID());
  let retainedHead: Awaited<ReturnType<typeof retainedAttemptHead>> | undefined;
  let retainedHeadError: unknown;
  if (retainedAttemptRoot !== undefined) {
    try {
      retainedHead = await retainedAttemptHead(attemptRoot, plan, receipt, roots.repositoryPath);
    } catch (error) {
      retainedHeadError = error;
    }
  }
  const retained: RetainedDeliveryAttempt = {
    repositoryPath: roots.repositoryPath,
    worktreePath: join(attemptRoot, deliveryCapsuleName(plan), "repository"),
    worktreePaths: [...new Set([attemptRoot, ...priorAttempts])].map((path) =>
      join(path, deliveryCapsuleName(plan), "repository"),
    ),
    branch: plan.proposedSourceBranch,
    cleanupPreviewCommand: buildRunDeletionPreviewCommand(options.runId, stateDirectory, roots),
  };
  let attemptLocation: string | undefined;
  const rehydratePublished =
    receipt.state === "committed" || receipt.state === "pushed" || receipt.state === "opened";
  const expectedSourceRevision = rehydratePublished ? receipt.evidence.commit?.sha : undefined;
  if (rehydratePublished && expectedSourceRevision === undefined) {
    throw new Error("Committed publication receipt is missing its exact source revision.");
  }
  let preparedReceiptWriteFailed = false;
  let prepared: Awaited<ReturnType<typeof prepareDeliveryWorktree>>;
  try {
    attemptLocation = await recordRunDeliveryAttemptLocation({
      schemaVersion: 2,
      kind: "docsfab-run-delivery-attempt-location",
      stateDirectory,
      receiptRoot: roots.receiptRoot,
      runId: options.runId,
      recordSha256: plan.run.recordSha256,
      deliveryRoot: roots.deliveryRoot,
      attemptPath: attemptRoot,
      planSha256: plan.sha256,
    });
    if (retainedAttemptRoot !== undefined && retainedHead === undefined)
      throw retainedHeadError ?? new DeliveryWorktreeError("delivery-collision");
    prepared = await (dependencies.prepareWorktree ?? prepareDeliveryWorktree)(
      {
        plan,
        authorization: preparationAuthorization,
        runRecordPath,
        repositoryPath: roots.repositoryPath,
        deliveryRoot: attemptRoot,
        sourceBranchMode: retainedHead
          ? "reuse-retained"
          : rehydratePublished
            ? "rehydrate-published"
            : planAdvance
              ? "advance-published"
              : receipt.state === "planned"
                ? "create-or-reuse"
                : "reuse-existing",
        ...(retainedHead !== undefined || expectedSourceRevision === undefined
          ? {}
          : { expectedSourceRevision }),
        ...(retainedHead === undefined ? {} : { retainedHead }),
        onValidationIsolationUnavailable: () => {
          dependencies.log(
            [
              "Warning: the delivery-worktree confinement check was unavailable.",
              "This eligible interactive execution proceeds with operator-supervised validation; configure Docker Desktop (macOS) or Bubblewrap (Linux) before unattended publish.",
            ].join(" "),
          );
        },
        onPrepared: async (evidence) => {
          if (receipt.state !== "planned" || receipt.disposition !== "active") return;
          assertPreparationAuthorized();
          const preparedRecord = recordScmDeliveryProgress(
            receipt,
            {
              toState: "prepared",
              source: "executed",
              at: nextReceiptTimestamp(receipt),
              evidence,
            },
            plan,
            preparationAuthorization,
          );
          assertPreparationAuthorized();
          try {
            receipt = await receiptStore.compareAndSwap(
              receipt.sha256,
              preparedRecord,
              assertPreparationAuthorized,
            );
          } catch (error) {
            preparedReceiptWriteFailed = true;
            throw error;
          }
        },
      },
      dependencies.deliveryCommands ?? new ExecFileDeliveryCommandRunner(),
      dependencies.isolateValidation,
      ...(dependencies.editorialDecodeOptions ? [dependencies.editorialDecodeOptions] : []),
    );
  } catch (error) {
    const worktreeError = sanitizedDeliveryWorktreeError(error, receipt.state === "prepared");
    if (receipt.state === "planned" && !preparedReceiptWriteFailed && priorAttempts.length === 0)
      throw worktreeError;
    receipt = await retainAndReportDeliveryFailure({
      receipt,
      receiptStore,
      plan,
      recovery,
      retained,
      worktreeCode: worktreeError.code,
      validation: worktreeError.validation,
      persistenceAlreadyFailed: preparedReceiptWriteFailed,
      log: dependencies.log,
    });
    throw worktreeError;
  }
  if (prepared.status !== "ready") {
    const validation =
      trustedDocumentationValidationFailureEvidence(prepared.validation) ??
      inferredReturnedValidationFailure(prepared.code, plan);
    receipt = await retainAndReportDeliveryFailure({
      receipt,
      receiptStore,
      plan,
      recovery,
      retained,
      worktreeCode: prepared.code,
      validation,
      log: dependencies.log,
    });
    throw new DeliveryWorktreeError(prepared.code, validation);
  }
  let readyAttestation: Awaited<ReturnType<typeof inspectReadyDeliveryWorktree>>;
  try {
    readyAttestation = await (dependencies.inspectReady ?? inspectReadyDeliveryWorktree)(
      prepared.worktree,
    );
  } catch (error) {
    const worktreeError = sanitizedDeliveryWorktreeError(error, true);
    receipt = await retainAndReportDeliveryFailure({
      receipt,
      receiptStore,
      plan,
      recovery,
      retained,
      worktreeCode: worktreeError.code,
      validation: worktreeError.validation,
      log: dependencies.log,
    });
    throw worktreeError;
  }
  if (receipt.state === "prepared" && receipt.disposition === "active") {
    const validatedRecord = recordScmDeliveryProgress(
      receipt,
      {
        toState: "validated",
        source: "executed",
        at: nextReceiptTimestamp(receipt),
        evidence: {
          ...validationEvidenceFromReadyAttestation(readyAttestation.validation),
        },
      },
      plan,
      preparationAuthorization,
    );
    receipt = await receiptStore.compareAndSwap(receipt.sha256, validatedRecord);
  }
  const verifiedRun = await (dependencies.loadRun ?? reloadVerifiedPublicationRun)(
    runRecordPath,
    options.runId,
    ...(dependencies.editorialDecodeOptions ? [dependencies.editorialDecodeOptions] : []),
  );
  if (verifiedRun.recordSha256 !== plan.run.recordSha256) {
    throw new Error(
      "Run record changed after delivery preparation; preserved worktree was not published.",
    );
  }
  // Preparation and validation may be long-running. Issue a fresh short-lived
  // authorization immediately before entering the SCM mutation state machine.
  const authorization = authorizeLocalUserPublication({
    plan,
    confirmedPlanSha256: options.confirmedPlanSha256,
    command: "publish",
  });
  // A run without task lineage has no evidence, so the publisher uses its fallback.
  const evidence = verifiedRun.taskLineage
    ? projectPublicationEvidenceFromRunLineage(verifiedRun.taskLineage)
    : undefined;
  const advanceRoot = planAdvance
    ? await loadAdvanceRoot(planAdvance, receiptStore, runRecordPath, {
        loadRun: dependencies.loadRun ?? loadVerifiedPublicationRun,
        decodeOptions: executeOptions.parentEditorialDecodeOptions,
      })
    : undefined;
  // Resolved with the environment the publisher's Git runs with, so it is the
  // identity the plan bound and the publisher reads back (#2362).
  const identity = dependencies.publisher?.git
    ? undefined
    : await resolveLocalUserGitIdentity(
        dependencies.commands ?? new ExecFileReadOnlyCommandRunner(),
        repositoryPath,
        plan.project.host,
        undefined,
        dependencies.environment ?? process.env,
      );
  const result = await publishLocalUserGitLab(
    {
      plan,
      authorization,
      worktree: prepared.worktree,
      readyAttestation,
      receiptStore,
      workflowOutcome: verifiedRun.workflowOutcome,
      changedPaths: verifiedRun.changedFiles.map((file) => file.path),
      workflowId: verifiedRun.workflow,
      ...(verifiedRun.instruction !== undefined ? { instruction: verifiedRun.instruction } : {}),
      ...(verifiedRun.taskLineage ? { requestSha256: verifiedRun.taskLineage.requestSha256 } : {}),
      ...(verifiedRun.productOutcome ? { productOutcome: verifiedRun.productOutcome } : {}),
      ...(verifiedRun.requiredCheckLimitations
        ? { requiredCheckLimitations: verifiedRun.requiredCheckLimitations }
        : {}),
      recoveryCommand: recovery,
      ...(evidence ? { evidence } : {}),
      ...(verifiedRun.credentialFindings
        ? { credentialFindings: verifiedRun.credentialFindings }
        : {}),
      ...(advanceRoot ? { advanceRoot } : {}),
    },
    {
      ...dependencies.publisher,
      git:
        dependencies.publisher?.git ??
        new DeterministicLocalGitPublisher(
          undefined,
          {
            ...(dependencies.environment ?? process.env),
            GIT_AUTHOR_NAME: identity!.name,
            GIT_AUTHOR_EMAIL: identity!.email,
            GIT_COMMITTER_NAME: identity!.name,
            GIT_COMMITTER_EMAIL: identity!.email,
          },
          { repositoryRoots: [prepared.worktree.repositoryPath] },
        ),
    },
  );
  if (result.status === "opened") {
    await recordOpenedRunDeliveryOrReport({
      record: result.record,
      planSha256: plan.sha256,
      roots,
      stateDirectory: options.stateDirectory,
      environment: dependencies.environment ?? process.env,
      recoveryCommand: recovery,
      log: dependencies.log,
    });
  }
  // A failed push or merge request keeps the worktree and the committed branch.
  const retainedReport =
    result.status === "failed" ? await retainedDeliveryReport(retained) : undefined;
  for (const line of retainedReport?.lines ?? []) dependencies.log(line);
  dependencies.log(
    canonicalizeJsonEvidence({
      schemaVersion: 1,
      kind: "docsfab-local-user-gitlab-publication-result",
      status: result.status,
      planSha256: plan.sha256,
      idempotencyKey: result.record.idempotencyKey,
      receiptSha256: result.record.sha256,
      state: result.record.state,
      disposition: result.record.disposition,
      sourceBranch: result.record.sourceBranch,
      targetBranch: result.record.targetBranch,
      ...(verifiedRun.compositionExecution
        ? { compositionExecution: verifiedRun.compositionExecution }
        : {}),
      ...(result.status === "opened"
        ? {
            commitRevision: result.record.evidence.commit!.sha,
            mergeRequest: {
              iid: result.mergeRequest.iid,
              url: result.mergeRequest.url,
              draft: true,
              headRevision: result.mergeRequest.headRevision,
            },
          }
        : {
            runId: options.runId,
            failureCode: result.code,
            nextAction: result.nextAction,
            recoveryCommand: result.recoveryCommand,
            ...retainedReport?.fields,
          }),
    } as unknown as JsonEvidenceValue).trimEnd(),
  );
  if (result.status === "failed") {
    throw new LocalUserGitLabPublisherError(result.code, {
      recoveryCommand: result.recoveryCommand,
    });
  }
  // Test adapters and early successful paths may not create an attempt at all.
  // A real retained worktree keeps its location record for exact later deletion.
  if (
    !(await lstat(attemptRoot).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    ))
  )
    if (attemptLocation) await clearRunDeliveryAttemptLocation(attemptLocation);
  return {
    mergeRequest: result.mergeRequest,
    publicationResult: {
      schemaVersion: 1,
      kind: "docsfab-local-user-gitlab-publication-result",
      status: "opened",
      planSha256: plan.sha256,
      idempotencyKey: result.record.idempotencyKey,
      receiptSha256: result.record.sha256,
      state: "opened",
      disposition: "succeeded",
      sourceBranch: result.record.sourceBranch,
      targetBranch: result.record.targetBranch,
      commitRevision: result.record.evidence.commit!.sha,
      mergeRequest: {
        iid: result.mergeRequest.iid,
        url: result.mergeRequest.url,
        draft: true,
        headRevision: result.mergeRequest.headRevision,
      },
    },
  };
}

async function retainedAttemptHead(
  attemptRoot: string,
  plan: LocalUserPublicationPlan,
  receipt: ScmDeliveryRecord,
  repositoryPath: string,
): Promise<NonNullable<Parameters<typeof prepareDeliveryWorktree>[0]["retainedHead"]>> {
  try {
    const worktreePath = join(attemptRoot, deliveryCapsuleName(plan), "repository");
    const gitDirectory = await resolveGitDirectoryFromWorktree(worktreePath, "delivery-collision");
    const head = await readDirectHead(gitDirectory, "delivery-collision");
    const sourceGitDirectory = await resolveGitDirectoryFromWorktree(
      repositoryPath,
      "source-repository-mismatch",
    );
    const commonGitDirectory = await resolveCommonGitDirectory(
      sourceGitDirectory,
      "source-repository-mismatch",
    );
    const branchRevision = await directRefRevision(
      commonGitDirectory,
      `refs/heads/${plan.proposedSourceBranch}`,
      "delivery-collision",
    );
    const advance = localUserPublicationAdvance(plan);
    const committedRevision = receipt.evidence.commit?.sha;
    if (branchRevision === undefined) throw retainedAttemptCollision();
    if (head.branch === `refs/heads/${plan.proposedSourceBranch}`) {
      if (head.revision !== undefined) throw retainedAttemptCollision();
      if (branchRevision === plan.baseRevision)
        return { shape: "attached-base", revision: plan.baseRevision, branchRevision };
      if (branchRevision === committedRevision || committedRevision === undefined)
        return { shape: "attached-commit", revision: branchRevision, branchRevision };
    } else if (head.branch === undefined && head.revision === plan.baseRevision) {
      if (branchRevision === plan.baseRevision)
        return { shape: "detached-base", revision: plan.baseRevision, branchRevision };
      const advanceTips = new Set([advance?.lastRecordedHead, advance?.observedHead]);
      if (advanceTips.has(branchRevision))
        return { shape: "detached-base", revision: plan.baseRevision, branchRevision };
      if (branchRevision === committedRevision || committedRevision === undefined)
        return { shape: "detached-commit", revision: plan.baseRevision, branchRevision };
    }
  } catch (error) {
    if (error instanceof DeliveryWorktreeError) throw error;
  }
  throw retainedAttemptCollision();
}

async function attemptRootHasNoResources(attemptRoot: string): Promise<boolean> {
  try {
    const parentPath = dirname(attemptRoot);
    const deliveryRoot = dirname(parentPath);
    if (basename(parentPath) !== "attempts") return false;
    const delivery = await lstat(deliveryRoot);
    if (
      !delivery.isDirectory() ||
      delivery.isSymbolicLink() ||
      delivery.uid !== process.getuid?.() ||
      (delivery.mode & 0o077) !== 0 ||
      (await realpath(deliveryRoot)) !== deliveryRoot
    )
      return false;
    const parent = await lstat(parentPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!parent) return true;
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.uid !== process.getuid?.() ||
      (parent.mode & 0o077) !== 0 ||
      (await realpath(parentPath)) !== parentPath
    )
      return false;
    const attempt = await lstat(attemptRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!attempt) return true;
    if (
      !attempt.isDirectory() ||
      attempt.isSymbolicLink() ||
      attempt.uid !== process.getuid?.() ||
      (attempt.mode & 0o077) !== 0 ||
      (await realpath(attemptRoot)) !== attemptRoot
    )
      return false;
    const entries = await readdir(attemptRoot);
    if (entries.length === 0) return true;
    return false;
  } catch {
    return false;
  }
}

// hygiene: envelope — this typed delivery code is rendered through the situation catalog.
function retainedAttemptCollision(): DeliveryWorktreeError {
  return new DeliveryWorktreeError("delivery-collision");
}

/**
 * The first publication of the chain an advance revises, whose MR it reuses:
 * its stored plan, reached through each parent plan, and its run record from
 * the same state directory, bound to the digest that plan names.
 */
async function loadAdvanceRoot(
  advance: LocalUserPublicationAdvanceV1,
  receiptStore: ScmDeliveryReceiptStore,
  runRecordPath: string,
  load: {
    loadRun: typeof loadVerifiedPublicationRun;
    decodeOptions: PublicationRunRecordDecodeOptionsV1 | undefined;
  },
): Promise<{
  plan: LocalUserPublicationPlan;
  run: Awaited<ReturnType<typeof loadVerifiedPublicationRun>>;
}> {
  const unavailable = (field: string): LocalUserPublicationPreflightError =>
    new LocalUserPublicationPreflightError("revision-parent-record-unavailable", {
      revision: { field },
    });
  const parent = await receiptStore.loadPlan?.(advance.parent.planSha256).catch(() => undefined);
  if (!parent || parent.sha256 !== advance.parent.planSha256) throw unavailable("plan");
  const plan = await loadAdvanceRootPlan(parent, receiptStore);
  if (!plan) throw unavailable("plan");
  const run = await load
    .loadRun(
      join(dirname(runRecordPath), `${plan.run.id}.json`),
      plan.run.id,
      load.decodeOptions ?? {},
    )
    .catch(() => {
      throw unavailable("runRecord");
    });
  if (run.recordSha256 !== plan.run.recordSha256) throw unavailable("runRecord");
  return { plan, run };
}

function nextReceiptTimestamp(receipt: ScmDeliveryRecord): string {
  return new Date(Math.max(Date.now(), Date.parse(receipt.updatedAt) + 1)).toISOString();
}

function inferredReturnedValidationFailure(
  code: DeliveryWorktreeFailureCode,
  plan: LocalUserPublicationPlan,
): DeliveryValidationFailureEvidence | undefined {
  const reasonCode =
    code === "validation-isolation-unavailable"
      ? "validation-backend-unavailable"
      : code === "validation-failed"
        ? "validation-command-failed"
        : code === "validation-mutated-delivery"
          ? "validation-state-mutated"
          : undefined;
  if (reasonCode === undefined) return undefined;
  return {
    reasonCode,
    commandSha256: createHash("sha256").update(plan.validationCommand).digest("hex"),
  };
}

function sanitizedDeliveryWorktreeError(
  error: unknown,
  validationPhase: boolean,
): DeliveryWorktreeError {
  if (error instanceof DeliveryWorktreeError) {
    const validation =
      trustedDocumentationValidationFailureEvidence(error.validation) ??
      (error.code === "validation-failed"
        ? ({ reasonCode: "validation-exception" } as const)
        : error.code === "validation-isolation-unavailable"
          ? ({ reasonCode: "validation-backend-unavailable" } as const)
          : error.code === "validation-mutated-delivery"
            ? ({ reasonCode: "validation-state-mutated" } as const)
            : validationPhase
              ? ({ reasonCode: "validation-exception" } as const)
              : undefined);
    return new DeliveryWorktreeError(
      validationPhase &&
        error.code !== "validation-failed" &&
        error.code !== "validation-isolation-unavailable" &&
        error.code !== "validation-mutated-delivery"
        ? "validation-failed"
        : error.code,
      validation,
    );
  }
  return validationPhase
    ? new DeliveryWorktreeError("validation-failed", {
        reasonCode: "validation-exception",
      })
    : new DeliveryWorktreeError("worktree-creation-failed");
}

/** Where one attempt's preserved state lives and the run deletion preview that removes it. */
interface RetainedDeliveryAttempt {
  readonly repositoryPath: string;
  readonly worktreePath?: string;
  readonly worktreePaths: readonly string[];
  readonly branch?: string;
  readonly cleanupPreviewCommand: string;
}

/**
 * Human lines and result fields naming what a failed attempt kept. They are
 * logged before the result line, which callers decode as the last log line.
 */
async function retainedDeliveryReport(retained: RetainedDeliveryAttempt): Promise<{
  lines: string[];
  fields: {
    preservedWorktree?: string;
    preservedWorktrees?: string[];
    preservedBranch?: string;
    cleanupPreviewCommand?: string;
  };
}> {
  const worktrees = (
    await Promise.all(
      [...new Set([retained.worktreePath, ...retained.worktreePaths])]
        .filter((path): path is string => path !== undefined)
        .map(async (path) => ((await pathPresent(path)) ? path : undefined)),
    )
  ).filter((path): path is string => path !== undefined);
  const branch =
    retained.branch && (await branchPresent(retained.repositoryPath, retained.branch))
      ? retained.branch
      : undefined;
  const display = projectRunRetainedDeliveryV1({
    status: "retained",
    worktrees,
    branches: branch ? [branch] : [],
    keptBranches: [],
    cleanupPreviewCommand: retained.cleanupPreviewCommand,
    explanation: null,
  });
  const named = [
    ...(display.worktrees.length > 0
      ? [`worktree${display.worktrees.length === 1 ? "" : "s"} ${display.worktrees.join(", ")}`]
      : []),
    ...display.branches.map((retainedBranch) => `branch ${retainedBranch}`),
  ];
  return {
    lines: [
      ...(named.length > 0 ? [`Preserved for inspection: ${named.join(", ")}`] : []),
      ...(display.explanation ? [display.explanation] : []),
      ...(display.cleanupPreviewCommand
        ? [
            `Preview deleting this saved run and its preserved delivery state: ${display.cleanupPreviewCommand}`,
          ]
        : []),
    ],
    fields: {
      ...(display.worktrees[0] ? { preservedWorktree: display.worktrees[0] } : {}),
      ...(display.worktrees.length > 1 ? { preservedWorktrees: [...display.worktrees] } : {}),
      ...(display.branches[0] ? { preservedBranch: display.branches[0] } : {}),
      ...(display.cleanupPreviewCommand
        ? { cleanupPreviewCommand: display.cleanupPreviewCommand }
        : {}),
    },
  };
}

/** An unreadable path is left unnamed; the report never replaces the failure it reports. */
async function pathPresent(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

/** An unreadable repository leaves the branch unnamed, as `pathPresent` does for paths. */
async function branchPresent(repositoryPath: string, branch: string): Promise<boolean> {
  try {
    const commonGitDirectory = await resolveCommonGitDirectory(
      await resolveGitDirectoryFromWorktree(repositoryPath, "cleanup-refused"),
      "cleanup-refused",
    );
    return (
      (await directRefRevision(commonGitDirectory, `refs/heads/${branch}`, "cleanup-refused")) !==
      undefined
    );
  } catch {
    return false;
  }
}

async function retainAndReportDeliveryFailure(input: {
  receipt: ScmDeliveryRecord;
  receiptStore: ScmDeliveryReceiptStore;
  plan: LocalUserPublicationPlan;
  recovery: string;
  retained: RetainedDeliveryAttempt;
  worktreeCode: DeliveryWorktreeFailureCode;
  validation?: DeliveryValidationFailureEvidence;
  persistenceAlreadyFailed?: boolean;
  log: (message: string) => void;
}): Promise<ScmDeliveryRecord> {
  const failureCode = deliveryReceiptFailureCode(input.worktreeCode, input.receipt.state);
  let validation = failureCode === "prepare-failed" ? undefined : input.validation;
  let receipt = input.receipt;
  let failurePersistence: "stored" | "failed" = input.persistenceAlreadyFailed
    ? "failed"
    : "stored";
  if (receipt.disposition === "succeeded" || receipt.disposition === "recovered") {
    failurePersistence = "failed";
  } else if (!input.persistenceAlreadyFailed) {
    let failed: ScmDeliveryRecord | undefined;
    try {
      failed = failScmDeliveryRecord(
        receipt,
        {
          code: failureCode,
          at: nextReceiptTimestamp(receipt),
          ...(validation === undefined
            ? {}
            : {
                validation,
                ...(validation.workspaceKey === undefined
                  ? {}
                  : { validationWorkspaceKey: validation.workspaceKey }),
              }),
        },
        input.plan,
      );
    } catch {
      if (validation !== undefined) {
        validation = {
          reasonCode:
            failureCode === "validation-isolation-unavailable"
              ? "validation-backend-unavailable"
              : "validation-exception",
          commandSha256: createHash("sha256").update(input.plan.validationCommand).digest("hex"),
        };
        failed = failScmDeliveryRecord(
          receipt,
          {
            code: failureCode,
            at: nextReceiptTimestamp(receipt),
            validation,
          },
          input.plan,
        );
      } else {
        failurePersistence = "failed";
      }
    }
    if (failed !== undefined) {
      try {
        receipt = await input.receiptStore.compareAndSwap(receipt.sha256, failed);
        validation = receipt.failure?.validation;
      } catch {
        failurePersistence = "failed";
      }
    }
  }
  const report = await retainedDeliveryReport(input.retained);
  for (const line of report.lines) input.log(line);
  input.log(
    canonicalizeJsonEvidence({
      schemaVersion: 1,
      kind: "docsfab-local-user-gitlab-publication-result",
      status: "failed",
      planSha256: input.plan.sha256,
      runId: input.plan.run.id,
      runRecordSha256: input.plan.run.recordSha256,
      patchSha256: input.plan.patch.sha256,
      idempotencyKey: receipt.idempotencyKey,
      ...(failurePersistence === "stored"
        ? { receiptSha256: receipt.sha256 }
        : {
            lastDurableReceiptSha256: receipt.sha256,
            persistenceFailureCode: "receipt-write-failed",
          }),
      failurePersistence,
      state: receipt.state,
      disposition: receipt.disposition,
      failureCode,
      preparationFailureCode: input.worktreeCode,
      ...(validation === undefined ? {} : { validationFailure: validation }),
      nextAction:
        failurePersistence === "stored"
          ? (receipt.failure?.nextAction ?? "review-preserved-patch")
          : "review-preserved-patch",
      recoveryCommand: input.recovery,
      ...report.fields,
    } as unknown as JsonEvidenceValue).trimEnd(),
  );
  return receipt;
}

function deliveryReceiptFailureCode(
  code: DeliveryWorktreeFailureCode,
  state: ScmDeliveryRecord["state"],
): ScmDeliveryFailureCode {
  if (state === "planned") return "prepare-failed";
  if (code === "validation-isolation-unavailable") return "validation-isolation-unavailable";
  return "validation-failed";
}

function assertStoredPlanMatchesOptions(
  plan: Awaited<ReturnType<NonNullable<ScmDeliveryReceiptStore["loadPlan"]>>>,
  options: PublishExecuteCliOptions,
): void {
  if (
    !plan ||
    plan.run.id !== options.runId ||
    (options.remoteName !== undefined && plan.remote.name !== options.remoteName) ||
    (options.targetBranch !== undefined && plan.targetBranch.name !== options.targetBranch) ||
    (options.proposedSourceBranch !== undefined &&
      plan.proposedSourceBranch !== options.proposedSourceBranch) ||
    (options.validationCommand !== undefined &&
      plan.validationCommand !== options.validationCommand)
  ) {
    throw new Error("Recovery options do not match the durable publication plan.");
  }
}

async function securePublicationRoots(
  repositoryPath: string,
  deliveryRoot: string,
  receiptRoot: string,
  assertAuthorized: () => void,
): Promise<{
  repositoryPath: string;
  deliveryRoot: string;
  receiptRoot: string;
}> {
  const repository = await realpath(repositoryPath);
  for (const path of [deliveryRoot, receiptRoot]) {
    assertAuthorized();
    await mkdir(path, { recursive: true, mode: 0o700 });
    const details = await lstat(path);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      details.isSymbolicLink() ||
      !details.isDirectory() ||
      uid === undefined ||
      details.uid !== uid ||
      (details.mode & 0o077) !== 0
    ) {
      throw new Error("Publication roots must be owner-private real directories.");
    }
  }
  const delivery = await realpath(deliveryRoot);
  const receipt = await realpath(receiptRoot);
  if (
    overlaps(repository, delivery) ||
    overlaps(repository, receipt) ||
    overlaps(delivery, receipt)
  ) {
    throw new Error("Repository, delivery, and receipt roots must be canonically disjoint.");
  }
  return {
    repositoryPath: repository,
    deliveryRoot: delivery,
    receiptRoot: receipt,
  };
}

async function existingPrivatePublicationRoot(path: string): Promise<string | undefined> {
  try {
    const details = await lstat(path);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      details.isSymbolicLink() ||
      !details.isDirectory() ||
      uid === undefined ||
      details.uid !== uid ||
      (details.mode & 0o777) !== 0o700
    ) {
      throw new Error("Publication roots must be owner-private real directories.");
    }
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function assertCurrentPublicationAuthorization(
  authorization: LocalUserPublicationAuthorizationV1,
  plan: LocalUserPublicationPlan,
  clock: () => Date,
): void {
  assertCurrentLocalUserPublicationAuthorization(authorization, plan, clock());
}

function buildRecoveryCommand(
  options: PublishExecuteCliOptions,
  roots: { repositoryPath: string; deliveryRoot: string; receiptRoot: string },
): string {
  const values = [
    "docsfab",
    "publish",
    options.runId,
    "--draft-mr",
    "--execute",
    "--repo",
    roots.repositoryPath,
    "--state-dir",
    options.stateDirectory,
    "--confirm-plan-sha256",
    options.confirmedPlanSha256,
    "--delivery-root",
    roots.deliveryRoot,
    "--receipt-root",
    roots.receiptRoot,
    ...(options.remoteName ? ["--remote", options.remoteName] : []),
    ...(options.targetBranch ? ["--target-branch", options.targetBranch] : []),
    ...(options.proposedSourceBranch ? ["--source-branch", options.proposedSourceBranch] : []),
    ...(options.validationCommand ? ["--validation-command", options.validationCommand] : []),
  ];
  return values.map(shellQuote).join(" ");
}

/** `docsfab runs delete` preview naming every root this attempt used, so none is guessed. */
function buildRunDeletionPreviewCommand(
  runId: string,
  stateDirectory: string,
  roots: { deliveryRoot: string; receiptRoot: string },
): string {
  return runDeletionPreviewCommand(runId, stateDirectory, {
    deliveryRoots: [roots.deliveryRoot],
    receiptRoots: [roots.receiptRoot],
  });
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@+-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function parseLocalUserPublishExecuteCliOptions(
  args: readonly string[],
  dependencies: Pick<LocalUserPublishCliDependencies, "cwd" | "stateDirectory">,
): PublishExecuteCliOptions {
  if (!args.includes("--execute") || args.includes("--preflight")) {
    throw new Error("Publication execution requires --execute and cannot include --preflight.");
  }
  const values = executeValues(args);
  const runId = args[0];
  if (!runId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) {
    throw new Error("publish requires a safe <run-id>.");
  }
  const repository = values.get("--repo") ?? ".";
  const confirmedPlanSha256 = values.get("--confirm-plan-sha256");
  const deliveryRoot = values.get("--delivery-root");
  const receiptRoot = values.get("--receipt-root");
  if (!confirmedPlanSha256 || !/^[a-f0-9]{64}$/u.test(confirmedPlanSha256)) {
    throw new Error("--confirm-plan-sha256 requires one SHA-256 digest.");
  }
  if (
    (deliveryRoot !== undefined && !isAbsolute(deliveryRoot)) ||
    (receiptRoot !== undefined && !isAbsolute(receiptRoot))
  ) {
    throw new Error("--delivery-root and --receipt-root require explicit absolute paths.");
  }
  const repositoryPath = resolve(dependencies.cwd, repository);
  const stateDirectory = resolve(values.get("--state-dir") ?? dependencies.stateDirectory);
  const resolvedDeliveryRoot = deliveryRoot === undefined ? undefined : resolve(deliveryRoot);
  const resolvedReceiptRoot = receiptRoot === undefined ? undefined : resolve(receiptRoot);
  const publicationPaths = [
    repositoryPath,
    stateDirectory,
    ...(resolvedDeliveryRoot ? [resolvedDeliveryRoot] : []),
    ...(resolvedReceiptRoot ? [resolvedReceiptRoot] : []),
  ];
  if (!publicationPaths.every((path) => !/[\0\r\n]/u.test(path))) {
    throw new Error("Publication paths cannot contain control characters.");
  }
  if (
    (resolvedDeliveryRoot !== undefined && overlaps(resolvedDeliveryRoot, repositoryPath)) ||
    (resolvedReceiptRoot !== undefined && overlaps(resolvedReceiptRoot, repositoryPath)) ||
    (resolvedDeliveryRoot !== undefined &&
      resolvedReceiptRoot !== undefined &&
      overlaps(resolvedDeliveryRoot, resolvedReceiptRoot))
  ) {
    throw new Error("Repository, delivery, and receipt roots must be disjoint.");
  }
  return {
    runId,
    repositoryPath,
    stateDirectory,
    confirmedPlanSha256,
    ...(resolvedDeliveryRoot ? { deliveryRoot: resolvedDeliveryRoot } : {}),
    ...(resolvedReceiptRoot ? { receiptRoot: resolvedReceiptRoot } : {}),
    remoteName: values.get("--remote") ?? "origin",
    ...(values.get("--target-branch") ? { targetBranch: values.get("--target-branch") } : {}),
    ...(values.get("--source-branch")
      ? { proposedSourceBranch: values.get("--source-branch") }
      : {}),
    ...(values.get("--validation-command")
      ? { validationCommand: values.get("--validation-command") }
      : {}),
  };
}

async function resolveExecutePublicationRoots(
  repositoryPath: string,
  options: PublishExecuteCliOptions,
  dependencies: Pick<LocalUserPublishCliDependencies, "environment" | "homeDirectory">,
): Promise<{ deliveryRoot: string; receiptRoot: string }> {
  let deliveryRoot = options.deliveryRoot;
  let receiptRoot = options.receiptRoot;
  if (deliveryRoot === undefined || receiptRoot === undefined) {
    await resolveProjectConfigAuthority(repositoryPath);
    const privateRoots = resolveDocsFabPublicationRoots(
      dependencies.environment ?? process.env,
      options.stateDirectory,
    );
    if (deliveryRoot === undefined) deliveryRoot = privateRoots.deliveryRoot;
    if (receiptRoot === undefined) receiptRoot = privateRoots.receiptRoot;
  }
  if (deliveryRoot === undefined || receiptRoot === undefined) {
    throw new Error(
      "--delivery-root and --receipt-root could not be derived from the repository identity.",
    );
  }
  if (
    overlaps(deliveryRoot, repositoryPath) ||
    overlaps(receiptRoot, repositoryPath) ||
    overlaps(deliveryRoot, receiptRoot)
  ) {
    throw new Error("Repository, delivery, and receipt roots must be disjoint.");
  }
  return { deliveryRoot, receiptRoot };
}

function executeValues(args: readonly string[]): Map<string, string> {
  const flags = new Set(["--draft-mr", "--execute", "--json"]);
  const options = new Set([
    "--repo",
    "--state-dir",
    "--remote",
    "--target-branch",
    "--source-branch",
    "--validation-command",
    "--confirm-plan-sha256",
    "--delivery-root",
    "--receipt-root",
  ]);
  const values = new Map<string, string>();
  const seenFlags = new Set<string>();
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    if (flags.has(argument)) {
      if (seenFlags.has(argument)) throw new Error("Duplicate publish option.");
      seenFlags.add(argument);
      continue;
    }
    if (!options.has(argument)) throw new Error("Unknown publish option.");
    const value = args[index + 1];
    if (!value || value.startsWith("--") || values.has(argument)) {
      throw new Error(`${argument} requires one value.`);
    }
    values.set(argument, value);
    index += 1;
  }
  return values;
}

function overlaps(left: string, right: string): boolean {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  return (
    left === right ||
    (!leftToRight.startsWith("..") && !isAbsolute(leftToRight)) ||
    (!rightToLeft.startsWith("..") && !isAbsolute(rightToLeft))
  );
}
