// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { DurableArtifactStore } from "../../artifacts/store.js";
import { commandLineSettings, type ModelSlotSettingsV1 } from "../../config/model-settings.js";
import {
  decodeKnowledgeAcceptedSnapshot,
  type KnowledgeAcceptedSnapshotV1,
} from "../../canon/from-knowledge-snapshot.js";
import type { DocsFabConfig } from "../../config/runtime-loader.js";
import { canonicalDigest } from "../../contract-kit/index.js";
import { inspectProcessBirth, requireProcessBirthIdentity } from "../../init/storage.js";
import { internalCreateTaskLineageHostAuthority } from "../../lineage/authority-internal.js";
import {
  recoverTaskLineageArtifacts,
  decodeTaskOrigin,
  type TaskLineageArtifactsV1,
  type TaskLineageRecoveryAuthorizationV1,
} from "../../lineage/contracts.js";
import {
  assertRunTaskLineageResumeEquivalent,
  captureRunTaskLineage,
  serializeRunTaskLineage,
} from "../../lineage/run-capture.js";
import {
  createKnowledgeContinuationPrivateTask,
  createKnowledgeContinuationDeliveryIntent,
  createKnowledgeContinuationRetainedBytes,
  createKnowledgeContinuationReceipt,
  decodeKnowledgeContinuationPrivateTask,
  decodeKnowledgeContinuationReceipt,
  decodeKnowledgeContinuationRetainedBytes,
  decodeKnowledgeContinuationStoppedRun,
  KnowledgeContinuationError,
  knowledgeContinuationAcceptanceSha256,
  KNOWLEDGE_CONTINUATION_PRIVATE_TASK_SCHEMA_VERSION,
  matchesKnowledgeContinuationTargetConflictScope,
  type KnowledgeContinuationReceiptV1,
} from "../../records/knowledge-continuation.js";
import {
  KnowledgeContinuationAttemptStore,
  type KnowledgeContinuationAttemptV1,
  type KnowledgeContinuationProcessIdentityV1,
} from "../../records/knowledge-continuation-store.js";
import { FileRunStore } from "../../records/file-store.js";
import { createIndexedFileRunStore } from "../../records/run-index-store.js";
import { runModelSettings } from "../../records/run-model-settings.js";
import type { RunRecord } from "../../records/contracts.js";
import { decodeSuccessfulPublicationRunRecord } from "../../delivery/run-record.js";
import { decodeLocalUserGitLabPublicationResult } from "../../delivery/publication-result.js";
import {
  buildRunResultV1,
  defaultRunRecordPath,
  serializeRunResultV1,
} from "../../operator/index.js";
import { formatSectionHeader, indentCliBody } from "../../operator/cli-format.js";
import * as workflowCatalog from "../../workflow-registry/catalog.js";
import { resolveCliOperatorAuthorityId } from "../../lineage/cli-operator-directed.js";
import {
  continuationRequestedPageIntent,
  decodeOriginalTaskBinding,
  instructionSha256,
  inspectRequestedPageSupport,
  ORIGINAL_TASK_PATH,
} from "../knowledge-resume.js";
import { FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH } from "../first-pass.js";
import { loadSavedRunEditorialDecodeOptions } from "./editorial-replay.js";
import type { RunRequestWithPublishProjection } from "./request.js";
import type { RepositoryWorkspace } from "../../repository/workspace/contracts.js";
import { isNodeError } from "../../shared/primitives.js";

export interface LoadedKnowledgeContinuation {
  readonly request: RunRequestWithPublishProjection;
  readonly stopped: ReturnType<typeof decodeKnowledgeContinuationStoppedRun>;
  readonly receipt: KnowledgeContinuationReceiptV1;
  readonly privateTask: ReturnType<typeof decodeKnowledgeContinuationPrivateTask>;
  readonly snapshot: KnowledgeAcceptedSnapshotV1;
  readonly taskLineage: TaskLineageArtifactsV1;
  readonly recoveryAuthorization: TaskLineageRecoveryAuthorizationV1;
  readonly attempts: KnowledgeContinuationAttemptStore;
  readonly owner: KnowledgeContinuationProcessIdentityV1;
  readonly stateDirectory: string;
  readonly originalTaskBindingBytes: ReturnType<typeof decodeKnowledgeContinuationRetainedBytes>;
}

export interface ClaimedKnowledgeContinuation extends LoadedKnowledgeContinuation {
  readonly attempt: KnowledgeContinuationAttemptV1;
}

/** Project a durable stop without entering execution or delivery. */
export function reportKnowledgeContinuationStop(
  invocation: import("./request.js").CliRunInvocation,
  record: RunRecord,
): RunRecord {
  const recordPath = defaultRunRecordPath(invocation.config.stateDirectory, record.id);
  // The resume binds the same preset and command-line settings as the stop.
  const settings = commandLineSettings(record.modelSettings?.writing);
  const compositionId = invocation.request.compositionId ?? settings.compositionId;
  const command =
    `docsfab run ${record.workflow} --repo ${shellArgument(invocation.request.repositoryPath)}` +
    (compositionId ? ` --composition ${shellArgument(compositionId)}` : "") +
    settings.sets.map((pair) => ` --set ${shellArgument(pair)}`).join("") +
    ` --resume-from ${shellArgument(record.id)}` +
    " --canon-snapshot '<attributed-snapshot.json>' --accept-candidate-snapshot" +
    " --authority-id '<accountable-authority-id>' --allow-write" +
    (invocation.request.draftMr === true
      ? ` --draft-mr${invocation.request.remoteName ? ` --remote ${shellArgument(invocation.request.remoteName)}` : ""}`
      : " --patch-only");
  const nextSteps = [
    `Capture the accountable answer, then resume the retained task with: ${command}`,
  ];
  const json = invocation.options.json ?? invocation.request.json ?? false;
  if (json) {
    invocation.output.log(
      serializeRunResultV1(
        buildRunResultV1({
          record,
          recordPath,
          exitCode: 2,
          repositoryPath: invocation.request.repositoryPath,
          nextSteps,
        }),
      ).trimEnd(),
    );
  } else {
    const format = { tty: Boolean(process.stdout.isTTY) };
    for (const line of [
      formatSectionHeader("VERDICT", format),
      indentCliBody(`${record.workflow} ${record.id.slice(0, 8)}`),
      indentCliBody("Execution: needs-input (exit 2)"),
      "",
      formatSectionHeader("NEXT", format),
      indentCliBody(command),
      indentCliBody("Reason: Supply attributed knowledge and resume this retained task."),
      "",
      formatSectionHeader("RECORD", format),
      indentCliBody(recordPath),
    ])
      invocation.output.log(line);
  }
  process.exitCode = 2;
  return record;
}

/** Report a fixed child record without invoking writer or publisher again. */
export function reportCompletedKnowledgeContinuation(
  invocation: import("./request.js").CliRunInvocation,
  record: RunRecord,
  attempt: KnowledgeContinuationAttemptV1,
): RunRecord {
  const recordPath = defaultRunRecordPath(invocation.config.stateDirectory, record.id);
  const nextSteps = [
    "The retained writer result already completed; reuse this saved run and its publisher reconciliation.",
  ];
  const json = invocation.options.json ?? invocation.request.json ?? false;
  const publication = completedPublication(invocation.request.draftMr === true, attempt);
  if (json) {
    invocation.output.log(
      serializeRunResultV1(
        buildRunResultV1({
          record,
          recordPath,
          exitCode: 0,
          repositoryPath: invocation.request.repositoryPath,
          nextSteps,
        }),
      ).trimEnd(),
    );
  } else {
    const format = { tty: Boolean(process.stdout.isTTY) };
    const publicationLines =
      publication.status === "succeeded"
        ? [
            "",
            formatSectionHeader("PUBLICATION", format),
            indentCliBody(`Reused settled draft merge request: ${publication.mergeRequestUrl}`),
          ]
        : [];
    for (const line of [
      formatSectionHeader("VERDICT", format),
      indentCliBody(`${record.workflow} ${record.id.slice(0, 8)}`),
      indentCliBody("Execution: already-completed (exit 0)"),
      "",
      formatSectionHeader("NEXT", format),
      indentCliBody("Reuse the retained child run; no writer or delivery action was repeated."),
      ...publicationLines,
      "",
      formatSectionHeader("RECORD", format),
      indentCliBody(recordPath),
    ])
      invocation.output.log(line);
  }
  return record;
}

function completedPublication(
  draftMr: boolean,
  attempt: KnowledgeContinuationAttemptV1,
): import("../../operator/run-summary.js").RunSummaryPublicationOutcome {
  if (!draftMr) return { status: "not-requested" };
  const locator = attempt.deliveryResult?.locator;
  if (!locator) throw new KnowledgeContinuationError("delivery-recovery-required"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  return { status: "succeeded", mergeRequestUrl: locator };
}

function shellArgument(value: string): string {
  return /^[A-Za-z0-9_.\-/:@]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function artifactStore(config: DocsFabConfig): DurableArtifactStore {
  return new DurableArtifactStore(resolve(dirname(config.stateDirectory), "artifacts"));
}

function attemptStore(config: DocsFabConfig): KnowledgeContinuationAttemptStore {
  return new KnowledgeContinuationAttemptStore(
    resolve(dirname(config.stateDirectory), "knowledge-continuations"),
    { inspect: inspectProcessBirth },
  );
}

export async function persistKnowledgeContinuationStop(input: {
  request: RunRequestWithPublishProjection;
  config: DocsFabConfig;
  workspace: RepositoryWorkspace;
  runId: string;
  taskLineage: TaskLineageArtifactsV1;
  reason: string;
  notices?: readonly string[];
  targetConflictReceipt?: import("../../canon/from-knowledge-snapshot.js").KnowledgeResumeReceiptV1;
  /** The bound preset's settings; defaults to the loaded writing model's. */
  modelSettings?: ModelSlotSettingsV1;
}): Promise<RunRecord> {
  if (!input.request.instruction || !input.request.taskLineage) {
    throw new KnowledgeContinuationError("binding-mismatch"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  }
  const snapshotPath = resolve(input.workspace.path, FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH);
  let snapshotValue: unknown;
  let snapshotText: string;
  let originalTaskBindingText: string;
  try {
    snapshotText = await readFile(snapshotPath, "utf8");
    snapshotValue = JSON.parse(snapshotText) as unknown;
    originalTaskBindingText = await readFile(
      resolve(input.workspace.path, ORIGINAL_TASK_PATH),
      "utf8",
    );
  } catch {
    throw new KnowledgeContinuationError("artifact-missing"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  }
  const snapshot = decodeKnowledgeAcceptedSnapshot(snapshotValue);
  const repositoryIdentitySha256 = createHash("sha256")
    .update(input.workspace.sourcePath)
    .digest("hex");
  const projection = captureRunTaskLineage(
    { workflow: input.request.workflow, repository: input.workspace },
    input.taskLineage,
  );
  const serialized = serializeRunTaskLineage(input.taskLineage);
  const origin = JSON.parse(serialized.origin) as unknown;
  const lineage = JSON.parse(serialized.lineage) as unknown;
  const retainedCandidate = createKnowledgeContinuationRetainedBytes(
    "candidate-snapshot",
    snapshotText,
  );
  const retainedOriginalTaskBinding = createKnowledgeContinuationRetainedBytes(
    "original-task-binding",
    originalTaskBindingText,
  );
  const decodedOriginalTaskBinding = decodeOriginalTaskBinding(
    JSON.parse(originalTaskBindingText) as unknown,
  );
  if (
    decodedOriginalTaskBinding.workflow !== input.request.workflow ||
    decodedOriginalTaskBinding.instructionSha256 !== instructionSha256(input.request.instruction)
  )
    throw new KnowledgeContinuationError("binding-mismatch"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  const candidateArtifactSha256 = canonicalDigest(retainedCandidate);
  const originalTaskBindingArtifactSha256 = canonicalDigest(retainedOriginalTaskBinding);
  const originArtifactSha256 = canonicalDigest(origin);
  const lineageArtifactSha256 = canonicalDigest(lineage);
  // Only an admitted reading names pages a continuation may bind; an
  // advisory, offline or not-applicable one bound none, so none is stored.
  const recordedIntent = input.request.requestIntent;
  const privateTask = createKnowledgeContinuationPrivateTask({
    schemaVersion: KNOWLEDGE_CONTINUATION_PRIVATE_TASK_SCHEMA_VERSION,
    kind: "docsfab-knowledge-continuation-private-task",
    originalRunId: input.runId,
    workflow: input.request.workflow as "create-documentation" | "update-documentation",
    instruction: input.request.instruction,
    instructionSha256: instructionSha256(input.request.instruction),
    repository: {
      identitySha256: repositoryIdentitySha256,
      revision: input.workspace.revision,
      sourcePath: input.workspace.sourcePath,
      requestedRevision: input.workspace.requestedRevision,
    },
    delivery: createKnowledgeContinuationDeliveryIntent({
      mode: input.request.draftMr === true ? "draft-mr" : "patch-only",
      remoteName: input.request.draftMr === true ? (input.request.remoteName ?? "origin") : null,
      targetBranch:
        input.request.draftMr === true
          ? (input.request.gitlabTargetAtRunStart?.branch ?? null)
          : null,
      targetRevision:
        input.request.draftMr === true
          ? (input.request.gitlabTargetAtRunStart?.revision ?? null)
          : null,
    }),
    targetConflictReceipt: input.targetConflictReceipt ?? null,
    taskLineage: projection,
    continuationTargets:
      recordedIntent?.admission.outcome === "admitted"
        ? { source: "admitted-intent", requestIntent: recordedIntent }
        : null,
  });
  const originalTaskArtifactSha256 = canonicalDigest(privateTask);
  const store = artifactStore(input.config);
  await Promise.all([
    store.putRecord(candidateArtifactSha256, retainedCandidate),
    store.putRecord(originalTaskBindingArtifactSha256, retainedOriginalTaskBinding),
    store.putRecord(originArtifactSha256, origin),
    store.putRecord(lineageArtifactSha256, lineage),
    store.putRecord(originalTaskArtifactSha256, privateTask),
  ]);
  const receipt = createKnowledgeContinuationReceipt({
    schemaVersion: 1,
    kind: "docsfab-knowledge-continuation-receipt",
    originalRunId: input.runId,
    repositoryIdentitySha256,
    repositoryRevision: input.workspace.revision,
    workflow: privateTask.workflow,
    instructionSha256: privateTask.instructionSha256,
    candidateSnapshotSha256: snapshot.snapshotSha256,
    candidateArtifactSha256,
    candidateBytesSha256: retainedCandidate.bytesSha256,
    originalTaskArtifactSha256,
    originalTaskBindingArtifactSha256,
    originalTaskBindingBytesSha256: retainedOriginalTaskBinding.bytesSha256,
    originArtifactSha256,
    lineageArtifactSha256,
    taskLineageProjectionSha256: projection.projectionSha256,
    targetConflictReceipt: input.targetConflictReceipt ?? null,
    targetConflictReceiptSha256: input.targetConflictReceipt
      ? canonicalDigest(input.targetConflictReceipt)
      : null,
  });
  // The stopped pass called the model, so its record keeps the settings it
  // bound, and the resume commands repeat the command-line ones.
  const modelSettings = runModelSettings({
    writing: input.modelSettings ?? input.config.model?.modelSettings,
  });
  const now = new Date().toISOString();
  const record: RunRecord = {
    schemaVersion: 2,
    id: input.runId,
    workflow: privateTask.workflow,
    repository: {
      sourcePath: input.workspace.sourcePath,
      requestedRevision: input.workspace.requestedRevision,
      revision: input.workspace.revision,
    },
    workspace: { strategy: "tracked-export", disposable: true },
    taskLineage: projection,
    knowledgeContinuationReceipt: receipt,
    status: "needs-input",
    error: input.reason,
    ...(input.notices?.length ? { evidenceWarnings: [...new Set(input.notices)] } : {}),
    ...(modelSettings ? { modelSettings } : {}),
    createdAt: now,
    completedAt: now,
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [],
  };
  decodeKnowledgeContinuationStoppedRun(record);
  await createIndexedFileRunStore(input.config.stateDirectory).save(record);
  return record;
}

export async function loadKnowledgeContinuation(
  request: RunRequestWithPublishProjection,
  config: DocsFabConfig,
): Promise<LoadedKnowledgeContinuation | undefined> {
  if (!request.resumeFrom) return undefined;
  if (
    !request.canonSnapshotPath ||
    !request.allowWrite ||
    !request.acceptCandidateSnapshot ||
    !request.canonSnapshotAuthorityId
  ) {
    throw new KnowledgeContinuationError("binding-mismatch"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  }
  const stopped = decodeKnowledgeContinuationStoppedRun(
    await new FileRunStore(config.stateDirectory).get(request.resumeFrom),
  );
  const receipt = decodeKnowledgeContinuationReceipt(stopped.knowledgeContinuationReceipt);
  const store = artifactStore(config);
  let privateTaskValue: unknown;
  let origin: unknown;
  let lineage: unknown;
  let retainedSnapshotBytesValue: unknown;
  let originalTaskBindingBytesValue: unknown;
  try {
    [privateTaskValue, origin, lineage, retainedSnapshotBytesValue, originalTaskBindingBytesValue] =
      await Promise.all([
        store.getRecord(receipt.originalTaskArtifactSha256),
        store.getRecord(receipt.originArtifactSha256),
        store.getRecord(receipt.lineageArtifactSha256),
        store.getRecord(receipt.candidateArtifactSha256),
        store.getRecord(receipt.originalTaskBindingArtifactSha256),
      ]);
  } catch {
    throw new KnowledgeContinuationError("artifact-missing"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  }
  const privateTask = decodeKnowledgeContinuationPrivateTask(privateTaskValue);
  const retainedSnapshotBytes = decodeKnowledgeContinuationRetainedBytes(
    retainedSnapshotBytesValue,
  );
  const originalTaskBindingBytes = decodeKnowledgeContinuationRetainedBytes(
    originalTaskBindingBytesValue,
  );
  if (
    retainedSnapshotBytes.purpose !== "candidate-snapshot" ||
    retainedSnapshotBytes.bytesSha256 !== receipt.candidateBytesSha256 ||
    originalTaskBindingBytes.purpose !== "original-task-binding" ||
    originalTaskBindingBytes.bytesSha256 !== receipt.originalTaskBindingBytesSha256
  )
    throw new KnowledgeContinuationError("binding-mismatch"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  const retained = decodeKnowledgeAcceptedSnapshot(
    JSON.parse(retainedSnapshotBytes.text) as unknown,
  );
  const originalTaskBinding = decodeOriginalTaskBinding(
    JSON.parse(originalTaskBindingBytes.text) as unknown,
  );
  const supplied = decodeKnowledgeAcceptedSnapshot(
    JSON.parse(await readFile(request.canonSnapshotPath, "utf8")) as unknown,
  );
  const requestedRepositoryPath = await realpath(resolve(request.repositoryPath));
  if (
    privateTask.originalRunId !== receipt.originalRunId ||
    privateTask.workflow !== receipt.workflow ||
    privateTask.instructionSha256 !== receipt.instructionSha256 ||
    privateTask.repository.identitySha256 !== receipt.repositoryIdentitySha256 ||
    privateTask.repository.revision !== receipt.repositoryRevision ||
    privateTask.taskLineage.projectionSha256 !== receipt.taskLineageProjectionSha256 ||
    (receipt.targetConflictReceipt === null) !== (privateTask.targetConflictReceipt === null) ||
    (receipt.targetConflictReceipt !== null &&
      canonicalDigest(receipt.targetConflictReceipt) !==
        canonicalDigest(privateTask.targetConflictReceipt)) ||
    (privateTask.targetConflictReceipt === null
      ? receipt.targetConflictReceiptSha256 !== null
      : canonicalDigest(privateTask.targetConflictReceipt) !==
          receipt.targetConflictReceiptSha256 ||
        privateTask.targetConflictReceipt.snapshotSha256 !== receipt.candidateSnapshotSha256) ||
    retained.snapshotSha256 !== receipt.candidateSnapshotSha256 ||
    originalTaskBinding.workflow !== receipt.workflow ||
    originalTaskBinding.instructionSha256 !== receipt.instructionSha256 ||
    canonicalDigest(privateTask) !== receipt.originalTaskArtifactSha256 ||
    canonicalDigest(origin) !== receipt.originArtifactSha256 ||
    canonicalDigest(lineage) !== receipt.lineageArtifactSha256 ||
    canonicalDigest(retainedSnapshotBytes) !== receipt.candidateArtifactSha256 ||
    canonicalDigest(originalTaskBindingBytes) !== receipt.originalTaskBindingArtifactSha256
  )
    throw new KnowledgeContinuationError("binding-mismatch"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  if (
    request.workflow !== privateTask.workflow ||
    requestedRepositoryPath !== resolve(privateTask.repository.sourcePath)
  )
    throw new KnowledgeContinuationError("binding-mismatch"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  if (request.commentMr !== undefined || request.commentMrBinding !== undefined)
    throw new KnowledgeContinuationError("delivery-recovery-required"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  const currentDelivery = createKnowledgeContinuationDeliveryIntent({
    mode: request.draftMr === true ? "draft-mr" : "patch-only",
    remoteName: request.draftMr === true ? (request.remoteName ?? "origin") : null,
    targetBranch: request.draftMr === true ? privateTask.delivery.targetBranch : null,
    targetRevision: request.draftMr === true ? privateTask.delivery.targetRevision : null,
  });
  if (currentDelivery.intentSha256 !== privateTask.delivery.intentSha256)
    throw new KnowledgeContinuationError("delivery-recovery-required"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  if (
    request.instruction &&
    instructionSha256(request.instruction) !== privateTask.instructionSha256
  )
    throw new KnowledgeContinuationError("binding-mismatch"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  const inspection = inspectRequestedPageSupport(
    supplied,
    privateTask.instruction,
    continuationRequestedPageIntent(privateTask),
  );
  if (inspection.disposition !== "continue")
    throw new KnowledgeContinuationError("binding-mismatch"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  if (
    !matchesKnowledgeContinuationTargetConflictScope(
      privateTask.targetConflictReceipt,
      inspection.receipt,
      supplied.snapshotSha256,
    )
  )
    throw new KnowledgeContinuationError("binding-mismatch"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  const currentOperatorAuthorityId = resolveCliOperatorAuthorityId();
  const historicalOrigin = decodeTaskOrigin(origin);
  if (
    historicalOrigin.origin !== "operator-directed" ||
    historicalOrigin.approval.authorityId !== currentOperatorAuthorityId ||
    historicalOrigin.approval.operatorIdentitySha256 !==
      createHash("sha256").update(currentOperatorAuthorityId).digest("hex")
  )
    throw new KnowledgeContinuationError("binding-mismatch"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  const authority = internalCreateTaskLineageHostAuthority({
    async verifyCurrent(challenge) {
      if (
        !request.allowWrite ||
        request.workflow !== privateTask.workflow ||
        instructionSha256(privateTask.instruction) !== privateTask.instructionSha256 ||
        requestedRepositoryPath !== resolve(privateTask.repository.sourcePath) ||
        challenge.repository.identitySha256 !== privateTask.repository.identitySha256 ||
        challenge.repository.revision !== privateTask.repository.revision ||
        challenge.originClass !== "operator-directed" ||
        challenge.requestSha256 !== privateTask.taskLineage.requestSha256 ||
        challenge.taskSha256 !== privateTask.taskLineage.taskSha256 ||
        challenge.proposedOriginSha256 !== privateTask.taskLineage.originSha256 ||
        challenge.proposedLineageSha256 !== privateTask.taskLineage.lineageSha256
      )
        throw new KnowledgeContinuationError("binding-mismatch"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
      const observedAt = new Date().toISOString();
      return {
        status: "current",
        challengeSha256: challenge.challengeSha256,
        observedAt,
        authorityReceiptSha256: canonicalDigest({
          kind: "docsfab-cli-knowledge-continuation-recovery",
          authorityId: currentOperatorAuthorityId,
          challengeSha256: challenge.challengeSha256,
          observedAt,
          allowWrite: request.allowWrite,
          repositoryPath: requestedRepositoryPath,
        }),
      };
    },
  });
  const recovered = await recoverTaskLineageArtifacts(
    { origin, lineage },
    authority,
    workflowCatalog,
  );
  const projection = captureRunTaskLineage(
    {
      workflow: privateTask.workflow,
      repository: {
        sourcePath: privateTask.repository.sourcePath,
        requestedRevision: privateTask.repository.requestedRevision,
        revision: privateTask.repository.revision,
      },
    },
    recovered.artifacts,
  );
  assertRunTaskLineageResumeEquivalent(privateTask.taskLineage, projection);
  if (request.taskLineage) {
    const callerProjection = captureRunTaskLineage(
      {
        workflow: privateTask.workflow,
        repository: {
          sourcePath: privateTask.repository.sourcePath,
          requestedRevision: privateTask.repository.requestedRevision,
          revision: privateTask.repository.revision,
        },
      },
      request.taskLineage,
    );
    assertRunTaskLineageResumeEquivalent(privateTask.taskLineage, callerProjection);
  }
  const authorizationSha256 = canonicalDigest(recovered.authorization);
  const acceptanceSha256 = knowledgeContinuationAcceptanceSha256({
    receiptSha256: receipt.receiptSha256,
    recoveryAuthorizationSha256: recovered.authorization.authorizationSha256,
    snapshotSha256: supplied.snapshotSha256,
    targetConflictReceiptSha256: receipt.targetConflictReceiptSha256,
  });
  await store.putRecord(authorizationSha256, recovered.authorization);
  const owner = {
    pid: process.pid,
    processBirthIdentity: requireProcessBirthIdentity(process.pid),
  };
  return {
    request: {
      ...request,
      instruction: privateTask.instruction,
      revision: request.revisionExplicit ? request.revision : privateTask.repository.revision,
      ...(privateTask.delivery.mode === "draft-mr"
        ? { revisionPolicy: "explicit-sha" as const }
        : {}),
      taskLineage: recovered.artifacts,
      knowledgeContinuationReceipt: receipt,
      knowledgeContinuationRecoveryAuthorization: recovered.authorization,
      knowledgeContinuationSnapshotSha256: supplied.snapshotSha256,
      knowledgeContinuationAcceptanceSha256: acceptanceSha256,
      ...(inspection.receipt ? { knowledgeResumeReceipt: inspection.receipt } : {}),
    },
    stopped,
    receipt,
    privateTask,
    snapshot: supplied,
    taskLineage: recovered.artifacts,
    recoveryAuthorization: recovered.authorization,
    attempts: attemptStore(config),
    owner,
    stateDirectory: config.stateDirectory,
    originalTaskBindingBytes,
  };
}

export async function claimKnowledgeContinuation(
  loaded: LoadedKnowledgeContinuation,
  workspace: RepositoryWorkspace,
): Promise<
  | ClaimedKnowledgeContinuation
  | {
      disposition: "busy" | "already-completed" | "recovery-required";
      record?: RunRecord;
      completedAttempt?: KnowledgeContinuationAttemptV1;
    }
> {
  const identitySha256 = createHash("sha256").update(workspace.sourcePath).digest("hex");
  if (
    identitySha256 !== loaded.receipt.repositoryIdentitySha256 ||
    workspace.revision !== loaded.receipt.repositoryRevision
  )
    throw new KnowledgeContinuationError("binding-mismatch"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  const childRunId = `knowledge-continuation-${randomUUID()}`;
  const claim = await loaded.attempts.claim({
    originalRunId: loaded.receipt.originalRunId,
    snapshotSha256: loaded.snapshot.snapshotSha256,
    deliveryIntentSha256: loaded.privateTask.delivery.intentSha256,
    childRunId,
    owner: loaded.owner,
  });
  if (claim.disposition === "claimed") {
    try {
      await restoreOriginalTaskBinding(workspace.path, loaded.originalTaskBindingBytes.text);
    } catch (error) {
      await loaded.attempts.transition({
        originalRunId: loaded.receipt.originalRunId,
        attemptId: claim.attempt.attemptId,
        owner: loaded.owner,
        phase: "failed-before-execution",
      });
      throw error;
    }
    return {
      ...loaded,
      request: { ...loaded.request, runId: claim.attempt.childRunId },
      attempt: claim.attempt,
    };
  }
  if (claim.disposition === "already-completed") {
    if (
      claim.attempt.phase === "delivery-settled" &&
      !(await hasValidCompletedDeliveryEvidence(claim.attempt, loaded))
    )
      return { disposition: "recovery-required" };
    const persisted = await new FileRunStore(loaded.stateDirectory)
      .getWithDigest(claim.attempt.childRunId)
      .catch(() => undefined);
    const record = await decodeCompletedChild(
      persisted?.record,
      persisted?.sha256,
      claim.attempt,
      loaded,
    );
    return record
      ? { disposition: "already-completed", record, completedAttempt: claim.attempt }
      : { disposition: "recovery-required" };
  }
  return { disposition: claim.disposition };
}

async function hasValidCompletedDeliveryEvidence(
  attempt: KnowledgeContinuationAttemptV1,
  loaded: LoadedKnowledgeContinuation,
): Promise<boolean> {
  const result = attempt.deliveryResult;
  if (!result) return false;
  if (loaded.privateTask.delivery.mode === "patch-only") {
    return (
      result.locator === null &&
      result.publisherResultArtifactSha256 === null &&
      result.publisherIdempotencyKey === null
    );
  }
  if (
    result.locator === null ||
    result.publisherResultArtifactSha256 === null ||
    result.publisherIdempotencyKey === null
  )
    return false;
  try {
    const value = await new DurableArtifactStore(
      resolve(dirname(loaded.stateDirectory), "artifacts"),
    ).getRecord(result.publisherResultArtifactSha256);
    if (canonicalDigest(value) !== result.publisherResultArtifactSha256) return false;
    const publication = decodeLocalUserGitLabPublicationResult(value);
    return (
      publication.idempotencyKey === result.publisherIdempotencyKey &&
      publication.targetBranch === loaded.privateTask.delivery.targetBranch &&
      publication.mergeRequest.url === result.locator
    );
  } catch {
    return false;
  }
}

async function restoreOriginalTaskBinding(workspacePath: string, text: string): Promise<void> {
  let directory = workspacePath;
  for (const segment of [".docsfab", "reference-model"]) {
    directory = resolve(directory, segment);
    const existing = await lstat(directory).catch((error: unknown) =>
      isNodeError(error, "ENOENT") ? undefined : Promise.reject(error),
    );
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
      throw new KnowledgeContinuationError("binding-mismatch"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
    }
    if (!existing) await mkdir(directory, { mode: 0o700 });
  }
  const path = resolve(workspacePath, ORIGINAL_TASK_PATH);
  const existing = await lstat(path).catch((error: unknown) =>
    isNodeError(error, "ENOENT") ? undefined : Promise.reject(error),
  );
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || (await readFile(path, "utf8")) !== text)
      throw new KnowledgeContinuationError("binding-mismatch"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
    return;
  }
  await writeFile(path, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

async function decodeCompletedChild(
  value: unknown,
  persistedSha256: string | undefined,
  attempt: KnowledgeContinuationAttemptV1,
  loaded: LoadedKnowledgeContinuation,
): Promise<RunRecord | undefined> {
  try {
    const record = await decodePublicationEligibleChild(value, loaded.stateDirectory);
    if (record === undefined) return undefined;
    if (
      attempt.childRecordSha256 === null ||
      persistedSha256 !== attempt.childRecordSha256 ||
      record.id !== attempt.childRunId ||
      record.workflow !== loaded.receipt.workflow ||
      createHash("sha256").update(record.repository.sourcePath).digest("hex") !==
        loaded.receipt.repositoryIdentitySha256 ||
      record.repository.revision !== loaded.receipt.repositoryRevision ||
      record.taskLineage?.projectionSha256 !== loaded.receipt.taskLineageProjectionSha256 ||
      record.knowledgeContinuationReceipt?.receiptSha256 !== loaded.receipt.receiptSha256 ||
      record.knowledgeContinuationRecoveryAuthorization?.originalOriginSha256 !==
        loaded.privateTask.taskLineage.originSha256 ||
      record.knowledgeContinuationRecoveryAuthorization?.originalLineageSha256 !==
        loaded.privateTask.taskLineage.lineageSha256 ||
      record.knowledgeContinuationSnapshotSha256 !== attempt.snapshotSha256 ||
      record.knowledgeContinuationAcceptanceSha256 !==
        knowledgeContinuationAcceptanceSha256({
          receiptSha256: loaded.receipt.receiptSha256,
          recoveryAuthorizationSha256:
            record.knowledgeContinuationRecoveryAuthorization!.authorizationSha256,
          snapshotSha256: attempt.snapshotSha256,
          targetConflictReceiptSha256: loaded.receipt.targetConflictReceiptSha256,
        }) ||
      attempt.deliveryIntentSha256 !== loaded.privateTask.delivery.intentSha256
    )
      return undefined;
    return record;
  } catch {
    return undefined;
  }
}

async function decodePublicationEligibleChild(
  value: unknown,
  stateDirectory: string,
): Promise<RunRecord | undefined> {
  try {
    return decodeSuccessfulPublicationRunRecord(value);
  } catch {
    // V2 update children carry branch coverage and editorial decisions.
  }
  if (!value || typeof value !== "object") return undefined;
  try {
    const options = await loadSavedRunEditorialDecodeOptions(value as RunRecord, stateDirectory);
    return decodeSuccessfulPublicationRunRecord(value, options);
  } catch {
    return undefined;
  }
}
