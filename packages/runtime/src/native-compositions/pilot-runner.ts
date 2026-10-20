// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  canonicalDigest,
  canonicalJson,
  createHostAuthorityFactory,
  deepFreeze,
} from "../contract-kit/index.js";
import { LocalContextPreflightService } from "../context/index.js";
import {
  decodeSuccessfulPublicationRunRecord,
  decodeSuccessfulPublicationRunRecordSnapshot,
} from "../delivery/run-record.js";
import { emptyWriteResultError } from "../workflow-execution/runner-schedule.js";
import { parseJsonEvidence } from "../json-evidence.js";
import {
  assertCompositionNotRetired,
  loadInstalledModelCompositionAuthority,
  resolveInstalledComposition,
} from "../model-composition/installed.js";
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
import { documentationAuditSearch } from "../maturity/audit-search-plan.js";
import { documentationObservationSearch } from "../search/observation-search-plan.js";
import {
  decodeContextPreflight,
  decodeInference,
  decodeModelEvidence,
  decodeQualityPackEvidence,
  decodeSkillEvidence,
  decodeTools,
  decodeUsage,
} from "../scorecard-record.js";
import { detectCredentialRuleIdsInValue } from "../security/repository-scanner.js";
import { getWorkflow } from "../workflow-registry/catalog.js";
import { parseWorkflowManifestSnapshot } from "../workflow-registry/manifest.js";
import type { WorkflowDefinition } from "../workflow-contracts/contracts.js";
import { authoringSelectedPath } from "../workflow-contracts/authoring-schedule.js";
import {
  createClaudeNativePreflightAdapter,
  createCodexNativePreflightAdapter,
  type NativeExecutableObservation,
  type NativePreflightHost,
} from "./adapters.js";
import {
  CLAUDE_PREFLIGHT_REPORTED_VERSION,
  CODEX_PREFLIGHT_REPORTED_VERSION,
  NATIVE_PREFLIGHT_INPUT_KIND,
  type NativeHarnessId,
  type NativePreflightInputV1,
  type NativePreflightObservationV1,
} from "./contracts.js";
import { createLocalNativePreflightHost, resolveLocalNativeExecutable } from "./local-host.js";
import {
  CODEX_NATIVE_PILOT_DISABLED_FEATURES,
  NATIVE_PILOT_SYSTEM_PROMPT_SHA256,
  buildCodexNativePilotStrictConfigProbeArguments,
  buildClaudeNativePilotInvocation,
  buildCodexNativePilotInvocation,
  decodeCodexNativePilotFeatureState,
  decodeNativePilotResult,
} from "./pilot-adapters.js";
import {
  NATIVE_PILOT_ADAPTER_VERSION,
  NATIVE_PILOT_EVIDENCE_CLASS,
  NATIVE_PILOT_MAXIMA,
  NATIVE_PILOT_STEP_IDS,
  NativePilotContractError,
  parseNativePilotStepReceiptV1,
  sealNativePilotStepPlanV1,
  type NativePilotFailureCode,
  type NativePilotEnvironmentV1,
  type NativePilotHarnessId,
  type NativePilotStepId,
  type NativePilotStepOutputV1,
  type NativePilotStepReceiptV1,
  type NativePilotUsageV1,
} from "./pilot-contracts.js";
import {
  NATIVE_PILOT_COMPOSITION_IDS,
  NATIVE_PILOT_CORPUS_PATHS,
  readInstalledNativePilotCorpusFile,
  resolveInstalledNativePilotCorpus,
  type BoundNativePilotCorpus,
  type InstalledNativePilotCorpusAuthority,
} from "./pilot-corpus.js";
import {
  runNativePilotProcess,
  type NativePilotProcessObservation,
  type NativePilotProcessRunner,
} from "./pilot-process.js";

import { fail } from "./pilot-runner-error.js";
import {
  assertRunnerNewWritePath,
  assertRunnerWritePath,
  ensureRunnerPrivateDirectory,
  identifier,
  locale,
  nonnegativeInteger,
  overlaps,
  pathExists,
  readBoundedRegularFile,
  readPrivateArtifact,
  requireCanonicalRoot,
  requireExecutablePath,
  requirePrivateRoot,
  runBoundedHostProcess,
  safeJoin,
  safeRelativePath,
  sha256,
  strictObject,
  strictUtf8,
  username,
  compareText,
  type NativePilotWriteBoundary,
} from "./pilot-paths.js";
import {
  atomicReplaceRegularFile,
  assertDirectoryEmpty,
  gitChangedPaths,
  gitPatch,
  materializeRepository,
  requirePrivateRepository,
  snapshotRepository,
  type RepositorySnapshot,
} from "./pilot-repository.js";
import {
  commitFreshNemotronAttempt,
  importFreshNemotronAttempt,
  validateFreshNemotronEvidence,
} from "./pilot-nemotron.js";
import {
  admitBlindRoleResult,
  assembleCrossHarnessPilotReport,
  nextBlindRolePacket,
  openBlindBatch,
} from "./pilot-blind-eval.js";
import {
  CROSS_HARNESS_PILOT_REPORT_KIND,
  NATIVE_PILOT_ATTEMPT_RECEIPT_KIND,
  NATIVE_PILOT_EVALUATION_ROLES,
} from "./pilot-runner-constants.js";
import { failureCode, phaseForStep, registerAttempt, sealAttemptReceipt } from "./pilot-attempt.js";
import {
  aggregateNativeUsage,
  persistFailedNativeCapture,
  persistNativeCapture,
} from "./pilot-capture.js";

export {
  NativePilotRunnerError,
  type NativePilotRunnerErrorCode,
} from "./pilot-runner-error.js";
export {
  decodeNativePilotNemotronRunRecord,
  NATIVE_PILOT_RUN_KEYS,
} from "./pilot-nemotron.js";
export {
  CROSS_HARNESS_PILOT_REPORT_KIND,
  NATIVE_PILOT_ATTEMPT_RECEIPT_KIND,
  NATIVE_PILOT_EVALUATION_ROLES,
  NATIVE_PILOT_ROLE_RESULT_KIND,
  ROUTING_CHECK_IDS,
} from "./pilot-runner-constants.js";
export {
  attemptAuthorities,
  buildPrivateArtifactLedger,
  failureCode,
  kit,
  phaseForStep,
  reattestAttempt,
  registerAttempt,
  sealAttemptReceipt,
  zeroAggregateUsage,
} from "./pilot-attempt.js";
export { verifyCopiedKit } from "./pilot-repository.js";

export type NativePilotCompositionId = (typeof NATIVE_PILOT_COMPOSITION_IDS)[number];
export type NativePilotEvaluationRole = (typeof NATIVE_PILOT_EVALUATION_ROLES)[number];
export type NativePilotAttemptStatus = "succeeded" | "failed";
export type NativePilotFailurePhase = "before-write" | "during-write" | "after-write";

class NativeStepFailure extends Error {
  public constructor(
    public readonly code: string,
    public readonly evidence: NativePilotFailureEvidenceV1,
  ) {
    super("Native pilot step failed with retained terminal evidence.");
    this.name = "NativeStepFailure";
  }
}

export interface NativePilotPreflightAuthority {
  readonly kind: "docsfab-native-pilot-preflight-authority";
}

export interface NativePilotNemotronImportAuthority {
  readonly kind: "docsfab-native-pilot-nemotron-import-authority";
}

export interface NativePilotFailureEvidenceV1 {
  readonly stepId: NativePilotStepId;
  readonly processStatus: string;
  readonly sessionSha256: string | null;
  readonly usage: NativePilotAggregateUsageV1;
  readonly providerTurns: number;
  readonly providerRequests: number;
  readonly durationMs: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly captureSha256: string;
}

export interface NativePilotAttemptReceiptV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof NATIVE_PILOT_ATTEMPT_RECEIPT_KIND;
  readonly evidenceClass: typeof NATIVE_PILOT_EVIDENCE_CLASS;
  readonly executionEvidenceClass: "live-observed" | "simulation-only";
  readonly campaignNonceSha256: string;
  readonly fixtureSha256: string;
  readonly attemptId: string;
  readonly compositionId: NativePilotCompositionId;
  readonly harnessId: "codex" | "claude-code" | "pi";
  readonly executionShape:
    | "codex-native-six-step"
    | "claude-code-native-six-step"
    | "pi-governed-six-step";
  readonly requestedModel: string;
  readonly observedModel: string | null;
  readonly status: NativePilotAttemptStatus;
  readonly failureCategory: string | null;
  readonly failurePhase: NativePilotFailurePhase | null;
  readonly failureEvidence: NativePilotFailureEvidenceV1 | null;
  readonly stepReceiptSha256s: readonly string[];
  readonly nativeCaptureSha256s: readonly string[];
  readonly authorExecutionIdentitySha256s: readonly string[];
  readonly documentSha256: string | null;
  readonly patchSha256: string | null;
  readonly runRecordSha256: string | null;
  readonly compositionEvidenceSha256: string | null;
  readonly aggregateSha256: string | null;
  readonly usage: NativePilotAggregateUsageV1;
  readonly providerTurns: number;
  readonly providerRequests: number;
  readonly durationMs: number;
  readonly technicalApproval: "not-established";
  readonly roleQualification: "not-established";
  readonly releaseEligible: false;
  readonly receiptSha256: string;
}

export interface NativePilotAggregateUsageV1 {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoningOutput: number;
  readonly total: number;
}

export interface NativePilotBlindRolePacket {
  readonly role: NativePilotEvaluationRole;
  readonly outputId: string;
  readonly fixtureSha256: string;
  readonly documentSha256: string;
  readonly evaluationContextSha256: string;
  readonly evidenceClass: "unattested-agent-proxy";
  readonly compositionVisible: false;
  readonly document: Buffer;
  readonly journeyEvidence: Buffer;
  readonly deterministicEvaluation: Buffer;
}

export interface NativePilotBlindRoleAuthority {
  readonly kind: "docsfab-native-pilot-blind-role-authority";
}

export interface NativePilotBlindBatchAuthority {
  readonly kind: "docsfab-native-pilot-blind-batch-authority";
}

export interface CrossHarnessPilotReportV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof CROSS_HARNESS_PILOT_REPORT_KIND;
  readonly evidenceClass: typeof NATIVE_PILOT_EVIDENCE_CLASS;
  readonly liveEvidenceEstablished: boolean;
  readonly commonEvaluationEstablished: false;
  readonly track: "cross-harness-composition-six-step";
  readonly fixtureSha256: string;
  readonly blindingSeedCommitmentSha256: string;
  readonly attemptSha256s: readonly string[];
  readonly evaluationSha256s: readonly string[];
  readonly reviewOrderSha256: string;
  readonly qualityComparisonStatus: "proxy-evaluation-incomplete";
  readonly comparisons: readonly {
    readonly compositionId: NativePilotCompositionId;
    readonly status: NativePilotAttemptStatus;
    readonly failureCategory: string | null;
    readonly taskGuideScore: number | null;
    readonly outputBarMet: boolean;
    readonly durationMs: number;
    readonly usage: NativePilotAggregateUsageV1;
    readonly providerTurns: number;
    readonly providerRequests: number;
  }[];
  readonly ranking: {
    readonly winnerCompositionId: null;
    readonly reason: "development-pilot-cannot-rank";
  };
  readonly technicalApproval: "not-established";
  readonly roleQualification: "not-established";
  readonly releaseEligible: false;
  readonly limitations: readonly string[];
  readonly reportSha256: string;
}

interface NativePilotRunnerBaseOptions {
  readonly corpusAuthority: InstalledNativePilotCorpusAuthority;
  readonly corpus: BoundNativePilotCorpus;
  readonly campaignRoot: string;
  readonly forbiddenRoots: readonly string[];
  readonly blindingSeed: Uint8Array;
  readonly campaignNonce: Uint8Array;
  readonly durableReplayRoot: string;
  readonly executablePaths: Readonly<Record<NativePilotHarnessId, string>>;
  readonly environment: NodeJS.ProcessEnv;
  readonly pythonExecutablePath: string;
}

export type NativePilotLiveRunnerOptions = NativePilotRunnerBaseOptions;

export interface NativePilotStrictConfigProbeObservation {
  readonly exitCode: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export interface NativePilotSimulationRunnerOptions extends NativePilotRunnerBaseOptions {
  readonly processRunner?: NativePilotProcessRunner;
  readonly preflightHost?: NativePreflightHost;
  readonly resolveExecutable?: (
    harnessId: NativeHarnessId,
    configuredPath: string | undefined,
  ) => Promise<string>;
  /** Provider-offline test seam for the exact raw `codex features list` capture. */
  readonly captureCodexFeatureState?: (
    executablePath: string,
    environment: Readonly<Record<string, string>>,
    workingDirectory: string,
  ) => Promise<Buffer>;
  /** Provider-offline seam; live runners always execute the parse-only strict-config probe. */
  readonly captureCodexStrictConfigProbe?: (
    executablePath: string,
    environment: Readonly<Record<string, string>>,
    workingDirectory: string,
    argumentsValue: readonly string[],
  ) => Promise<NativePilotStrictConfigProbeObservation>;
}

export interface NativePilotRunner {
  readonly fixtureSha256: string;
  readonly blindingSeedCommitmentSha256: string;
  readonly campaignNonceSha256: string;
  preflightNativeComposition(input: {
    readonly compositionId:
      | "openai-gpt-5.6-sol-codex-native-pilot"
      | "anthropic-claude-opus-4.7-claude-code-native-pilot";
  }): Promise<NativePilotPreflightAuthority>;
  runNativeAttempt(input: {
    readonly attemptId: string;
    readonly preflightAuthority: NativePilotPreflightAuthority;
  }): Promise<NativePilotAttemptReceiptV1>;
  importFreshNemotronAttempt(input: {
    readonly attemptId: string;
    readonly runRecordBytes: Buffer;
    readonly compositionEvidenceBytes: Buffer;
    readonly aggregateBytes: Buffer | null;
    readonly patchBytes: Buffer | null;
    readonly documentBytes: Buffer | null;
  }): Promise<NativePilotAttemptReceiptV1>;
  validateFreshNemotronEvidence(input: {
    readonly runRecordBytes: Buffer;
    readonly compositionEvidenceBytes: Buffer;
    readonly aggregateBytes: Buffer | null;
    readonly patchBytes: Buffer | null;
    readonly documentBytes: Buffer | null;
  }): Promise<NativePilotNemotronImportAuthority>;
  commitFreshNemotronAttempt(input: {
    readonly attemptId: string;
    readonly authority: NativePilotNemotronImportAuthority;
  }): Promise<NativePilotAttemptReceiptV1>;
  openBlindBatch(input: {
    readonly attempts: readonly NativePilotAttemptReceiptV1[];
  }): Promise<NativePilotBlindBatchAuthority>;
  nextBlindRolePacket(authority: NativePilotBlindBatchAuthority): {
    readonly authority: NativePilotBlindRoleAuthority;
    readonly packet: NativePilotBlindRolePacket;
  } | null;
  admitBlindRoleResult(input: {
    readonly authority: NativePilotBlindRoleAuthority;
    readonly bytes: Buffer;
  }): unknown;
  assembleCrossHarnessPilotReport(
    authority: NativePilotBlindBatchAuthority,
  ): Promise<CrossHarnessPilotReportV1>;
}

export interface PreflightState {
  readonly runner: object;
  readonly compositionId:
    | "openai-gpt-5.6-sol-codex-native-pilot"
    | "anthropic-claude-opus-4.7-claude-code-native-pilot";
  readonly harnessId: NativePilotHarnessId;
  readonly requestedModel: string;
  readonly executable: NativeExecutableObservation;
  readonly reportedVersion: string;
  readonly environment: Readonly<Record<"HOME" | "LANG" | "LC_ALL" | "TMPDIR" | "USER", string>>;
  readonly preflightSha256: string;
  readonly codexFeatureStateCapture: Buffer | null;
  readonly codexStrictConfigProbeSha256: string | null;
  readonly attestationSha256: string;
  consumed: boolean;
  verifyCurrent(): boolean;
}

export interface AttemptPrivateState {
  readonly runner: object;
  readonly receipt: NativePilotAttemptReceiptV1;
  readonly repository: string;
  readonly attemptRoot: string;
  readonly documentBytes: Buffer | null;
  readonly authorIdentities: readonly string[];
  readonly repositorySha256: string;
  readonly artifactLedger: readonly PrivateArtifactLedgerEntry[];
  readonly attestationSha256: string;
  consumed: boolean;
  verifyCurrent(): boolean;
}

export interface EvaluationPrivateState {
  readonly attemptSha256: string;
  readonly outputId: string;
  readonly documentSha256: string;
  readonly evaluationContextSha256: string;
  readonly roleResultSha256s: readonly string[];
  readonly evaluatorExecutionIdentitySha256s: readonly string[];
  readonly evaluatorEvidenceClass: "unattested-agent-proxy";
  readonly taskGuideScore: number;
  readonly proxyCandidateBarMet: boolean;
  readonly outputBarMet: boolean;
  readonly evaluationSha256: string;
}

export interface BlindEntryState {
  readonly attempt: AttemptPrivateState;
  readonly outputId: string;
  readonly orderSha256: string;
  readonly journeyEvidence: Buffer;
  readonly deterministicEvaluation: Buffer;
  readonly journeyPath: string;
  readonly deterministicEvaluationPath: string;
  readonly evaluationArtifactLedger: readonly PrivateArtifactLedgerEntry[];
  readonly evaluationContextSha256: string;
  roleIndex: number;
  pending: BlindRoleState | null;
  roleResults: NormalizedRoleResult[];
  evaluation: EvaluationPrivateState | null;
}

export interface BlindBatchState {
  readonly runner: object;
  readonly attempts: readonly AttemptPrivateState[];
  readonly entries: readonly BlindEntryState[];
  entryIndex: number;
  consumed: boolean;
  reportCreated: boolean;
  readonly attestationSha256: string;
  verifyCurrent(): boolean;
}

export interface BlindRoleState {
  readonly batch: BlindBatchState;
  readonly entry: BlindEntryState;
  readonly role: NativePilotEvaluationRole;
  readonly attestationSha256: string;
  consumed: boolean;
  verifyCurrent(): boolean;
}

export interface NormalizedRoleResult {
  readonly role: NativePilotEvaluationRole;
  readonly evaluatorExecutionIdentitySha256: string;
  readonly evidenceClass: "unattested-agent-proxy";
  readonly payload: Record<string, unknown>;
  readonly artifactSha256: string;
  readonly roleResultSha256: string;
  readonly artifactPath: string;
  readonly artifactMode: number;
}

export interface RunnerState {
  readonly runnerKey: object;
  readonly corpusAuthority: InstalledNativePilotCorpusAuthority;
  readonly corpus: BoundNativePilotCorpus;
  readonly campaignRoot: string;
  readonly kitRoot: string;
  readonly corpusRoot: string;
  readonly forbiddenRoots: readonly string[];
  readonly blindingSeed: Buffer;
  readonly blindingSeedCommitmentSha256: string;
  readonly campaignNonce: Buffer;
  readonly campaignNonceSha256: string;
  readonly durableReplayRoot: string;
  readonly executionEvidenceClass: "live-observed" | "simulation-only";
  readonly executablePaths: Readonly<Record<NativePilotHarnessId, string>>;
  readonly environment: NodeJS.ProcessEnv;
  readonly pythonExecutablePath: string;
  readonly processRunner: NativePilotProcessRunner;
  readonly preflightHost: NativePreflightHost;
  readonly resolveExecutable: NonNullable<NativePilotSimulationRunnerOptions["resolveExecutable"]>;
  readonly captureCodexFeatureState: NonNullable<
    NativePilotSimulationRunnerOptions["captureCodexFeatureState"]
  >;
  readonly captureCodexStrictConfigProbe: NonNullable<
    NativePilotSimulationRunnerOptions["captureCodexStrictConfigProbe"]
  >;
  readonly modelAuthority: Awaited<ReturnType<typeof loadInstalledModelCompositionAuthority>>;
  readonly workflow: WorkflowDefinition;
  readonly instruction: string;
  readonly contextSources: readonly string[];
  readonly attemptIds: Set<string>;
  readonly evaluatorSessions: Set<string>;
  nemotronCommitmentSha256: string | null;
  evaluationOpened: boolean;
}

export interface PrivateArtifactLedgerEntry {
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly sha256: string | null;
  readonly mode: number;
  readonly allowEmpty: boolean;
}

export interface NemotronImportState {
  readonly runner: object;
  readonly compositionRunId: string;
  readonly runRecordSha256: string;
  readonly semanticRecordSha256: string;
  readonly executionIdentitySha256: string;
  readonly stableExecutionReplayKeySha256: string;
  readonly replayKeySha256: string;
  readonly receiptBody: Omit<
    NativePilotAttemptReceiptV1,
    "schemaVersion" | "kind" | "receiptSha256" | "attemptId"
  >;
  readonly repository: string;
  readonly documentBytes: Buffer | null;
  readonly artifactLedger: readonly PrivateArtifactLedgerEntry[];
  readonly repositorySha256: string;
  readonly attestationSha256: string;
  consumed: boolean;
  verifyCurrent(): boolean;
}

const PREFLIGHT_COMPOSITION_IDS = {
  "openai-gpt-5.6-sol-codex-native-pilot": "openai-gpt-5.6-sol-codex-preflight",
  "anthropic-claude-opus-4.7-claude-code-native-pilot":
    "anthropic-claude-opus-4.7-claude-code-preflight",
} as const;

const NATIVE_MODELS = {
  "openai-gpt-5.6-sol-codex-native-pilot": "gpt-5.6-sol",
  "anthropic-claude-opus-4.7-claude-code-native-pilot": "claude-opus-4-7",
} as const;

const preflightAuthorities = createHostAuthorityFactory<
  "docsfab-native-pilot-preflight-authority",
  PreflightState
>({
  kind: "docsfab-native-pilot-preflight-authority",
  invalidMessage: "invalid-native-pilot-preflight-verifier",
});

export async function createNativePilotRunner(
  options: NativePilotLiveRunnerOptions,
): Promise<NativePilotRunner> {
  return await createNativePilotRunnerInternal(options, "live-observed");
}

export async function createNativePilotSimulationRunner(
  options: NativePilotSimulationRunnerOptions,
): Promise<NativePilotRunner> {
  return await createNativePilotRunnerInternal(options, "simulation-only");
}

async function createNativePilotRunnerInternal(
  options: NativePilotLiveRunnerOptions | NativePilotSimulationRunnerOptions,
  executionEvidenceClass: "live-observed" | "simulation-only",
): Promise<NativePilotRunner> {
  const corpus = resolveInstalledNativePilotCorpus({
    authority: options.corpusAuthority,
    corpusId: options.corpus.corpusId,
  });
  if (canonicalDigest(corpus) !== canonicalDigest(options.corpus)) {
    fail("corpus-binding-mismatch");
  }
  const campaignRoot = await requirePrivateRoot(options.campaignRoot);
  const durableReplayRoot = await requirePrivateRoot(options.durableReplayRoot);
  const forbiddenRoots = await Promise.all(options.forbiddenRoots.map(requireCanonicalRoot));
  if (
    forbiddenRoots.length < 2 ||
    forbiddenRoots.some(
      (root) => overlaps(root, campaignRoot) || overlaps(root, durableReplayRoot),
    ) ||
    overlaps(campaignRoot, durableReplayRoot)
  ) {
    fail("artifact-path-invalid");
  }
  if (
    !Buffer.isBuffer(Buffer.from(options.blindingSeed)) ||
    options.blindingSeed.byteLength < 32 ||
    options.blindingSeed.byteLength > 4096
  ) {
    fail("invalid-value");
  }
  if (options.campaignNonce.byteLength < 32 || options.campaignNonce.byteLength > 4096) {
    fail("invalid-value");
  }
  const pythonExecutablePath = await requireExecutablePath(options.pythonExecutablePath);
  const writeBoundary: NativePilotWriteBoundary = {
    campaignRoot,
    durableReplayRoot,
    forbiddenRoots,
  };
  const kitRoot = join(campaignRoot, "kit");
  await assertRunnerNewWritePath(writeBoundary, kitRoot);
  await ensureRunnerPrivateDirectory(writeBoundary, kitRoot, false);
  await copyInstalledKit(options.corpusAuthority, corpus, kitRoot, writeBoundary);
  const corpusRoot = join(kitRoot, "corpus");
  const workflow = parseNativePilotFrozenWorkflow(
    readInstalledNativePilotCorpusFile({
      authority: options.corpusAuthority,
      path: corpus.runtimeBindings.workflow.path,
    }),
  );
  const instruction = strictUtf8(
    readInstalledNativePilotCorpusFile({
      authority: options.corpusAuthority,
      path: "corpus/instruction.txt",
    }),
  );
  const contextSources = parseContextSources(
    readInstalledNativePilotCorpusFile({
      authority: options.corpusAuthority,
      path: "corpus/context-packet.json",
    }),
  );
  const modelAuthority = await loadInstalledModelCompositionAuthority();
  const runnerKey = Object.freeze({});
  const state: RunnerState = {
    runnerKey,
    corpusAuthority: options.corpusAuthority,
    corpus,
    campaignRoot,
    kitRoot,
    corpusRoot,
    forbiddenRoots,
    blindingSeed: Buffer.from(options.blindingSeed),
    blindingSeedCommitmentSha256: sha256(options.blindingSeed),
    campaignNonce: Buffer.from(options.campaignNonce),
    campaignNonceSha256: sha256(options.campaignNonce),
    durableReplayRoot,
    executionEvidenceClass,
    executablePaths: Object.freeze({ ...options.executablePaths }),
    environment: { ...options.environment },
    pythonExecutablePath,
    processRunner:
      executionEvidenceClass === "simulation-only" &&
      "processRunner" in options &&
      options.processRunner
        ? options.processRunner
        : runNativePilotProcess,
    preflightHost:
      executionEvidenceClass === "simulation-only" &&
      "preflightHost" in options &&
      options.preflightHost
        ? options.preflightHost
        : createLocalNativePreflightHost(),
    resolveExecutable:
      executionEvidenceClass === "simulation-only" &&
      "resolveExecutable" in options &&
      options.resolveExecutable
        ? options.resolveExecutable
        : resolveLocalNativeExecutable,
    captureCodexFeatureState:
      executionEvidenceClass === "simulation-only" &&
      "captureCodexFeatureState" in options &&
      options.captureCodexFeatureState
        ? options.captureCodexFeatureState
        : captureCodexFeatureStateWithHostProcess,
    captureCodexStrictConfigProbe:
      executionEvidenceClass === "simulation-only" &&
      "captureCodexStrictConfigProbe" in options &&
      options.captureCodexStrictConfigProbe
        ? options.captureCodexStrictConfigProbe
        : captureCodexStrictConfigProbeWithHostProcess,
    modelAuthority,
    workflow,
    instruction,
    contextSources,
    attemptIds: new Set(),
    evaluatorSessions: new Set(),
    nemotronCommitmentSha256: null,
    evaluationOpened: false,
  };
  const runner: NativePilotRunner = Object.freeze({
    fixtureSha256: corpus.fixtureSha256,
    blindingSeedCommitmentSha256: state.blindingSeedCommitmentSha256,
    campaignNonceSha256: state.campaignNonceSha256,
    preflightNativeComposition: (
      input: Parameters<NativePilotRunner["preflightNativeComposition"]>[0],
    ) => preflightNativeComposition(state, input),
    runNativeAttempt: (input: Parameters<NativePilotRunner["runNativeAttempt"]>[0]) =>
      runNativeAttempt(state, input),
    importFreshNemotronAttempt: (
      input: Parameters<NativePilotRunner["importFreshNemotronAttempt"]>[0],
    ) => importFreshNemotronAttempt(state, input),
    validateFreshNemotronEvidence: (
      input: Parameters<NativePilotRunner["validateFreshNemotronEvidence"]>[0],
    ) => validateFreshNemotronEvidence(state, input),
    commitFreshNemotronAttempt: (
      input: Parameters<NativePilotRunner["commitFreshNemotronAttempt"]>[0],
    ) => commitFreshNemotronAttempt(state, input),
    openBlindBatch: (input: Parameters<NativePilotRunner["openBlindBatch"]>[0]) =>
      openBlindBatch(state, input),
    nextBlindRolePacket: (authority: NativePilotBlindBatchAuthority) =>
      nextBlindRolePacket(state, authority),
    admitBlindRoleResult: (input: Parameters<NativePilotRunner["admitBlindRoleResult"]>[0]) =>
      admitBlindRoleResult(state, input),
    assembleCrossHarnessPilotReport: (authority: NativePilotBlindBatchAuthority) =>
      assembleCrossHarnessPilotReport(state, authority),
  });
  return runner;
}

async function preflightNativeComposition(
  state: RunnerState,
  input: {
    readonly compositionId:
      | "openai-gpt-5.6-sol-codex-native-pilot"
      | "anthropic-claude-opus-4.7-claude-code-native-pilot";
  },
): Promise<NativePilotPreflightAuthority> {
  if (state.evaluationOpened || !Object.hasOwn(PREFLIGHT_COMPOSITION_IDS, input.compositionId)) {
    fail("campaign-phase-invalid");
  }
  const workflowId = state.modelAuthority.snapshot.workflowIds[0];
  if (!workflowId) fail("native-preflight-failed");
  const bound = resolveInstalledComposition({
    authority: state.modelAuthority.authority,
    compositionId: PREFLIGHT_COMPOSITION_IDS[input.compositionId],
    workflowId,
  });
  const harnessId: NativePilotHarnessId =
    input.compositionId === "openai-gpt-5.6-sol-codex-native-pilot" ? "codex" : "claude-code";
  // The frozen cross-harness campaign names its preflight record exactly; a
  // retired record refuses by name rather than as a generic preflight failure.
  assertCompositionNotRetired(bound.composition);
  assertInstalledPreflight(bound, harnessId);
  const configured = state.executablePaths[harnessId];
  const executablePath = await state.resolveExecutable(harnessId, configured);
  const executable = await state.preflightHost.inspectExecutable(executablePath);
  if (!executable.trusted || executable.canonicalPath !== executablePath) {
    fail("native-preflight-failed");
  }
  const environment = await nativeEnvironment(state);
  const requestedModel = NATIVE_MODELS[input.compositionId];
  const preflightInput: NativePreflightInputV1 = {
    schemaVersion: 1,
    kind: NATIVE_PREFLIGHT_INPUT_KIND,
    harnessId,
    routeId: harnessId === "codex" ? "codex-chatgpt-managed" : "claude-ai-managed",
    executionClass: "preflight-only",
    requestedModel,
    executablePath,
    expectedExecutable: {
      basename: preflightExecutableBasename(executable, harnessId),
      sha256: executable.sha256,
      identitySha256: executable.identitySha256,
      reportedVersion:
        harnessId === "codex"
          ? CODEX_PREFLIGHT_REPORTED_VERSION
          : CLAUDE_PREFLIGHT_REPORTED_VERSION,
    },
    environment,
  };
  const adapter =
    harnessId === "codex"
      ? createCodexNativePreflightAdapter(state.preflightHost)
      : createClaudeNativePreflightAdapter(state.preflightHost);
  const observation = await adapter.preflight(preflightInput);
  assertReadyPreflight(observation, harnessId, requestedModel);
  const strictConfigProbeArguments =
    harnessId === "codex" ? buildCodexNativePilotStrictConfigProbeArguments() : null;
  if (harnessId === "codex") {
    let probe: NativePilotStrictConfigProbeObservation;
    try {
      probe = await state.captureCodexStrictConfigProbe(
        executablePath,
        environment,
        state.campaignRoot,
        strictConfigProbeArguments!,
      );
    } catch {
      fail("native-preflight-failed");
    }
    if (probe.exitCode !== 0 || probe.stdout.byteLength !== 0 || probe.stderr.byteLength !== 0) {
      fail("native-preflight-failed");
    }
  }
  const strictConfigProbeSha256 =
    strictConfigProbeArguments === null ? null : canonicalDigest(strictConfigProbeArguments);
  const featureCapture =
    harnessId === "codex"
      ? await state.captureCodexFeatureState(executablePath, environment, state.campaignRoot)
      : null;
  if (featureCapture !== null) {
    decodeCodexNativePilotFeatureState(featureCapture);
    const directory = join(state.campaignRoot, "preflights");
    await ensureRunnerPrivateDirectory(state, directory, true);
    const path = join(directory, `${input.compositionId}.codex-features.txt`);
    await assertRunnerNewWritePath(state, path);
    await writeFile(path, featureCapture, { flag: "wx", mode: 0o600 });
    const retained = await readPrivateArtifact(path, 512 * 1024);
    if (!retained.equals(featureCapture)) fail("artifact-binding-mismatch");
  }
  const preflightBody = {
    runner: state.runnerKey,
    compositionId: input.compositionId,
    harnessId,
    requestedModel,
    executable,
    reportedVersion:
      harnessId === "codex" ? CODEX_PREFLIGHT_REPORTED_VERSION : CLAUDE_PREFLIGHT_REPORTED_VERSION,
    environment,
    preflightSha256: observation.preflightSha256,
    codexFeatureStateCapture: featureCapture === null ? null : Buffer.from(featureCapture),
    codexStrictConfigProbeSha256: strictConfigProbeSha256,
  };
  const attestationSha256 = preflightAttestationSha256(preflightBody, state.campaignNonceSha256);
  const preflightState: PreflightState = {
    ...preflightBody,
    attestationSha256,
    consumed: false,
    verifyCurrent: () =>
      attestationSha256 === preflightAttestationSha256(preflightState, state.campaignNonceSha256),
  };
  return preflightAuthorities.create(preflightState) as NativePilotPreflightAuthority;
}

function assertInstalledPreflight(
  bound: BoundInstalledComposition,
  harnessId: NativePilotHarnessId,
): void {
  const composition = bound.composition;
  if (
    composition.executionClass !== "preflight-only" ||
    composition.status !== "active" ||
    composition.harness.id !== harnessId ||
    composition.model.resolvedId !== (harnessId === "codex" ? "gpt-5.6-sol" : "claude-opus-4-7") ||
    bound.technicalApproval !== "not-established" ||
    bound.releaseEligible !== false
  ) {
    fail("native-preflight-failed");
  }
}

function assertReadyPreflight(
  observation: NativePreflightObservationV1,
  harnessId: NativePilotHarnessId,
  requestedModel: string,
): void {
  if (
    observation.terminalCode !== "preflight-ready" ||
    observation.harnessId !== harnessId ||
    observation.requestedModel !== requestedModel ||
    observation.authentication.status !== "ready" ||
    observation.executable.sha256.length !== 64 ||
    observation.executable.identitySha256.length !== 64
  ) {
    fail("native-preflight-failed");
  }
}

function preflightAttestationSha256(
  value: Pick<
    PreflightState,
    | "compositionId"
    | "harnessId"
    | "requestedModel"
    | "executable"
    | "reportedVersion"
    | "environment"
    | "preflightSha256"
    | "codexFeatureStateCapture"
    | "codexStrictConfigProbeSha256"
  >,
  campaignNonceSha256: string,
): string {
  return canonicalDigest({
    campaignNonceSha256,
    compositionId: value.compositionId,
    harnessId: value.harnessId,
    requestedModel: value.requestedModel,
    executable: value.executable,
    reportedVersion: value.reportedVersion,
    environment: value.environment,
    preflightSha256: value.preflightSha256,
    featureCaptureSha256:
      value.codexFeatureStateCapture === null ? null : sha256(value.codexFeatureStateCapture),
    strictConfigProbeSha256: value.codexStrictConfigProbeSha256,
  });
}

function preflightExecutableBasename(
  executable: NativeExecutableObservation,
  harnessId: NativePilotHarnessId,
): NativePreflightInputV1["expectedExecutable"]["basename"] {
  const value = basename(executable.canonicalPath);
  const allowed = harnessId === "codex" ? ["codex", "codex.exe"] : ["claude", "claude.exe"];
  if (value !== executable.basename || !allowed.includes(value)) fail("native-preflight-failed");
  return value as NativePreflightInputV1["expectedExecutable"]["basename"];
}

async function nativeEnvironment(
  state: RunnerState,
): Promise<Readonly<Record<"HOME" | "LANG" | "LC_ALL" | "TMPDIR" | "USER", string>>> {
  const homeSource = state.environment.HOME;
  if (!homeSource) fail("path-policy");
  const home = await requireCanonicalRoot(homeSource);
  const temporary = join(state.campaignRoot, "native-tmp");
  await ensureRunnerPrivateDirectory(state, temporary, true);
  const lang = locale(state.environment.LANG ?? "C.UTF-8");
  const lcAll = locale(state.environment.LC_ALL ?? lang);
  const user = username(state.environment.USER);
  return Object.freeze({ HOME: home, LANG: lang, LC_ALL: lcAll, TMPDIR: temporary, USER: user });
}

function nativeStepEnvironment(
  _harnessId: NativePilotHarnessId,
  environment: PreflightState["environment"],
): NativePilotEnvironmentV1 {
  return Object.freeze({ ...environment });
}

async function captureCodexFeatureStateWithHostProcess(
  executablePath: string,
  environment: Readonly<Record<string, string>>,
  workingDirectory: string,
): Promise<Buffer> {
  const result = await runBoundedHostProcess({
    executablePath,
    arguments: [
      ...CODEX_NATIVE_PILOT_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
      "features",
      "list",
    ],
    workingDirectory,
    environment,
    stdin: null,
    timeoutMs: 60_000,
    maxStdoutBytes: 256 * 1024,
    maxStderrBytes: 64 * 1024,
  });
  if (result.exitCode !== 0 || result.stderr.byteLength !== 0) {
    fail("native-preflight-failed");
  }
  return result.stdout;
}

async function captureCodexStrictConfigProbeWithHostProcess(
  executablePath: string,
  environment: Readonly<Record<string, string>>,
  workingDirectory: string,
  argumentsValue: readonly string[],
): Promise<NativePilotStrictConfigProbeObservation> {
  if (
    canonicalDigest(argumentsValue) !==
    canonicalDigest(buildCodexNativePilotStrictConfigProbeArguments())
  ) {
    fail("native-preflight-failed");
  }
  return await runBoundedHostProcess({
    executablePath,
    arguments: argumentsValue,
    workingDirectory,
    environment,
    stdin: null,
    timeoutMs: 60_000,
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 64 * 1024,
  });
}

async function copyInstalledKit(
  authority: InstalledNativePilotCorpusAuthority,
  corpus: BoundNativePilotCorpus,
  destination: string,
  boundary: NativePilotWriteBoundary,
): Promise<void> {
  for (const file of corpus.files) {
    const path = safeJoin(destination, file.path);
    await ensureRunnerPrivateDirectory(boundary, dirname(path), true);
    await assertRunnerNewWritePath(boundary, path);
    const bytes = readInstalledNativePilotCorpusFile({ authority, path: file.path });
    if (sha256(bytes) !== file.sha256) fail("corpus-binding-mismatch");
    await writeFile(path, bytes, { flag: "wx", mode: file.mode === "100755" ? 0o700 : 0o600 });
  }
}

function verifiedInstalledBytes(state: RunnerState, path: string, expectedSha256: string): Buffer {
  const bytes = readInstalledNativePilotCorpusFile({ authority: state.corpusAuthority, path });
  if (sha256(bytes) !== expectedSha256) fail("corpus-binding-mismatch");
  return bytes;
}

function lockedFileSha256(corpus: BoundNativePilotCorpus, path: string): string {
  const file = corpus.files.find((entry) => entry.path === path);
  if (!file) fail("corpus-binding-mismatch");
  return file.sha256;
}

export function parseNativePilotFrozenWorkflow(bytes: Buffer): WorkflowDefinition {
  let workflow: WorkflowDefinition;
  try {
    workflow = parseWorkflowManifestSnapshot(parseJsonEvidence(bytes), "create-documentation", {
      "documentation-audit": documentationAuditSearch,
      "documentation-observation": documentationObservationSearch,
    });
  } catch {
    fail("corpus-binding-mismatch");
  }
  if (
    workflow.steps.length !== NATIVE_PILOT_STEP_IDS.length ||
    workflow.steps.some(
      (step, index) =>
        step.id !== NATIVE_PILOT_STEP_IDS[index] || step.skill !== NATIVE_PILOT_STEP_IDS[index],
    )
  ) {
    fail("corpus-binding-mismatch");
  }
  return deepFreeze(workflow);
}

function parseContextSources(bytes: Buffer): readonly string[] {
  const value = strictObject(parseJsonEvidence(bytes));
  if (!Array.isArray(value.orderedSources)) fail("corpus-binding-mismatch");
  const sources = value.orderedSources.map((path) => {
    if (typeof path !== "string" || !safeRelativePath(path)) fail("corpus-binding-mismatch");
    return path;
  });
  if (sources.length < 1 || new Set(sources).size !== sources.length) {
    fail("corpus-binding-mismatch");
  }
  return Object.freeze(sources);
}
async function runNativeAttempt(
  state: RunnerState,
  input: { readonly attemptId: string; readonly preflightAuthority: NativePilotPreflightAuthority },
): Promise<NativePilotAttemptReceiptV1> {
  if (state.executionEvidenceClass === "live-observed" && state.nemotronCommitmentSha256 === null) {
    fail("campaign-phase-invalid");
  }
  const preflight = preflightAuthorities.lookup(input.preflightAuthority);
  if (
    !preflight?.verifyCurrent() ||
    preflight.runner !== state.runnerKey ||
    preflight.consumed ||
    state.evaluationOpened
  ) {
    fail("attempt-replay");
  }
  const attemptId = identifier(input.attemptId);
  if (state.attemptIds.has(attemptId)) fail("attempt-replay");
  state.attemptIds.add(attemptId);
  preflight.consumed = true;
  const attemptRoot = safeJoin(state.campaignRoot, `attempts/${attemptId}`);
  await assertRunnerNewWritePath(state, attemptRoot);
  await ensureRunnerPrivateDirectory(state, attemptRoot, true);
  const repository = join(attemptRoot, "repository");
  const receipts: NativePilotStepReceiptV1[] = [];
  const nativeCaptureSha256s: string[] = [];
  const outputs: NativePilotStepOutputV1[] = [];
  let documentSha256: string | null = null;
  let patchSha256: string | null = null;
  let documentBytes: Buffer | null = null;
  let failureCategory: string | null = null;
  let failurePhase: NativePilotFailurePhase | null = null;
  let failureEvidence: NativePilotFailureEvidenceV1 | null = null;
  try {
    await materializeRepository(state, repository);
    let snapshot = await snapshotRepository(repository);
    if (snapshot.sha256 !== state.corpus.repositoryTreeSha256) {
      fail("corpus-binding-mismatch");
    }
    documentBytes = await readBoundedRegularFile(
      join(repository, state.corpus.allowedPage),
      state.corpus.limits.maxResponseBytes,
    );
    documentSha256 = sha256(documentBytes);

    for (let index = 0; index < NATIVE_PILOT_STEP_IDS.length; index += 1) {
      const stepId = NATIVE_PILOT_STEP_IDS[index]!;
      let result:
        | {
            readonly output: NativePilotStepOutputV1;
            readonly receipt: NativePilotStepReceiptV1;
            readonly captureSha256: string;
          }
        | undefined;
      try {
        result = await executeNativeStep({
          state,
          preflight,
          attemptId,
          attemptRoot,
          repository,
          stepId,
          ordinal: index + 1,
          snapshot,
          documentBytes,
          receipts,
          outputs,
        });
      } catch (error) {
        if (stopProofBlocker(error)) throw error;
        failureCategory = failureCode(error);
        failurePhase = phaseForStep(index);
        if (error instanceof NativeStepFailure) failureEvidence = error.evidence;
        break;
      }
      receipts.push(parseNativePilotStepReceiptV1(result.receipt));
      nativeCaptureSha256s.push(result.captureSha256);
      outputs.push(result.output);
      if (new Set(receipts.map((receipt) => receipt.sessionSha256)).size !== receipts.length) {
        failureCategory = "session-replay";
        failurePhase = phaseForStep(index);
        break;
      }
      let admitted: Awaited<ReturnType<typeof admitStepOutput>>;
      try {
        admitted = await admitStepOutput({
          state,
          repository,
          attemptRoot,
          snapshot,
          output: result.output,
          receipt: result.receipt,
          ordinal: index + 1,
        });
      } catch (error) {
        failureCategory = failureCode(error);
        failurePhase = phaseForStep(index);
        break;
      }
      snapshot = admitted.snapshot;
      documentBytes = admitted.documentBytes;
      documentSha256 = admitted.documentSha256;
      patchSha256 = admitted.patchSha256 ?? patchSha256;
      if (result.output.outcome !== "succeeded") {
        failureCategory = result.output.outcome;
        failurePhase = phaseForStep(index);
        break;
      }
    }
  } catch (error) {
    if (stopProofBlocker(error)) throw error;
    failureCategory = failureCode(error);
    failurePhase = phaseForStep(receipts.length);
    if (error instanceof NativeStepFailure) failureEvidence = error.evidence;
  }
  const succeeded = failureCategory === null && receipts.length === NATIVE_PILOT_STEP_IDS.length;
  if (!succeeded && failureCategory === null) {
    failureCategory = "step-set-mismatch";
    failurePhase = phaseForStep(receipts.length);
  }
  if (failureEvidence !== null && !nativeCaptureSha256s.includes(failureEvidence.captureSha256)) {
    nativeCaptureSha256s.push(failureEvidence.captureSha256);
  }
  if (!(await pathExists(repository))) {
    await assertRunnerNewWritePath(state, repository);
    await ensureRunnerPrivateDirectory(state, repository, false);
  }
  await requirePrivateRepository(repository);
  return registerAttempt(
    state,
    sealAttemptReceipt({
      evidenceClass: NATIVE_PILOT_EVIDENCE_CLASS,
      executionEvidenceClass: state.executionEvidenceClass,
      campaignNonceSha256: state.campaignNonceSha256,
      fixtureSha256: state.corpus.fixtureSha256,
      attemptId,
      compositionId: preflight.compositionId,
      harnessId: preflight.harnessId,
      executionShape:
        preflight.harnessId === "codex" ? "codex-native-six-step" : "claude-code-native-six-step",
      requestedModel: preflight.requestedModel,
      observedModel:
        preflight.harnessId === "claude-code" && receipts.length > 0
          ? preflight.requestedModel
          : null,
      status: succeeded ? "succeeded" : "failed",
      failureCategory: succeeded ? null : failureCategory,
      failurePhase: succeeded ? null : failurePhase,
      failureEvidence: succeeded ? null : failureEvidence,
      stepReceiptSha256s: receipts.map((receipt) => receipt.receiptSha256),
      nativeCaptureSha256s,
      authorExecutionIdentitySha256s: [
        ...receipts.map((receipt) => receipt.sessionSha256),
        ...(failureEvidence?.sessionSha256 ? [failureEvidence.sessionSha256] : []),
      ],
      documentSha256: succeeded || failurePhase === "after-write" ? documentSha256 : null,
      patchSha256: succeeded || failurePhase === "after-write" ? patchSha256 : null,
      runRecordSha256: null,
      compositionEvidenceSha256: null,
      aggregateSha256: null,
      ...aggregateNativeUsage(receipts, failureEvidence),
      technicalApproval: "not-established",
      roleQualification: "not-established",
      releaseEligible: false,
    }),
    repository,
    succeeded || failurePhase === "after-write" ? documentBytes : null,
    attemptRoot,
  );
}

async function executeNativeStep(input: {
  readonly state: RunnerState;
  readonly preflight: PreflightState;
  readonly attemptId: string;
  readonly attemptRoot: string;
  readonly repository: string;
  readonly stepId: NativePilotStepId;
  readonly ordinal: number;
  readonly snapshot: RepositorySnapshot;
  readonly documentBytes: Buffer;
  readonly receipts: readonly NativePilotStepReceiptV1[];
  readonly outputs: readonly NativePilotStepOutputV1[];
}): Promise<{
  readonly output: NativePilotStepOutputV1;
  readonly receipt: NativePilotStepReceiptV1;
  readonly captureSha256: string;
}> {
  const { state, preflight, stepId, ordinal } = input;
  const causalPacket = await buildCausalPacket(input);
  const stdin = Buffer.from(canonicalJson(causalPacket), "utf8");
  if (
    stdin.byteLength < 1 ||
    stdin.byteLength > NATIVE_PILOT_MAXIMA.maxStdinBytes ||
    detectCredentialRuleIdsInValue(causalPacket).length > 0
  ) {
    fail("credential-material");
  }
  const schema = outputSchema(stepId);
  const outputSchemaJson = canonicalJson(schema);
  const outputSchemaSha256 = canonicalDigest(schema);
  const temporaryRoot = preflight.environment.TMPDIR;
  await ensureRunnerPrivateDirectory(state, temporaryRoot, true);
  const stepRoot = safeJoin(
    temporaryRoot,
    `${input.attemptId}/${String(ordinal).padStart(2, "0")}-${stepId}`,
  );
  const workingDirectory = join(stepRoot, "scratch");
  const schemaDirectory = join(stepRoot, "schema");
  await ensureRunnerPrivateDirectory(state, stepRoot, true);
  await ensureRunnerPrivateDirectory(state, workingDirectory, false);
  await ensureRunnerPrivateDirectory(state, schemaDirectory, false);
  await assertDirectoryEmpty(workingDirectory);
  const schemaPath = join(schemaDirectory, "output-schema.json");
  if (preflight.harnessId === "codex") {
    await assertRunnerNewWritePath(state, schemaPath);
    await writeFile(schemaPath, outputSchemaJson, { flag: "wx", mode: 0o600 });
  }
  let plan;
  try {
    plan = sealNativePilotStepPlanV1({
      adapterVersion: NATIVE_PILOT_ADAPTER_VERSION,
      evidenceClass: NATIVE_PILOT_EVIDENCE_CLASS,
      harnessId: preflight.harnessId,
      stepId,
      requestedModel: preflight.requestedModel,
      executablePath: preflight.executable.canonicalPath,
      executableSha256: preflight.executable.sha256,
      executableIdentitySha256: preflight.executable.identitySha256,
      reportedVersion: preflight.reportedVersion,
      workingDirectory,
      workingDirectorySha256: sha256(Buffer.from(workingDirectory, "utf8")),
      environment: nativeStepEnvironment(preflight.harnessId, preflight.environment),
      stdinSha256: sha256(stdin),
      serializedInputSha256: sha256(stdin),
      outputSchemaSha256,
      outputSchemaPath: preflight.harnessId === "codex" ? schemaPath : null,
      systemPromptSha256: NATIVE_PILOT_SYSTEM_PROMPT_SHA256,
      limits: NATIVE_PILOT_MAXIMA,
    });
  } catch {
    fail("attempt-binding-mismatch");
  }
  if (
    plan.stdinSha256 !== sha256(stdin) ||
    plan.serializedInputSha256 !== sha256(stdin) ||
    plan.outputSchemaSha256 !== canonicalDigest(parseJsonEvidence(Buffer.from(outputSchemaJson))) ||
    plan.systemPromptSha256 !== NATIVE_PILOT_SYSTEM_PROMPT_SHA256
  ) {
    fail("attempt-binding-mismatch");
  }
  const invocation =
    preflight.harnessId === "codex"
      ? buildCodexNativePilotInvocation({
          plan,
          stdin,
          outputSchemaJson,
          codexFeatureStateCapture: Buffer.from(preflight.codexFeatureStateCapture!),
        })
      : buildClaudeNativePilotInvocation({ plan, stdin, outputSchemaJson });
  let observation: NativePilotProcessObservation;
  try {
    observation = await state.processRunner(invocation.process);
  } finally {
    if (preflight.harnessId === "codex") {
      const observed = await readBoundedRegularFile(
        schemaPath,
        NATIVE_PILOT_MAXIMA.maxOutputSchemaBytes,
      );
      if (!observed.equals(Buffer.from(outputSchemaJson, "utf8"))) {
        fail("artifact-binding-mismatch");
      }
      await assertRunnerWritePath(state, schemaPath);
      await rm(schemaPath);
    }
  }
  await assertDirectoryEmpty(workingDirectory);
  const executableAfter = await state.preflightHost.inspectExecutable(
    preflight.executable.canonicalPath,
  );
  if (
    !executableAfter.trusted ||
    executableAfter.sha256 !== preflight.executable.sha256 ||
    executableAfter.identitySha256 !== preflight.executable.identitySha256
  ) {
    fail("executable-drift");
  }
  let decoded;
  try {
    decoded = decodeNativePilotResult(plan, observation);
  } catch (error) {
    const evidence = await persistFailedNativeCapture({
      state,
      attemptRoot: input.attemptRoot,
      stepId,
      ordinal,
      harnessId: preflight.harnessId,
      requestedModel: preflight.requestedModel,
      observation,
    });
    throw new NativeStepFailure(failureCode(error), evidence);
  }
  const captureSha256 = await persistNativeCapture({
    state,
    attemptRoot: input.attemptRoot,
    stepId,
    ordinal,
    observation,
    receipt: decoded.receipt,
  });
  return { ...decoded, captureSha256 };
}

async function buildCausalPacket(input: {
  readonly state: RunnerState;
  readonly preflight: PreflightState;
  readonly attemptId: string;
  readonly repository: string;
  readonly stepId: NativePilotStepId;
  readonly ordinal: number;
  readonly snapshot: RepositorySnapshot;
  readonly documentBytes: Buffer;
  readonly receipts: readonly NativePilotStepReceiptV1[];
  readonly outputs: readonly NativePilotStepOutputV1[];
}): Promise<Record<string, unknown>> {
  const workflowStep = input.state.workflow.steps[input.ordinal - 1];
  const skill = input.state.corpus.runtimeBindings.skills[input.ordinal - 1];
  if (
    !workflowStep ||
    workflowStep.id !== input.stepId ||
    !skill ||
    skill.id !== input.stepId ||
    skill.files.length < 1
  ) {
    fail("corpus-binding-mismatch");
  }
  const skillFiles = skill.files.map((file) => {
    const bytes = verifiedInstalledBytes(input.state, file.path, file.sha256);
    if (!safeRelativePath(file.relativePath)) fail("corpus-binding-mismatch");
    return {
      path: file.relativePath,
      sha256: file.sha256,
      mode: file.mode,
      content: strictUtf8(bytes),
    };
  });
  const modeBoundBundleSha256 = sha256(
    Buffer.from(
      [...skillFiles]
        .sort((left, right) => compareText(left.path, right.path))
        .map((file) => `${file.mode} ${file.sha256}  ${file.path}\n`)
        .join(""),
      "utf8",
    ),
  );
  if (modeBoundBundleSha256 !== skill.modeBoundBundleSha256) {
    fail("corpus-binding-mismatch");
  }
  // The skill's Markdown links reach these quality-pack files; carrying them
  // keeps a step that is told to read one from reading nothing.
  const qualityFiles = skill.qualityFiles.map((file) => {
    const bytes = verifiedInstalledBytes(input.state, file.path, file.sha256);
    if (!safeRelativePath(file.relativePath)) fail("corpus-binding-mismatch");
    return {
      path: file.relativePath,
      sha256: file.sha256,
      mode: file.mode,
      content: strictUtf8(bytes),
    };
  });
  const sources = await Promise.all(
    input.state.contextSources.map(async (logicalPath) => {
      const bytes = logicalPath.startsWith("repository/")
        ? await readBoundedRegularFile(
            safeJoin(input.repository, logicalPath.slice("repository/".length)),
            2 * 1024 * 1024,
          )
        : verifiedInstalledBytes(
            input.state,
            `corpus/${logicalPath}`,
            lockedFileSha256(input.state.corpus, `corpus/${logicalPath}`),
          );
      return { path: logicalPath, sha256: sha256(bytes), content: strictUtf8(bytes) };
    }),
  );
  return {
    schemaVersion: 1,
    kind: "docsfab-native-pilot-causal-packet",
    fixture: {
      corpusId: input.state.corpus.corpusId,
      fixtureSha256: input.state.corpus.fixtureSha256,
      sourceFixtureSha256: input.state.corpus.sourceFixtureSha256,
      manifestSha256: input.state.corpus.bindings.sourceManifestSha256,
      repositoryRevision: input.state.corpus.repositoryRevision,
      workflowSha256: input.state.corpus.bindings.workflowSha256,
      qualityPackSha256: input.state.corpus.bindings.qualityPackSha256,
      skillSetSha256: input.state.corpus.bindings.skillSetSha256,
      contextSha256: input.state.corpus.bindings.contextSha256,
      executionEnvelopeSha256: input.state.corpus.bindings.executionEnvelopeSha256,
      sourceBundleSha256: input.state.corpus.bindings.sourceBundleSha256,
    },
    task: {
      instruction: input.state.instruction,
      targetPath: input.state.corpus.allowedPage,
    },
    step: {
      id: input.stepId,
      ordinal: input.ordinal,
      prompt: workflowStep.prompt,
      skill: {
        id: skill.id,
        bundleSha256: skill.bundleSha256,
        modeBoundBundleSha256: skill.modeBoundBundleSha256,
        files: skillFiles,
      },
      quality: {
        linkRoot: "../../quality",
        lockSha256: input.state.corpus.runtimeBindings.qualityLock.sha256,
        files: qualityFiles,
      },
    },
    current: {
      repositoryTreeSha256: input.snapshot.sha256,
      documentSha256: sha256(input.documentBytes),
      document: strictUtf8(input.documentBytes),
    },
    priorSteps: input.receipts.map((receipt, index) => ({
      stepId: receipt.stepId,
      receiptSha256: receipt.receiptSha256,
      outcome: receipt.outcome,
      summary: input.outputs[index]?.summary,
      summarySha256: receipt.summarySha256,
    })),
    sources,
    nativeEnvelope: {
      preflightSha256: input.preflight.preflightSha256,
      nemotronCommitmentSha256: input.state.nemotronCommitmentSha256,
      evidenceClass: NATIVE_PILOT_EVIDENCE_CLASS,
      tools: [],
      mcpServers: [],
      retryCount: 0,
      limits: NATIVE_PILOT_MAXIMA,
    },
  };
}

async function admitStepOutput(input: {
  readonly state: RunnerState;
  readonly repository: string;
  readonly attemptRoot: string;
  readonly snapshot: RepositorySnapshot;
  readonly output: NativePilotStepOutputV1;
  readonly receipt: NativePilotStepReceiptV1;
  readonly ordinal: number;
}): Promise<{
  readonly snapshot: RepositorySnapshot;
  readonly documentBytes: Buffer;
  readonly documentSha256: string;
  readonly patchSha256: string | null;
}> {
  const outputBytes = Buffer.from(JSON.stringify(input.output), "utf8");
  if (sha256(outputBytes) !== input.receipt.outputSha256) fail("artifact-binding-mismatch");
  const artifactDirectory = join(input.attemptRoot, "artifacts");
  await ensureRunnerPrivateDirectory(input.state, artifactDirectory, true);
  const artifactPath = join(
    artifactDirectory,
    `${String(input.ordinal).padStart(2, "0")}-${input.output.stepId}.json`,
  );
  await assertRunnerNewWritePath(input.state, artifactPath);
  await writeFile(artifactPath, outputBytes, { flag: "wx", mode: 0o600 });
  if (input.output.outcome !== "succeeded") {
    const snapshot = await snapshotRepository(input.repository);
    if (snapshot.sha256 !== input.snapshot.sha256) fail("workspace-mutation");
    const documentBytes = await readBoundedRegularFile(
      join(input.repository, input.state.corpus.allowedPage),
      input.state.corpus.limits.maxResponseBytes,
    );
    return {
      snapshot,
      documentBytes,
      documentSha256: sha256(documentBytes),
      patchSha256: null,
    };
  }
  if (input.output.stepId === "write-documentation") {
    const document = input.output.document;
    if (!document || document.path !== input.state.corpus.allowedPage) {
      fail("write-boundary-failed");
    }
    const bytes = Buffer.from(document.content, "utf8");
    if (
      bytes.byteLength < 1 ||
      bytes.byteLength > input.state.corpus.limits.maxResponseBytes ||
      detectCredentialRuleIdsInValue(document.content).length > 0
    ) {
      fail("credential-material");
    }
    await atomicReplaceRegularFile(input.state, join(input.repository, document.path), bytes);
    const snapshot = await snapshotRepository(input.repository);
    const changedPaths = await gitChangedPaths(input.repository);
    if (changedPaths.length !== 1 || changedPaths[0] !== document.path) {
      fail("write-boundary-failed");
    }
    const patch = await gitPatch(input.repository, document.path);
    if (
      patch.byteLength < 1 ||
      snapshot.sha256 === input.snapshot.sha256 ||
      detectCredentialRuleIdsInValue(strictUtf8(patch)).length > 0
    ) {
      fail("write-boundary-failed");
    }
    return {
      snapshot,
      documentBytes: bytes,
      documentSha256: sha256(bytes),
      patchSha256: sha256(patch),
    };
  }
  const snapshot = await snapshotRepository(input.repository);
  if (snapshot.sha256 !== input.snapshot.sha256) fail("workspace-mutation");
  const documentBytes = await readBoundedRegularFile(
    join(input.repository, input.state.corpus.allowedPage),
    input.state.corpus.limits.maxResponseBytes,
  );
  return {
    snapshot,
    documentBytes,
    documentSha256: sha256(documentBytes),
    patchSha256: null,
  };
}

function outputSchema(stepId: NativePilotStepId): Record<string, unknown> {
  const common = {
    schemaVersion: { type: "integer", const: 1 },
    kind: { type: "string", const: "docsfab-native-pilot-step-output" },
    stepId: { type: "string", const: stepId },
    outcome: { type: "string", enum: ["succeeded", "needs-input", "needs-human-decision"] },
    summary: { type: "string", minLength: 1, maxLength: 8_192 },
  };
  if (stepId === "write-documentation") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["schemaVersion", "kind", "stepId", "outcome", "summary", "payload", "document"],
      properties: {
        ...common,
        payload: { type: "null" },
        document: {
          type: "object",
          additionalProperties: false,
          required: ["path", "content"],
          properties: {
            path: { type: "string", const: "docs/routing/guide.md" },
            content: { type: "string", minLength: 1, maxLength: 65_536 },
          },
        },
      },
    };
  }
  const payloadKind = {
    "plan-documentation": "plan",
    "lint-documentation": "lint-findings",
    "verify-technical-accuracy": "technical-findings",
    "review-documentation": "editorial-findings",
    "evaluate-document-quality": "quality-evaluation",
  }[stepId];
  return {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "kind", "stepId", "outcome", "summary", "payload", "document"],
    properties: {
      ...common,
      payload: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "content"],
        properties: {
          kind: { type: "string", const: payloadKind },
          content: { type: "string", minLength: 1, maxLength: 65_536 },
        },
      },
      document: { type: "null" },
    },
  };
}
function stopProofBlocker(error: unknown): boolean {
  const code = failureCode(error);
  return code === "process-not-settled" || code === "provider-request-count-mismatch";
}
