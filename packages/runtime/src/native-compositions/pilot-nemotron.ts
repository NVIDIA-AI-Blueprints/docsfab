// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  canonicalDigest,
  canonicalJson,
  createHostAuthorityFactory,
  deepFreeze,
} from "../contract-kit/index.js";
import {
  decodeSuccessfulPublicationRunRecord,
  decodeSuccessfulPublicationRunRecordSnapshot,
  type PublicationRunRecordDecodeOptionsV1,
} from "../delivery/run-record.js";
import { emptyWriteResultError } from "../workflow-execution/runner-schedule.js";
import { LocalContextPreflightService } from "../context/index.js";
import { parseJsonEvidence } from "../json-evidence.js";
import { resolveInstalledComposition } from "../model-composition/installed.js";
import type { BoundInstalledComposition } from "../model-composition/types.js";
import type { RunRecord, TokenUsage, ToolActivitySummary } from "../records/contracts.js";
import {
  parseCompositionExecutionAggregate,
  parseCompositionExecutionEvidence,
  reconstructCompositionExecutionAggregateSnapshot,
} from "../records/composition-execution.js";
import {
  decodeAuthoringExecutionEvidenceV1,
  decodeRetainedAuthoringWorkflowV1,
  validateAuthoringRunRecordV1,
} from "../records/authoring-execution.js";
import {
  decodeContextPreflight,
  decodeInference,
  decodeModelEvidence,
  decodeQualityPackEvidence,
  decodeSkillEvidence,
  decodeTools,
  decodeUsage,
} from "../scorecard-record.js";
import { getWorkflow } from "../workflow-registry/catalog.js";
import { parseWorkflowManifestSnapshot } from "../workflow-registry/manifest.js";
import type { WorkflowDefinition } from "../workflow-contracts/contracts.js";
import { authoringSelectedPath } from "../workflow-contracts/authoring-schedule.js";
import { detectCredentialRuleIdsInValue } from "../security/repository-scanner.js";
import { authorizeSecurityScan } from "../security/scan-override.js";
import { resolveSecurityScanEffectiveDisposition } from "../security/scan-disposition.js";
import {
  NATIVE_PILOT_EVIDENCE_CLASS,
  NativePilotContractError,
  type NativePilotStepId,
} from "./pilot-contracts.js";
import { NATIVE_PILOT_CORPUS_PATHS } from "./pilot-corpus.js";
import { fail, NativePilotRunnerError } from "./pilot-runner-error.js";
import {
  SHA256,
  MAX_HOST_STDERR_BYTES,
  MAX_HOST_STDOUT_BYTES,
  assertNoSymlinkAncestors,
  assertRunnerNewWritePath,
  assertRunnerWritePath,
  decodeUtf8,
  compareText,
  ensureRunnerPrivateDirectory,
  enumeration,
  exactKeys,
  hostEnvironment,
  identifier,
  inside,
  nonnegativeInteger,
  pathExists,
  persistPrivateBytesSync,
  readBoundedRegularFile,
  readPrivateArtifact,
  runBoundedHostProcess,
  safeJoin,
  sha256,
  strictObject,
  strictUtf8,
} from "./pilot-paths.js";

import { gitChangedPaths, materializeRepository, snapshotRepository } from "./pilot-repository.js";
import type {
  AttemptPrivateState,
  NativePilotAttemptReceiptV1,
  NativePilotAttemptStatus,
  NativePilotFailureEvidenceV1,
  NativePilotFailurePhase,
  NativePilotNemotronImportAuthority,
  NativePilotRunner,
  NemotronImportState,
  PrivateArtifactLedgerEntry,
  RunnerState,
} from "./pilot-runner.js";
import {
  buildPrivateArtifactLedger,
  phaseForStep,
  registerAttempt,
  sealAttemptReceipt,
  zeroAggregateUsage,
} from "./pilot-attempt.js";

const SECURITY_SCAN_POLICY: PublicationRunRecordDecodeOptionsV1 = {
  authorizeSecurityScan,
  resolveSecurityScanEffectiveDisposition,
};

const nemotronImportAuthorities = createHostAuthorityFactory<
  "docsfab-native-pilot-nemotron-import-authority",
  NemotronImportState
>({
  kind: "docsfab-native-pilot-nemotron-import-authority",
  invalidMessage: "invalid-native-pilot-nemotron-import-verifier",
});

export async function importFreshNemotronAttempt(
  state: RunnerState,
  input: Parameters<NativePilotRunner["importFreshNemotronAttempt"]>[0],
): Promise<NativePilotAttemptReceiptV1> {
  const { attemptId, ...evidence } = input;
  const authority = await validateFreshNemotronEvidence(state, evidence);
  return await commitFreshNemotronAttempt(state, { attemptId, authority });
}

export async function validateFreshNemotronEvidence(
  state: RunnerState,
  input: Parameters<NativePilotRunner["validateFreshNemotronEvidence"]>[0],
): Promise<NativePilotNemotronImportAuthority> {
  if (state.evaluationOpened) fail("campaign-phase-invalid");
  const effectivePatchBytes = input.patchBytes?.byteLength === 0 ? null : input.patchBytes;
  for (const [kind, bytes] of [
    ["run-record", input.runRecordBytes],
    ["composition-evidence", input.compositionEvidenceBytes],
    ["aggregate", input.aggregateBytes],
    ["patch", input.patchBytes],
    ["document", input.documentBytes],
  ] as const) {
    if (bytes === null) continue;
    if (
      !Buffer.isBuffer(bytes) ||
      (bytes.byteLength < 1 && kind !== "patch") ||
      bytes.byteLength > 16 * 1024 * 1024 ||
      detectCredentialRuleIdsInValue(decodeUtf8(bytes)).length > 0
    ) {
      fail("pi-record-invalid");
    }
  }
  let record: RunRecord;
  let rawRecord: Record<string, unknown>;
  let executionEvidenceValue: unknown;
  let aggregateValue: unknown | null = null;
  try {
    rawRecord = strictObject(parseJsonEvidence(input.runRecordBytes));
    record = decodeNativePilotNemotronRunRecord(rawRecord, state.workflow, {
      id: "create-documentation",
      sourceSha256: state.corpus.bindings.workflowSha256,
    });
    executionEvidenceValue = parseJsonEvidence(input.compositionEvidenceBytes);
    if (input.aggregateBytes !== null) aggregateValue = parseJsonEvidence(input.aggregateBytes);
  } catch {
    fail("pi-record-invalid");
  }
  const executionEvidence = parseCompositionExecutionEvidence(executionEvidenceValue);
  const aggregate =
    aggregateValue === null ? null : parseCompositionExecutionAggregate(aggregateValue);
  if (
    !record.compositionExecution ||
    canonicalDigest(record.compositionExecution) !== canonicalDigest(executionEvidence) ||
    (aggregate === null) !== (record.compositionExecutionAggregate === undefined) ||
    (aggregate !== null &&
      canonicalDigest(record.compositionExecutionAggregate) !== canonicalDigest(aggregate))
  ) {
    fail("pi-record-invalid");
  }
  if (aggregate !== null) {
    let expectedAggregate: ReturnType<typeof reconstructCompositionExecutionAggregateSnapshot>;
    try {
      expectedAggregate = reconstructCompositionExecutionAggregateSnapshot({
        compositionExecution: executionEvidence,
        run: {
          ...record,
          compositionExecution: executionEvidence,
          compositionExecutionAggregate: aggregate,
        },
        workflow: state.workflow,
        workflowIdentity: {
          id: "create-documentation",
          sourceSha256: state.corpus.bindings.workflowSha256,
        },
      });
    } catch {
      fail("attempt-binding-mismatch");
    }
    if (canonicalDigest(expectedAggregate) !== canonicalDigest(aggregate)) {
      fail("attempt-binding-mismatch");
    }
  }
  const terminal = assertFreshNemotronRecord(state, record, executionEvidence, aggregate);
  assertNemotronArtifactSemantics(terminal, aggregate, executionEvidence, record, input);
  const runRecordSha256 = sha256(input.runRecordBytes);
  const validationKeySha256 = canonicalDigest({
    runRecordSha256,
    compositionEvidenceSha256: sha256(input.compositionEvidenceBytes),
    aggregateSha256: input.aggregateBytes === null ? null : sha256(input.aggregateBytes),
    patchSha256: effectivePatchBytes === null ? null : sha256(effectivePatchBytes),
    documentSha256: input.documentBytes === null ? null : sha256(input.documentBytes),
  });
  const attemptRoot = safeJoin(
    state.campaignRoot,
    `prevalidated-nemotron/${validationKeySha256}-${state.campaignNonceSha256.slice(0, 16)}`,
  );
  await assertRunnerNewWritePath(state, attemptRoot);
  await ensureRunnerPrivateDirectory(state, attemptRoot, true);
  const evidenceRoot = join(attemptRoot, "pi-evidence");
  await assertRunnerNewWritePath(state, evidenceRoot);
  await ensureRunnerPrivateDirectory(state, evidenceRoot, false);
  const evidenceFiles: Array<readonly [string, Buffer]> = [
    ["run-record.json", input.runRecordBytes],
    ["composition-evidence.json", input.compositionEvidenceBytes],
    ...(input.aggregateBytes === null ? [] : [["aggregate.json", input.aggregateBytes] as const]),
    ...(effectivePatchBytes === null ? [] : [["candidate.patch", effectivePatchBytes] as const]),
    ...(input.documentBytes === null ? [] : [["document.md", input.documentBytes] as const]),
  ];
  for (const [name, bytes] of evidenceFiles) {
    const path = join(evidenceRoot, name);
    await assertRunnerNewWritePath(state, path);
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    const retained = await readPrivateArtifact(path, 16 * 1024 * 1024);
    if (!retained.equals(bytes)) fail("artifact-binding-mismatch");
  }
  const repository = join(attemptRoot, "repository");
  await materializeRepository(state, repository);
  await validateNemotronContextBindings({
    state,
    record,
    terminal,
    attemptRoot,
    repository,
    evidenceRoot,
    patchBytes: effectivePatchBytes,
    documentBytes: input.documentBytes,
  });
  const stages = strictNemotronStages(
    record,
    executionEvidence.digests.requestPolicySha256,
    terminal.runtimeStatus,
  );
  const failedStep =
    terminal.failureCategory === "no-document-change"
      ? record.steps.find((step) => step.id === "write-documentation")!
      : terminal.status === "failed"
        ? record.steps.find((step) => step.status === "failed")!
        : null;
  const failedStepIndex = failedStep === null ? -1 : record.steps.indexOf(failedStep);
  const failedAttempt = failedStep?.inference?.attempts.at(-1);
  const piFailureEvidence: NativePilotFailureEvidenceV1 | null =
    failedStep === null
      ? null
      : {
          stepId: failedStep.id as NativePilotStepId,
          processStatus:
            terminal.failureCategory === "no-document-change"
              ? "pi-no-document-change"
              : "pi-terminal-record",
          sessionSha256: failedAttempt?.executionLease?.identitySha256 ?? null,
          usage: failedAttempt?.usage
            ? {
                input: failedAttempt.usage.input,
                output: failedAttempt.usage.output,
                cacheRead: failedAttempt.usage.cacheRead,
                cacheWrite: failedAttempt.usage.cacheWrite,
                reasoningOutput: 0,
                total: failedAttempt.usage.total,
              }
            : zeroAggregateUsage(),
          providerTurns: failedAttempt?.usage?.turns ?? 0,
          providerRequests: failedAttempt?.usage?.turns ?? 0,
          durationMs: failedAttempt?.durationMs ?? failedStep.durationMs ?? 0,
          stdoutBytes: 0,
          stderrBytes: 0,
          captureSha256: canonicalDigest({
            runRecordSha256,
            stepId: failedStep.id,
            stageReceiptSha256: stages.stepReceiptSha256s[failedStepIndex],
          }),
        };
  const receiptBody = {
    evidenceClass: NATIVE_PILOT_EVIDENCE_CLASS,
    executionEvidenceClass: state.executionEvidenceClass,
    campaignNonceSha256: state.campaignNonceSha256,
    fixtureSha256: state.corpus.fixtureSha256,
    compositionId: "nvidia-llama-3.3-nemotron-super-49b-v1.5-pi",
    harnessId: "pi",
    executionShape: "pi-governed-six-step",
    requestedModel: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
    observedModel: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
    status: terminal.status,
    failureCategory: terminal.failureCategory,
    failurePhase: terminal.failurePhase,
    failureEvidence: piFailureEvidence,
    stepReceiptSha256s: stages.stepReceiptSha256s,
    nativeCaptureSha256s: piFailureEvidence ? [piFailureEvidence.captureSha256] : [],
    authorExecutionIdentitySha256s: stages.executionIdentitySha256s,
    documentSha256: input.documentBytes === null ? null : sha256(input.documentBytes),
    patchSha256: effectivePatchBytes === null ? null : sha256(effectivePatchBytes),
    runRecordSha256,
    compositionEvidenceSha256: executionEvidence.evidenceSha256,
    aggregateSha256: aggregate?.aggregateSha256 ?? null,
    usage: {
      input: terminal.usage.input,
      output: terminal.usage.output,
      cacheRead: terminal.usage.cacheRead,
      cacheWrite: terminal.usage.cacheWrite,
      reasoningOutput: 0,
      total: terminal.usage.total,
    },
    providerTurns: terminal.usage.turns,
    providerRequests: terminal.usage.turns,
    durationMs: record.durationMs ?? 0,
    technicalApproval: "not-established",
    roleQualification: "not-established",
    releaseEligible: false,
  } satisfies Omit<
    NativePilotAttemptReceiptV1,
    "schemaVersion" | "kind" | "receiptSha256" | "attemptId"
  >;
  const artifactLedger = await buildPrivateArtifactLedger(attemptRoot, repository);
  const repositorySha256 = (await snapshotRepository(repository)).sha256;
  const semanticRecordSha256 = canonicalDigest(record);
  const executionIdentitySha256 = canonicalDigest({
    compositionEvidenceSha256: executionEvidence.evidenceSha256,
    aggregateSha256: aggregate?.aggregateSha256 ?? null,
    stepReceiptSha256s: stages.stepReceiptSha256s,
    executionIdentitySha256s: stages.executionIdentitySha256s,
  });
  const stableExecutionReplayKeySha256 = canonicalDigest({
    fixtureSha256: state.corpus.fixtureSha256,
    compositionRunId: executionEvidence.runId,
    compositionEvidenceSha256: executionEvidence.evidenceSha256,
    executionIdentitySha256,
  });
  const replayKeySha256 = canonicalDigest({
    semanticRecordSha256,
    executionIdentitySha256,
    stableExecutionReplayKeySha256,
    fixtureSha256: state.corpus.fixtureSha256,
  });
  const attestationSha256 = canonicalDigest({
    campaignNonceSha256: state.campaignNonceSha256,
    replayKeySha256,
    compositionRunId: executionEvidence.runId,
    semanticRecordSha256,
    executionIdentitySha256,
    stableExecutionReplayKeySha256,
    receiptBody,
    repositorySha256,
    documentSha256: input.documentBytes === null ? null : sha256(input.documentBytes),
    artifactLedger,
  });
  const importState: NemotronImportState = {
    runner: state.runnerKey,
    compositionRunId: executionEvidence.runId,
    runRecordSha256,
    semanticRecordSha256,
    executionIdentitySha256,
    stableExecutionReplayKeySha256,
    replayKeySha256,
    receiptBody,
    repository,
    documentBytes: input.documentBytes === null ? null : Buffer.from(input.documentBytes),
    artifactLedger,
    repositorySha256,
    attestationSha256,
    consumed: false,
    verifyCurrent: () =>
      attestationSha256 ===
      canonicalDigest({
        campaignNonceSha256: state.campaignNonceSha256,
        replayKeySha256: importState.replayKeySha256,
        compositionRunId: importState.compositionRunId,
        semanticRecordSha256: importState.semanticRecordSha256,
        executionIdentitySha256: importState.executionIdentitySha256,
        stableExecutionReplayKeySha256: importState.stableExecutionReplayKeySha256,
        receiptBody: importState.receiptBody,
        repositorySha256: importState.repositorySha256,
        documentSha256:
          importState.documentBytes === null ? null : sha256(importState.documentBytes),
        artifactLedger: importState.artifactLedger,
      }),
  };
  return nemotronImportAuthorities.create(importState) as NativePilotNemotronImportAuthority;
}

export async function commitFreshNemotronAttempt(
  state: RunnerState,
  input: Parameters<NativePilotRunner["commitFreshNemotronAttempt"]>[0],
): Promise<NativePilotAttemptReceiptV1> {
  if (state.evaluationOpened) fail("campaign-phase-invalid");
  if (state.nemotronCommitmentSha256 !== null) fail("attempt-replay");
  const prepared = nemotronImportAuthorities.lookup(input.authority);
  if (!prepared?.verifyCurrent() || prepared.runner !== state.runnerKey || prepared.consumed) {
    fail("attempt-replay");
  }
  await reattestNemotronImport(state, prepared);
  const attemptId = identifier(input.attemptId);
  if (state.attemptIds.has(attemptId)) fail("attempt-replay");
  await reserveDurableReplayMarkers(state, [
    {
      name: `campaign-nonce-${state.campaignNonceSha256}.json`,
      body: {
        schemaVersion: 1,
        kind: "docsfab-native-pilot-campaign-nonce-marker",
        campaignNonceSha256: state.campaignNonceSha256,
        fixtureSha256: state.corpus.fixtureSha256,
      },
    },
    {
      name: `nemotron-execution-${prepared.stableExecutionReplayKeySha256}.json`,
      body: {
        schemaVersion: 1,
        kind: "docsfab-native-pilot-nemotron-execution-marker",
        stableExecutionReplayKeySha256: prepared.stableExecutionReplayKeySha256,
        compositionRunIdSha256: sha256(Buffer.from(prepared.compositionRunId, "utf8")),
        executionIdentitySha256: prepared.executionIdentitySha256,
        fixtureSha256: state.corpus.fixtureSha256,
      },
    },
    {
      name: `nemotron-record-${prepared.replayKeySha256}.json`,
      body: {
        schemaVersion: 1,
        kind: "docsfab-native-pilot-nemotron-replay-marker",
        replayKeySha256: prepared.replayKeySha256,
        semanticRecordSha256: prepared.semanticRecordSha256,
        executionIdentitySha256: prepared.executionIdentitySha256,
        fixtureSha256: state.corpus.fixtureSha256,
        campaignNonceSha256: state.campaignNonceSha256,
      },
    },
  ]);
  prepared.consumed = true;
  state.attemptIds.add(attemptId);
  const receipt = sealAttemptReceipt({ ...prepared.receiptBody, attemptId });
  const registered = await registerAttempt(
    state,
    receipt,
    prepared.repository,
    prepared.documentBytes,
    dirname(prepared.repository),
  );
  state.nemotronCommitmentSha256 = registered.receiptSha256;
  return registered;
}

export async function reserveDurableReplayMarkers(
  state: RunnerState,
  specifications: readonly {
    readonly name: string;
    readonly body: Readonly<Record<string, unknown>>;
  }[],
): Promise<void> {
  if (
    specifications.length < 1 ||
    new Set(specifications.map((item) => item.name)).size !== specifications.length
  ) {
    fail("host-operation-failed");
  }
  const markers = specifications.map((specification) => {
    if (detectCredentialRuleIdsInValue(specification.body).length > 0) {
      fail("credential-material");
    }
    return {
      path: safeJoin(state.durableReplayRoot, specification.name),
      bytes: Buffer.from(`${JSON.stringify(specification.body, null, 2)}\n`, "utf8"),
    };
  });
  const lock = safeJoin(state.durableReplayRoot, ".reservation-lock");
  await assertRunnerWritePath(state, lock);
  let lockIdentity: { readonly dev: number; readonly ino: number } | null = null;
  try {
    await mkdir(lock, { mode: 0o700 });
    const metadata = await lstat(lock);
    lockIdentity = { dev: metadata.dev, ino: metadata.ino };
    const owner = typeof process.getuid === "function" ? process.getuid() : metadata.uid;
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      metadata.uid !== owner ||
      (metadata.mode & 0o077) !== 0
    ) {
      fail("host-operation-failed");
    }
  } catch (error) {
    if (lockIdentity !== null) await releaseDurableReplayLock(lock, lockIdentity);
    if (error instanceof NativePilotRunnerError) throw error;
    fail("host-operation-failed");
  }
  const created: Array<{
    readonly path: string;
    readonly bytes: Buffer;
    readonly dev: number;
    readonly ino: number;
  }> = [];
  try {
    for (const marker of markers) {
      await assertRunnerWritePath(state, marker.path);
      if (await pathExists(marker.path)) fail("replay-detected");
    }
    for (const marker of markers) {
      const handle = await open(
        marker.path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      try {
        const metadata = await handle.stat();
        created.push({ ...marker, dev: metadata.dev, ino: metadata.ino });
        await handle.writeFile(marker.bytes);
        await handle.sync();
        const settled = await handle.stat();
        if (settled.size !== marker.bytes.byteLength) fail("host-operation-failed");
      } finally {
        await handle.close();
      }
    }
  } catch (error) {
    await rollbackDurableReplayMarkers(created);
    if (error instanceof NativePilotRunnerError) throw error;
    if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("replay-detected");
    fail("host-operation-failed");
  } finally {
    await releaseDurableReplayLock(lock, lockIdentity);
  }
}

export async function rollbackDurableReplayMarkers(
  markers: readonly {
    readonly path: string;
    readonly bytes: Buffer;
    readonly dev: number;
    readonly ino: number;
  }[],
): Promise<void> {
  for (const marker of [...markers].reverse()) {
    try {
      const metadata = await lstat(marker.path);
      if (
        metadata.isSymbolicLink() ||
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        metadata.dev !== marker.dev ||
        metadata.ino !== marker.ino ||
        (metadata.mode & 0o777) !== 0o600
      ) {
        fail("host-operation-failed");
      }
      await unlink(marker.path);
    } catch (error) {
      if (error instanceof NativePilotRunnerError) throw error;
      fail("host-operation-failed");
    }
  }
}

export async function releaseDurableReplayLock(
  lock: string,
  identity: { readonly dev: number; readonly ino: number } | null,
): Promise<void> {
  if (identity === null) return;
  try {
    const metadata = await lstat(lock);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      metadata.dev !== identity.dev ||
      metadata.ino !== identity.ino ||
      (await readdir(lock)).length !== 0
    ) {
      fail("host-operation-failed");
    }
    await rmdir(lock);
  } catch (error) {
    if (error instanceof NativePilotRunnerError) throw error;
    fail("host-operation-failed");
  }
}

export async function reattestNemotronImport(
  state: RunnerState,
  prepared: NemotronImportState,
): Promise<void> {
  if (!prepared.verifyCurrent()) fail("re-attestation-failed");
  const repository = await snapshotRepository(prepared.repository);
  if (repository.sha256 !== prepared.repositorySha256) fail("re-attestation-failed");
  const observedArtifactLedger = await buildPrivateArtifactLedger(
    dirname(prepared.repository),
    prepared.repository,
  );
  if (canonicalDigest(observedArtifactLedger) !== canonicalDigest(prepared.artifactLedger)) {
    fail("re-attestation-failed");
  }
  if (prepared.documentBytes !== null) {
    const document = await readBoundedRegularFile(
      join(prepared.repository, state.corpus.allowedPage),
      state.corpus.limits.maxResponseBytes,
    );
    if (!document.equals(prepared.documentBytes)) fail("re-attestation-failed");
  }
}

export function decodeNativePilotNemotronRunRecord(
  value: unknown,
  workflow: WorkflowDefinition = getWorkflow("create-documentation"),
  workflowIdentity?: { readonly id: string; readonly sourceSha256: string },
  options: PublicationRunRecordDecodeOptionsV1 = SECURITY_SCAN_POLICY,
): RunRecord {
  try {
    return decodeTerminalNemotronRecord(strictObject(value), workflow, workflowIdentity, options);
  } catch (error) {
    if (error instanceof NativePilotRunnerError) throw error;
    fail("pi-record-invalid");
  }
}

/**
 * Run-record keys a terminal pilot record may carry.
 *
 * Exported so tests can assert the closed list directly: the private decoder
 * refuses a malformed record before the key check.
 */
export const NATIVE_PILOT_RUN_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "id",
  "workflow",
  "repository",
  "workspace",
  "instruction",
  "task",
  "status",
  "error",
  // A failed run's class, layer, and code.
  "failure",
  "createdAt",
  "startedAt",
  "completedAt",
  "durationMs",
  "models",
  "skills",
  "qualityPack",
  "usage",
  "tools",
  "artifacts",
  "securityScan",
  "securityScanEffectiveDisposition",
  "securityScanAuthorization",
  "changes",
  "impactPostflight",
  // Optional per-run citation evidence (absent until a writer exists).
  "sourceCitations",
  // Content-free credential-like content findings (#1807).
  "credentialFindings",
  "evidenceWarnings",
  "workflowOutcome",
  "searchFindings",
  "negativeEvidence",
  "gapLedger",
  "taskLineage",
  "compositionExecution",
  "compositionExecutionAggregate",
  "modelSettings",
  "authoringExecution",
  "steps",
]);

export function decodeTerminalNemotronRecord(
  root: Record<string, unknown>,
  workflow: WorkflowDefinition,
  workflowIdentity?: { readonly id: string; readonly sourceSha256: string },
  options: PublicationRunRecordDecodeOptionsV1 = SECURITY_SCAN_POLICY,
): RunRecord {
  if (root.status === "succeeded") {
    const record =
      workflowIdentity === undefined
        ? decodeSuccessfulPublicationRunRecord(root, options)
        : decodeSuccessfulPublicationRunRecordSnapshot(
            root,
            { workflow, workflowIdentity },
            options,
          );
    if (record.authoringExecution !== undefined) {
      if (workflow.schemaVersion !== 3) fail("pi-record-invalid");
      validateAuthoringRunRecordV1(record, workflow, { requireTerminalSuccess: true });
    }
    return record;
  }
  const allowed = NATIVE_PILOT_RUN_KEYS;
  const hasAuthoringExecution = root.authoringExecution !== undefined;
  const suppliedAuthoringSchedule =
    workflow.schemaVersion === 3 ? workflow.authoringSchedule : undefined;
  if (hasAuthoringExecution && !suppliedAuthoringSchedule) {
    fail("pi-record-invalid");
  }
  const retainedAuthoringWorkflow = hasAuthoringExecution
    ? decodeRetainedAuthoringWorkflowV1(root.authoringExecution)
    : null;
  const retainedAuthoringExecution = retainedAuthoringWorkflow
    ? decodeAuthoringExecutionEvidenceV1(root.authoringExecution, workflow)
    : null;
  const retainedAuthoringSchedule = retainedAuthoringWorkflow?.authoringSchedule;
  if (
    retainedAuthoringWorkflow &&
    (!retainedAuthoringSchedule ||
      !suppliedAuthoringSchedule ||
      canonicalDigest(retainedAuthoringSchedule.manifest) !==
        canonicalDigest(suppliedAuthoringSchedule.manifest))
  ) {
    fail("pi-record-invalid");
  }
  const terminalWorkflow = retainedAuthoringExecution?.selection?.branchId
    ? authoringSelectedPath(workflow, retainedAuthoringExecution.selection.branchId)
    : (suppliedAuthoringSchedule?.prefix ?? null);
  const requiredSteps = terminalWorkflow?.steps ?? workflow.steps;
  if (
    Object.keys(root).some((key) => !allowed.has(key)) ||
    root.schemaVersion !== 2 ||
    root.workflow !== "create-documentation" ||
    !["succeeded", "failed"].includes(String(root.status)) ||
    typeof root.id !== "string" ||
    typeof root.instruction !== "string" ||
    (root.error !== undefined && (typeof root.error !== "string" || root.error.length < 1)) ||
    !Array.isArray(root.steps) ||
    root.steps.length !== requiredSteps.length ||
    root.compositionExecution === undefined ||
    (workflow.schemaVersion === 3 && retainedAuthoringExecution === null) ||
    (root.status === "succeeded"
      ? root.error !== undefined || root.compositionExecutionAggregate === undefined
      : root.compositionExecutionAggregate !== undefined)
  ) {
    fail("pi-record-invalid");
  }
  const createdAt = decodeNemotronRunTimestamp(root.createdAt);
  const startedAt = decodeNemotronRunTimestamp(root.startedAt);
  const completedAt = decodeNemotronRunTimestamp(root.completedAt);
  if (
    !Number.isSafeInteger(root.durationMs) ||
    Number(root.durationMs) < 0 ||
    Date.parse(createdAt) > Date.parse(startedAt) ||
    Date.parse(startedAt) > Date.parse(completedAt) ||
    root.durationMs !== Date.parse(completedAt) - Date.parse(startedAt)
  ) {
    fail("pi-record-invalid");
  }
  const repository = strictObject(root.repository);
  const workspace = strictObject(root.workspace);
  if (
    repository.revision === undefined ||
    workspace.strategy !== "tracked-export" ||
    workspace.disposable !== true
  ) {
    fail("pi-record-invalid");
  }
  if (!Array.isArray(root.models) || !Array.isArray(root.skills)) fail("pi-record-invalid");
  root.models.map(decodeModelEvidence);
  root.skills.map(decodeSkillEvidence);
  decodeUsage(root.usage);
  decodeTools(root.tools);
  if (root.qualityPack !== undefined) decodeQualityPackEvidence(root.qualityPack);
  const steps = root.steps.map((value, index) => {
    const step = strictObject(value);
    const definition = requiredSteps[index];
    if (
      step.id !== definition?.id ||
      !definition ||
      step.skill !== definition.skill ||
      step.mode !== definition.mode ||
      step.kind !== (definition.kind ?? "inference") ||
      !["succeeded", "failed", "pending"].includes(String(step.status))
    ) {
      fail("step-set-mismatch");
    }
    if (step.status === "pending") {
      const pendingAllowed = new Set([
        "id",
        "title",
        "kind",
        "operation",
        "skill",
        "mode",
        "status",
        "contextPreflight",
      ]);
      if (
        Object.keys(step).some((key) => !pendingAllowed.has(key)) ||
        strictObject(step.contextPreflight).status !== "unnecessary"
      ) {
        fail("step-set-mismatch");
      }
      decodeContextPreflight(step.contextPreflight);
      return step;
    }
    decodeContextPreflight(step.contextPreflight);
    decodeSkillEvidence(step.skillEvidence);
    if (step.kind === "host-operation") {
      if (step.model !== undefined || step.inference !== undefined) fail("step-set-mismatch");
      if (step.usage !== undefined) {
        decodeUsage(step.usage);
        const usage = step.usage as TokenUsage;
        if (
          usage.input !== 0 ||
          usage.output !== 0 ||
          usage.cacheRead !== 0 ||
          usage.cacheWrite !== 0 ||
          usage.total !== 0 ||
          usage.turns !== 0 ||
          (usage.cost !== undefined && usage.cost !== 0)
        ) {
          fail("model-identity-mismatch");
        }
      }
      if (step.tools !== undefined) {
        decodeTools(step.tools);
        const tools = step.tools as ToolActivitySummary;
        if (
          tools.totalCalls !== 0 ||
          tools.failedCalls !== 0 ||
          tools.byTool.length !== 0 ||
          (tools.failureCategories?.length ?? 0) !== 0
        ) {
          fail("model-identity-mismatch");
        }
      }
    } else {
      decodeModelEvidence(step.model);
      decodeUsage(step.usage);
      decodeTools(step.tools);
    }
    if (step.kind !== "host-operation" && definition.mode === "write") {
      if (step.status === "succeeded") {
        decodeInference(step.inference, "disabled-write-step");
      } else {
        decodeFailedWriteInference(step.inference);
      }
    } else if (step.kind !== "host-operation") {
      decodeInference(step.inference, "read-only");
    }
    return step;
  });
  const failed = steps
    .map((step, index) => (step.status === "failed" ? index : -1))
    .filter((x) => x >= 0);
  // A failed record has two legal shapes: aborted at a step (one failed step,
  // earlier steps `succeeded`, later steps `pending`), or a finalize-time
  // failure (every step `succeeded`, failure recorded at run level because the
  // finalized result was rejected).
  const finalizeFailure = isFinalizeTimeFailure({
    status: String(root.status),
    error: root.error,
    steps: steps.map((step) => ({ status: String(step.status) })),
  });
  if (
    (root.status === "succeeded" &&
      (failed.length !== 0 || steps.some((step) => step.status !== "succeeded"))) ||
    (root.status === "failed" &&
      !finalizeFailure &&
      (failed.length !== 1 ||
        steps.slice(0, failed[0]).some((step) => step.status !== "succeeded") ||
        steps.slice(failed[0]! + 1).some((step) => step.status !== "pending") ||
        (typeof root.error !== "string" && typeof steps[failed[0]!]?.error !== "string")))
  ) {
    fail("step-set-mismatch");
  }
  const record = structuredClone(root) as unknown as RunRecord;
  if (retainedAuthoringWorkflow && retainedAuthoringExecution) {
    validateAuthoringRunRecordV1(record, workflow);
  }
  return record;
}

export function decodeNemotronRunTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    fail("pi-record-invalid");
  }
  return value;
}

export function decodeFailedWriteInference(value: unknown): void {
  const inference = strictObject(value);
  if (inference.replay !== "disabled-write-step") fail("pi-record-invalid");
  decodeInference({ ...structuredClone(inference), replay: "read-only" }, "read-only");
}

export function assertFreshNemotronRecord(
  state: RunnerState,
  record: RunRecord,
  executionEvidence: ReturnType<typeof parseCompositionExecutionEvidence>,
  aggregate: ReturnType<typeof parseCompositionExecutionAggregate> | null,
): {
  readonly runtimeStatus: "succeeded" | "failed";
  readonly status: NativePilotAttemptStatus;
  readonly failureCategory: string | null;
  readonly failurePhase: NativePilotFailurePhase | null;
  readonly usage: TokenUsage;
} {
  // This import validates an already-completed run against the authenticated
  // historical subject retained with the frozen corpus. It never resolves that
  // retired subject through the current executable composition authority.
  const subject = state.corpus.compositionSubject;
  const compositionSubjectProjection = {
    compositionId: executionEvidence.compositionId,
    model: executionEvidence.model,
    deployment: executionEvidence.deployment,
    authentication: executionEvidence.authentication,
    harness: executionEvidence.harness,
    adapters: executionEvidence.adapters,
    digests: executionEvidence.digests,
    limits: {
      candidate: executionEvidence.limits.candidate,
      composition: executionEvidence.limits.composition,
      package: executionEvidence.limits.package,
    },
    limitations: executionEvidence.limitations,
    technicalApproval: executionEvidence.technicalApproval,
    roleQualification: executionEvidence.roleQualification,
    releaseEligible: executionEvidence.releaseEligible,
  };
  const expectedSubjectProjection = {
    compositionId: subject.compositionId,
    model: subject.model,
    deployment: subject.deployment,
    authentication: subject.authentication,
    harness: subject.harness,
    adapters: subject.adapters,
    digests: subject.digests,
    limits: subject.limits,
    limitations: subject.limitations,
    technicalApproval: subject.technicalApproval,
    roleQualification: subject.roleQualification,
    releaseEligible: subject.releaseEligible,
  };
  const expectedLimits = {
    contextWindow: state.corpus.limits.contextWindow,
    maxInputTokens: state.corpus.limits.maxInputTokens,
    maxOutputTokens: state.corpus.limits.maxOutputTokens,
    maxProviderTurns: state.corpus.limits.maxProviderTurnsPerStep,
    timeoutMs: state.corpus.limits.timeoutMs,
    maxResponseBytes: state.corpus.limits.maxResponseBytes,
  };
  if (
    !["succeeded", "failed"].includes(record.status) ||
    record.id !== executionEvidence.runId ||
    record.workflow !== "create-documentation" ||
    record.repository.revision !== state.corpus.repositoryRevision ||
    canonicalDigest(compositionSubjectProjection) !== canonicalDigest(expectedSubjectProjection) ||
    executionEvidence.workflow.id !== "create-documentation" ||
    executionEvidence.workflow.sourceSha256 !== state.corpus.bindings.workflowSha256 ||
    executionEvidence.repository.revision !== state.corpus.repositoryRevision ||
    executionEvidence.digests.workflowSha256 !== state.corpus.bindings.workflowSha256 ||
    record.qualityPack?.manifestSha256 !== state.corpus.bindings.qualityPackSha256 ||
    record.qualityPack?.bindingSha256 !== state.corpus.bindings.qualityPackBindingSha256 ||
    executionEvidence.technicalApproval !== "not-established" ||
    executionEvidence.releaseEligible !== false ||
    (aggregate !== null &&
      (aggregate.workflow.sourceSha256 !== state.corpus.bindings.workflowSha256 ||
        aggregate.repository.revision !== state.corpus.repositoryRevision)) ||
    record.steps.length !== state.workflow.steps.length
  ) {
    fail("attempt-binding-mismatch");
  }
  // Checked after the identity/digest block so identity failures keep
  // precedence. A record is admissible to the comparison corpus only if it was
  // produced under the corpus's frozen envelope; the host's operational
  // limits are not required to equal it. The code names the
  // six-field envelope, not the individual field.
  if (canonicalDigest(executionEvidence.limits.effective) !== canonicalDigest(expectedLimits)) {
    fail("corpus-binding-mismatch");
  }
  if (
    typeof record.instruction !== "string" ||
    record.instruction.trimEnd() !== state.instruction.trimEnd()
  ) {
    fail("attempt-binding-mismatch");
  }
  const failedIndexes = record.steps
    .map((step, index) => (step.status === "failed" ? index : -1))
    .filter((index) => index >= 0);
  const finalizeFailure = isFinalizeTimeFailure(record);
  if (
    (record.status === "succeeded" &&
      (record.steps.length !== state.workflow.steps.length ||
        failedIndexes.length !== 0 ||
        aggregate === null ||
        aggregate.steps.length !== state.workflow.steps.length)) ||
    (record.status === "failed" &&
      !finalizeFailure &&
      (failedIndexes.length !== 1 ||
        record.steps.slice(0, failedIndexes[0]).some((step) => step.status !== "succeeded") ||
        record.steps.slice(failedIndexes[0]! + 1).some((step) => step.status !== "pending") ||
        aggregate !== null)) ||
    // A finalize-time failure ran every step, so it must carry the full step
    // set -- and no aggregate, which is written only for a succeeded run.
    (finalizeFailure && (record.steps.length !== state.workflow.steps.length || aggregate !== null))
  ) {
    fail("step-set-mismatch");
  }
  for (let index = 0; index < record.steps.length; index += 1) {
    const step = record.steps[index];
    const expectedId = state.workflow.steps[index]?.id;
    const expectedSkill = state.corpus.runtimeBindings.skills[index];
    // No step is pending in a finalize-time failure: they all ran.
    const pending = record.status === "failed" && !finalizeFailure && index > failedIndexes[0]!;
    if (pending) {
      if (
        !step ||
        step.id !== expectedId ||
        step.status !== "pending" ||
        !step.contextPreflight ||
        step.contextPreflight.status !== "unnecessary"
      ) {
        fail("step-set-mismatch");
      }
      continue;
    }
    if (
      !step ||
      step.id !== expectedId ||
      // A finalize-time failure ran every step, so every step is `succeeded`,
      // as in a succeeded run. The `failed` arm would demand a failed step that
      // does not exist.
      (record.status === "succeeded" || finalizeFailure
        ? step.status !== "succeeded"
        : index < failedIndexes[0]!
          ? step.status !== "succeeded"
          : step.status !== "failed") ||
      !expectedSkill ||
      step.skill !== expectedSkill.id ||
      !step.skillEvidence ||
      step.skillEvidence.contentSha256 !== expectedSkill.sha256 ||
      step.skillEvidence.bundleSha256 !== expectedSkill.bundleSha256 ||
      canonicalDigest(step.skillEvidence.toolPolicy) !== expectedSkill.toolPolicySha256 ||
      (aggregate !== null && aggregate.steps[index]?.id !== expectedId) ||
      !step.contextPreflight ||
      step.inference?.attempts.some(
        (attempt) =>
          !attempt.identity ||
          attempt.identity.repositoryRevision !== state.corpus.repositoryRevision,
      )
    ) {
      fail("step-set-mismatch");
    }
  }
  const usage = assertNemotronModelAndTotals(record, {
    provider: subject.deployment.routeId,
    model: subject.model.resolvedId,
  });
  // The runtime rejects an empty write result itself, so this record arrives
  // as a finalize-time failure, or as a runtime success in records produced
  // before that runtime guard existed. Both classify the same, and
  // `runtimeStatus` keeps them distinguishable.
  //
  // Selection requires the finalize-time shape AND the error string, and
  // rejects any finalize-time failure it cannot classify. An importer-controlled
  // free-text field must not be the sole discriminator on a governance path,
  // and the aborted-step tail below assumes a failed step exists.
  if (isFinalizeTimeFailure(record)) {
    if (record.error !== emptyWriteResultError || !isNemotronNoDocumentChange(record)) {
      fail("step-set-mismatch");
    }
    return {
      runtimeStatus: "failed",
      status: "failed",
      failureCategory: "no-document-change",
      failurePhase: "after-write",
      usage,
    };
  }
  if (record.status === "succeeded") {
    if (isNemotronNoDocumentChange(record)) {
      return {
        runtimeStatus: "succeeded",
        status: "failed",
        failureCategory: "no-document-change",
        failurePhase: "after-write",
        usage,
      };
    }
    return {
      runtimeStatus: "succeeded",
      status: "succeeded",
      failureCategory: null,
      failurePhase: null,
      usage,
    };
  }
  const failedIndex = failedIndexes[0]!;
  const failedStep = record.steps[failedIndex]!;
  const category =
    failedStep.inference?.attempts.at(-1)?.outcome ??
    (typeof failedStep.error === "string" ? "provider-failed" : "process-failed");
  return {
    runtimeStatus: "failed",
    status: "failed",
    failureCategory: category,
    failurePhase: phaseForStep(failedIndex),
    usage,
  };
}

/**
 * A failed run in which every step ran to completion and the failure was
 * recorded at finalization. Both shape checks share it so they state one
 * invariant.
 */
export function isFinalizeTimeFailure(record: {
  status: string;
  error?: unknown;
  steps: readonly { status: string }[];
}): boolean {
  return (
    record.status === "failed" &&
    typeof record.error === "string" &&
    record.steps.length > 0 &&
    record.steps.every((step) => step.status === "succeeded")
  );
}

export function isNemotronNoDocumentChange(record: RunRecord): boolean {
  const changes = record.changes;
  const patch = changes?.patch;
  const emptyPatch =
    patch === undefined ||
    (patch.byteLength === 0 && patch.lineCount === 0 && patch.sha256 === sha256(Buffer.alloc(0)));
  const writeStep = record.steps.find((step) => step.id === "write-documentation");
  if (
    !changes ||
    changes.files.length !== 0 ||
    !emptyPatch ||
    !writeStep ||
    writeStep.status !== "succeeded" ||
    !writeStep.inference
  ) {
    return false;
  }
  return true;
}

export function assertNemotronModelAndTotals(
  record: RunRecord,
  expected: { readonly provider: string; readonly model: string },
): TokenUsage {
  const selected = record.models[0];
  if (
    record.models.length !== 1 ||
    !selected ||
    selected.provider !== expected.provider ||
    selected.model !== expected.model
  ) {
    fail("model-identity-mismatch");
  }
  const selectedSha256 = canonicalDigest(selected);
  const usage: TokenUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    turns: 0,
  };
  let observedCost = false;
  const toolsByName = new Map<string, { calls: number; failures: number }>();
  const failureCategories = new Map<string, number>();
  let totalCalls = 0;
  let failedCalls = 0;
  for (const step of record.steps) {
    if (step.status === "pending") continue;
    if (step.kind === "host-operation") continue;
    if (!step.model || canonicalDigest(step.model) !== selectedSha256 || !step.inference) {
      fail("model-identity-mismatch");
    }
    const stepUsage: TokenUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      turns: 0,
    };
    let stepObservedCost = false;
    const stepToolsByName = new Map<string, { calls: number; failures: number }>();
    const stepFailureCategories = new Map<string, number>();
    let stepTotalCalls = 0;
    let stepFailedCalls = 0;
    for (const attempt of step.inference.attempts) {
      if (!attempt.model || canonicalDigest(attempt.model) !== selectedSha256) {
        fail("model-identity-mismatch");
      }
      if (attempt.usage) {
        stepUsage.input += attempt.usage.input;
        stepUsage.output += attempt.usage.output;
        stepUsage.cacheRead += attempt.usage.cacheRead;
        stepUsage.cacheWrite += attempt.usage.cacheWrite;
        stepUsage.total += attempt.usage.total;
        stepUsage.turns += attempt.usage.turns;
        if (attempt.usage.cost !== undefined) {
          stepUsage.cost = (stepUsage.cost ?? 0) + attempt.usage.cost;
          stepObservedCost = true;
        }
      }
      const attemptTools = attempt.tools;
      if (!attemptTools) fail("pi-record-invalid");
      stepTotalCalls += attemptTools.totalCalls;
      stepFailedCalls += attemptTools.failedCalls;
      for (const tool of attemptTools.byTool) {
        const total = stepToolsByName.get(tool.name) ?? { calls: 0, failures: 0 };
        total.calls += tool.calls;
        total.failures += tool.failures;
        stepToolsByName.set(tool.name, total);
      }
      for (const category of attemptTools.failureCategories ?? []) {
        stepFailureCategories.set(
          category.category,
          (stepFailureCategories.get(category.category) ?? 0) + category.count,
        );
      }
    }
    if (!stepObservedCost) delete stepUsage.cost;
    const stepTools = normalizeToolTotals({
      totalCalls: stepTotalCalls,
      failedCalls: stepFailedCalls,
      byTool: [...stepToolsByName.entries()].map(([name, total]) => ({ name, ...total })),
      failureCategories: [...stepFailureCategories.entries()].map(([category, count]) => ({
        category: category as NonNullable<
          ToolActivitySummary["failureCategories"]
        >[number]["category"],
        count,
      })),
    });
    if (
      !step.usage ||
      !step.tools ||
      canonicalDigest(stepUsage) !== canonicalDigest(step.usage) ||
      canonicalDigest(stepTools) !== canonicalDigest(normalizeToolTotals(step.tools))
    ) {
      fail("attempt-binding-mismatch");
    }
    usage.input += stepUsage.input;
    usage.output += stepUsage.output;
    usage.cacheRead += stepUsage.cacheRead;
    usage.cacheWrite += stepUsage.cacheWrite;
    usage.total += stepUsage.total;
    usage.turns += stepUsage.turns;
    if (stepUsage.cost !== undefined) {
      usage.cost = (usage.cost ?? 0) + stepUsage.cost;
      observedCost = true;
    }
    totalCalls += stepTools.totalCalls;
    failedCalls += stepTools.failedCalls;
    for (const tool of stepTools.byTool) {
      const total = toolsByName.get(tool.name) ?? { calls: 0, failures: 0 };
      total.calls += tool.calls;
      total.failures += tool.failures;
      toolsByName.set(tool.name, total);
    }
    for (const category of stepTools.failureCategories ?? []) {
      failureCategories.set(
        category.category,
        (failureCategories.get(category.category) ?? 0) + category.count,
      );
    }
  }
  if (!observedCost) delete usage.cost;
  const recomputedTools = normalizeToolTotals({
    totalCalls,
    failedCalls,
    byTool: [...toolsByName.entries()]
      .map(([name, total]) => ({ name, ...total }))
      .sort((left, right) => compareText(left.name, right.name)),
    failureCategories: [...failureCategories.entries()]
      .map(([category, count]) => ({
        category: category as NonNullable<
          ToolActivitySummary["failureCategories"]
        >[number]["category"],
        count,
      }))
      .sort((left, right) => compareText(left.category, right.category)),
  });
  if (
    canonicalDigest(usage) !== canonicalDigest(record.usage) ||
    canonicalDigest(recomputedTools) !== canonicalDigest(normalizeToolTotals(record.tools))
  ) {
    fail("attempt-binding-mismatch");
  }
  return usage;
}

export function normalizeToolTotals(value: ToolActivitySummary): ToolActivitySummary {
  return {
    totalCalls: value.totalCalls,
    failedCalls: value.failedCalls,
    byTool: [...value.byTool].sort((left, right) => compareText(left.name, right.name)),
    failureCategories: [...(value.failureCategories ?? [])].sort((left, right) =>
      compareText(left.category, right.category),
    ),
  };
}

export function assertNemotronArtifactSemantics(
  terminal: {
    readonly runtimeStatus: RunRecord["status"];
    readonly status: NativePilotAttemptStatus;
    readonly failureCategory: string | null;
    readonly failurePhase: NativePilotFailurePhase | null;
  },
  aggregate: ReturnType<typeof parseCompositionExecutionAggregate> | null,
  executionEvidence: ReturnType<typeof parseCompositionExecutionEvidence>,
  record: RunRecord,
  input: Parameters<NativePilotRunner["validateFreshNemotronEvidence"]>[0],
): void {
  if (terminal.failureCategory === "no-document-change") {
    // Artifact expectations that hold however the record was produced: no
    // document, and either no patch or an empty one.
    if (
      input.documentBytes !== null ||
      (input.patchBytes !== null && input.patchBytes.byteLength !== 0)
    ) {
      fail("artifact-binding-mismatch");
    }
    // The aggregate is written only for a `succeeded` run
    // (workflow-execution/runner.ts), so a runtime-rejected empty write has no
    // aggregate and no aggregate bytes; otherwise the aggregate must be present
    // and bound. No test reaches this branch or its sibling in
    // `assertFreshNemotronRecord`: the fixture derives `aggregateBytes` from run
    // status and cannot pair a finalize failure with a valid aggregate.
    if (terminal.runtimeStatus === "failed") {
      if (aggregate !== null || input.aggregateBytes !== null) {
        fail("artifact-binding-mismatch");
      }
      return;
    }
    if (
      aggregate === null ||
      input.aggregateBytes === null ||
      aggregate.compositionEvidenceSha256 !== executionEvidence.evidenceSha256
    ) {
      fail("artifact-binding-mismatch");
    }
    return;
  }
  if (terminal.status === "succeeded") {
    if (
      aggregate === null ||
      input.aggregateBytes === null ||
      input.patchBytes === null ||
      input.documentBytes === null ||
      aggregate.result.patchSha256 !== sha256(input.patchBytes) ||
      record.changes?.patch?.sha256 !== sha256(input.patchBytes) ||
      aggregate.compositionEvidenceSha256 !== executionEvidence.evidenceSha256
    ) {
      fail("artifact-binding-mismatch");
    }
    return;
  }
  if (input.aggregateBytes !== null || aggregate !== null) fail("artifact-binding-mismatch");
  if (input.patchBytes !== null && record.changes?.patch?.sha256 !== sha256(input.patchBytes)) {
    fail("artifact-binding-mismatch");
  }
  if (
    terminal.failurePhase === "before-write" &&
    (input.patchBytes !== null || input.documentBytes !== null)
  ) {
    fail("artifact-binding-mismatch");
  }
  if (terminal.failurePhase === "during-write" && input.documentBytes !== null) {
    fail("artifact-binding-mismatch");
  }
  if (
    terminal.failurePhase === "after-write" &&
    (input.patchBytes === null || input.documentBytes === null)
  ) {
    fail("artifact-binding-mismatch");
  }
}

export async function validateNemotronContextBindings(input: {
  readonly state: RunnerState;
  readonly record: RunRecord;
  readonly terminal: { readonly failureCategory: string | null };
  readonly attemptRoot: string;
  readonly repository: string;
  readonly evidenceRoot: string;
  readonly patchBytes: Buffer | null;
  readonly documentBytes: Buffer | null;
}): Promise<void> {
  const cacheRoot = join(input.attemptRoot, "context-cache");
  await assertRunnerNewWritePath(input.state, cacheRoot);
  await ensureRunnerPrivateDirectory(input.state, cacheRoot, false);
  const workflow = input.state.workflow;
  const executedSteps = input.record.steps.filter((step) => step.status !== "pending");
  const service = new LocalContextPreflightService({ cacheRoot });
  const expected: string[] = [];
  const recompute = async (index: number): Promise<void> => {
    const step = workflow.steps[index];
    const policy = workflow.contextPolicy.steps[index];
    if (!step || !policy || policy.stepId !== step.id || executedSteps[index]?.id !== step.id) {
      fail("context-binding-mismatch");
    }
    const result = await service.preflight({
      runId: input.record.id,
      repository: input.record.repository,
      workspacePath: input.repository,
      workflow,
      step,
      policy,
    });
    if (
      (result.status !== "ready" && result.status !== "degraded") ||
      typeof result.packetDigest !== "string" ||
      !SHA256.test(result.packetDigest) ||
      result.packet?.digest !== result.packetDigest
    ) {
      fail("context-binding-mismatch");
    }
    expected.push(result.packetDigest);
  };
  try {
    const initialCount = Math.min(2, executedSteps.length);
    for (let index = 0; index < initialCount; index += 1) await recompute(index);
    if (executedSteps.length > 2) {
      if (input.patchBytes !== null && input.documentBytes !== null) {
        const patchPath = join(input.evidenceRoot, "candidate.patch");
        await assertRunnerWritePath(input.state, input.repository);
        await assertRunnerWritePath(
          input.state,
          join(input.repository, input.state.corpus.allowedPage),
        );
        await applyBoundPatch(input.repository, patchPath);
        const changedPaths = await gitChangedPaths(input.repository);
        if (changedPaths.length !== 1 || changedPaths[0] !== input.state.corpus.allowedPage) {
          fail("write-boundary-failed");
        }
        const materializedDocument = await readBoundedRegularFile(
          join(input.repository, input.state.corpus.allowedPage),
          input.state.corpus.limits.maxResponseBytes,
        );
        if (!materializedDocument.equals(input.documentBytes)) {
          fail("artifact-binding-mismatch");
        }
      } else if (input.terminal.failureCategory !== "no-document-change") {
        fail("artifact-binding-mismatch");
      }
      for (let index = 2; index < executedSteps.length; index += 1) await recompute(index);
    }
    for (let index = 0; index < executedSteps.length; index += 1) {
      const step = executedSteps[index]!;
      const digest = expected[index];
      if (
        !digest ||
        !step.contextPreflight ||
        !("packetDigest" in step.contextPreflight) ||
        step.contextPreflight.packetDigest !== digest ||
        (step.kind !== "host-operation" &&
          (!step.inference ||
            step.inference.attempts.some(
              (attempt) => !attempt.identity || attempt.identity.contextPacketDigest !== digest,
            )))
      ) {
        fail("context-binding-mismatch");
      }
    }
  } finally {
    try {
      await assertNoSymlinkAncestors(cacheRoot);
      const metadata = await lstat(cacheRoot);
      const owner = typeof process.getuid === "function" ? process.getuid() : metadata.uid;
      if (
        metadata.isSymbolicLink() ||
        !metadata.isDirectory() ||
        metadata.uid !== owner ||
        (metadata.mode & 0o077) !== 0
      ) {
        fail("host-operation-failed");
      }
      await rm(cacheRoot, { recursive: true });
    } catch {
      fail("host-operation-failed");
    }
  }
}

export function strictNemotronStages(
  record: RunRecord,
  requestPolicySha256: string | null,
  status: NativePilotAttemptStatus,
): {
  readonly stepReceiptSha256s: readonly string[];
  readonly executionIdentitySha256s: readonly string[];
} {
  if (!requestPolicySha256 || !SHA256.test(requestPolicySha256)) fail("pi-record-invalid");
  const stepReceiptSha256s: string[] = [];
  const executionIdentitySha256s: string[] = [];
  const failedStepIndex =
    status === "failed" ? record.steps.findIndex((step) => step.status === "failed") : -1;
  const executedStepCount = failedStepIndex < 0 ? record.steps.length : failedStepIndex + 1;
  for (let stepIndex = 0; stepIndex < executedStepCount; stepIndex += 1) {
    const step = record.steps[stepIndex]!;
    if (step.kind === "host-operation") {
      stepReceiptSha256s.push(
        canonicalDigest({ stepId: step.id, status: step.status, kind: step.kind }),
      );
      continue;
    }
    const inference = step.inference;
    if (
      !inference ||
      inference.configuredMaxRetries !== 0 ||
      inference.effectiveMaxRetries !== 0 ||
      inference.replay !==
        (step.id === "write-documentation" ? "disabled-write-step" : "read-only") ||
      inference.attempts.length !== 1
    ) {
      fail("pi-record-invalid");
    }
    const attempt = inference.attempts[0]!;
    const attemptTurns = attempt.turns ?? [];
    const terminalFailure = status === "failed" && stepIndex === failedStepIndex;
    if (
      (!terminalFailure && attempt.outcome !== "succeeded") ||
      (terminalFailure && attempt.outcome === "succeeded") ||
      (!terminalFailure && !attempt.executionLease) ||
      attemptTurns.length > 4
    ) {
      fail("pi-record-invalid");
    }
    const executionIdentitySha256 = attempt.executionLease?.identitySha256 ?? null;
    if (executionIdentitySha256 !== null && !SHA256.test(executionIdentitySha256)) {
      fail("pi-record-invalid");
    }
    const turns = attemptTurns.map((turn) => {
      const finalized = turn.providerPayloadSchemaVersion === 1;
      if (
        (!terminalFailure && !finalized) ||
        (finalized &&
          (turn.requestPolicySha256 !== requestPolicySha256 ||
            !turn.finalPayloadSha256 ||
            !SHA256.test(turn.finalPayloadSha256))) ||
        (!finalized &&
          (turn.requestPolicySha256 !== undefined || turn.finalPayloadSha256 !== undefined))
      ) {
        fail("pi-record-invalid");
      }
      return {
        turn: turn.turn,
        requestPolicySha256: turn.requestPolicySha256 ?? null,
        finalPayloadSha256: turn.finalPayloadSha256 ?? null,
      };
    });
    if (executionIdentitySha256 !== null) executionIdentitySha256s.push(executionIdentitySha256);
    stepReceiptSha256s.push(
      canonicalDigest({
        stepId: step.id,
        status: step.status,
        outcome: attempt.outcome,
        executionIdentitySha256,
        turns,
      }),
    );
  }
  if (new Set(executionIdentitySha256s).size !== executionIdentitySha256s.length) {
    fail("session-replay");
  }
  return { stepReceiptSha256s, executionIdentitySha256s };
}

export async function applyBoundPatch(repository: string, patchPath: string): Promise<void> {
  for (const argumentsValue of [
    ["apply", "--check", patchPath],
    ["apply", patchPath],
  ]) {
    const result = await runBoundedHostProcess({
      executablePath: "git",
      arguments: argumentsValue,
      workingDirectory: repository,
      environment: hostEnvironment(process.env),
      stdin: null,
      timeoutMs: 15_000,
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 64 * 1024,
    });
    if (result.exitCode !== 0 || result.stdout.byteLength !== 0 || result.stderr.byteLength !== 0) {
      fail("artifact-binding-mismatch");
    }
  }
}
