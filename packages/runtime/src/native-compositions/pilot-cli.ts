// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes as systemRandomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { dirname } from "node:path";
import { promisify } from "node:util";

import { canonicalDigest, canonicalJson } from "../contract-kit/index.js";
import { resolveDocsFabProjectRoot, resolveDocsFabStateDirectory } from "../config/host-paths.js";
import { loadPrivateDocsFabEnvironment } from "../config/private-environment.js";
import { parseJsonEvidence } from "../json-evidence.js";
import { renderCliPresentation } from "../cli/presentation.js";
import {
  parseCompositionExecutionAggregate,
  parseCompositionExecutionEvidence,
} from "../records/composition-execution.js";
import {
  loadInstalledNativePilotCorpusAuthority,
  readInstalledNativePilotCorpusFile,
  resolveInstalledNativePilotCorpus,
  type BoundNativePilotCorpus,
  type InstalledNativePilotCorpusAuthority,
} from "./pilot-corpus.js";
import {
  CROSS_HARNESS_PILOT_REPORT_KIND,
  NATIVE_PILOT_ATTEMPT_RECEIPT_KIND,
  NATIVE_PILOT_EVALUATION_ROLES,
  NATIVE_PILOT_ROLE_RESULT_KIND,
  createNativePilotRunner,
  decodeNativePilotNemotronRunRecord,
  parseNativePilotFrozenWorkflow,
  type CrossHarnessPilotReportV1,
  type NativePilotAttemptReceiptV1,
  type NativePilotBlindRolePacket,
  type NativePilotEvaluationRole,
  type NativePilotRunner,
  type NativePilotLiveRunnerOptions,
} from "./pilot-runner.js";
import type { WorkflowDefinition } from "../workflow-contracts/contracts.js";
import { projectPilotCampaignResult } from "./presentation.js";
import {
  fail,
  configuredExecutable,
  type PilotCampaignCliArguments,
  PilotCampaignCliError,
} from "./pilot-cli-parse.js";

export {
  parsePilotCampaignCliArguments,
  configuredExecutable,
  type PilotCampaignCliArguments,
  type PilotCampaignCliErrorCode,
  PilotCampaignCliError,
} from "./pilot-cli-parse.js";
import { sha256 } from "../content-ir/canonical.js";

const MAX_INPUT_ARTIFACT_BYTES = 16 * 1024 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const execFileAsync = promisify(execFile);
const NATIVE_COMPOSITIONS = [
  "openai-gpt-5.6-sol-codex-native-pilot",
  "anthropic-claude-opus-4.7-claude-code-native-pilot",
] as const;

export interface NemotronPilotArtifacts {
  readonly runRecordBytes: Buffer;
  readonly compositionEvidenceBytes: Buffer;
  readonly aggregateBytes: Buffer | null;
  readonly patchBytes: Buffer | null;
  readonly documentBytes: Buffer | null;
  readonly sourceRoot: string;
  readonly freshness: {
    readonly evidenceSha256: string;
    readonly sourceRootSha256: string;
    readonly sourceRevision: string;
    readonly sourceGitTree: string;
    readonly contextPacketSha256s: readonly string[];
    readonly skillBundleSha256s: readonly string[];
    readonly toolPolicySha256s: readonly string[];
  };
}

export interface PilotCampaignCliDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly log?: (message: string) => void;
  readonly loadCorpus?: () => Promise<{
    readonly authority: InstalledNativePilotCorpusAuthority;
    readonly corpus: BoundNativePilotCorpus;
  }>;
  readonly createRunner?: (options: NativePilotLiveRunnerOptions) => Promise<NativePilotRunner>;
  readonly loadNemotronArtifacts?: (input: {
    readonly recordPath: string;
    readonly patchPath: string | null;
    readonly documentPath: string | null;
    readonly workflow?: WorkflowDefinition;
    readonly workflowIdentity?: { readonly id: string; readonly sourceSha256: string };
  }) => Promise<NemotronPilotArtifacts>;
  readonly randomBytes?: (size: number) => Buffer;
  readonly resolveInstalledRoot?: () => string;
  readonly prepareDurableReplayRoot?: (input: {
    readonly environment: NodeJS.ProcessEnv;
    readonly campaignRoot: string;
  }) => Promise<string>;
  readonly loadEnvironment?: (environment: NodeJS.ProcessEnv) => void;
}

export interface PilotCampaignCliResultV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-pilot-campaign-cli-result/v1";
  readonly status: "completed";
  readonly evidenceClass: "development-only-uncontained";
  readonly fixtureSha256: string;
  readonly attemptReceiptSha256s: readonly string[];
  readonly proxyArtifactCount: number;
  readonly proxyEvidenceClass: "unattested-agent-proxy";
  readonly reportSha256: string;
  readonly qualityComparisonStatus: "proxy-evaluation-incomplete";
  readonly commonEvaluationEstablished: false;
  readonly reliability: { readonly succeeded: number; readonly failed: number };
  readonly ranking: { readonly winnerCompositionId: null };
  readonly artifacts: {
    readonly attemptReceipts: readonly string[];
    readonly proxyResults: readonly string[];
    readonly report: "report.json";
  };
  readonly technicalApproval: "not-established";
  readonly roleQualification: "not-established";
  readonly releaseEligible: false;
}

/** Run the complete cross-harness campaign; all model/process seams remain injectable for tests. */
export async function handlePilotCampaignCommand(
  request: PilotCampaignCliArguments,
  dependencies: PilotCampaignCliDependencies = {},
): Promise<PilotCampaignCliResultV1> {
  const environment = loadPrivateDocsFabEnvironment(dependencies.environment ?? process.env);
  dependencies.loadEnvironment?.(environment);
  const log = dependencies.log ?? console.log;
  await requireEmptyPrivateCampaignRoot(request.campaignRoot);
  const executablePaths = {
    codex: configuredExecutable(environment.DOCSFAB_CODEX_EXECUTABLE),
    "claude-code": configuredExecutable(environment.DOCSFAB_CLAUDE_EXECUTABLE),
  } as const;
  const pythonExecutablePath = configuredExecutable(environment.DOCSFAB_PYTHON_EXECUTABLE);
  const loaded = await (dependencies.loadCorpus ?? loadDefaultCorpus)();
  if (loaded.corpus.corpusId !== request.corpusId) fail("campaign-failed");
  const nemotronInput = {
    recordPath: request.nemotronRecordPath,
    patchPath: request.nemotronPatchPath,
    documentPath: request.nemotronDocumentPath,
  };
  const nemotron = await (dependencies.loadNemotronArtifacts ?? loadNemotronPilotArtifacts)({
    ...nemotronInput,
    workflow: parseNativePilotFrozenWorkflow(
      readInstalledNativePilotCorpusFile({
        authority: loaded.authority,
        path: loaded.corpus.runtimeBindings.workflow.path,
      }),
    ),
    workflowIdentity: {
      id: "create-documentation",
      sourceSha256: loaded.corpus.bindings.workflowSha256,
    },
  });
  assertNemotronFreshness(loaded.corpus, nemotron);
  const installedRoot = await canonicalExistingRoot(
    (dependencies.resolveInstalledRoot ?? resolveDocsFabProjectRoot)(),
  );
  const forbiddenRoots = await validateForbiddenRoots(
    request.forbiddenRoots,
    installedRoot,
    nemotron.sourceRoot,
  );
  const random = dependencies.randomBytes ?? systemRandomBytes;
  const blindingSeed = requireRandomBytes(random(32), 32);
  const campaignNonce = requireRandomBytes(random(32), 32);
  const attemptIds = Array.from({ length: 3 }, () => opaqueAttemptId(random));
  if (new Set(attemptIds).size !== attemptIds.length) fail("campaign-failed");
  const durableReplayRoot = await requirePrivateReplayRoot(
    await (dependencies.prepareDurableReplayRoot ?? prepareDefaultDurableReplayRoot)({
      environment,
      campaignRoot: request.campaignRoot,
    }),
  );
  if (
    overlaps(durableReplayRoot, request.campaignRoot) ||
    forbiddenRoots.some((root) => overlaps(durableReplayRoot, root))
  ) {
    fail("replay-root-invalid");
  }
  const runner = await (dependencies.createRunner ?? createNativePilotRunner)({
    corpusAuthority: loaded.authority,
    corpus: loaded.corpus,
    campaignRoot: request.campaignRoot,
    forbiddenRoots,
    blindingSeed,
    campaignNonce,
    durableReplayRoot,
    executablePaths,
    environment,
    pythonExecutablePath,
  });

  const attempts: NativePilotAttemptReceiptV1[] = [];
  const nemotronAuthority = await runner.validateFreshNemotronEvidence({
    runRecordBytes: nemotron.runRecordBytes,
    compositionEvidenceBytes: nemotron.compositionEvidenceBytes,
    aggregateBytes: nemotron.aggregateBytes,
    patchBytes: nemotron.patchBytes,
    documentBytes: nemotron.documentBytes,
  });
  const nativePreflights = [];
  for (const compositionId of NATIVE_COMPOSITIONS) {
    nativePreflights.push(await runner.preflightNativeComposition({ compositionId }));
  }
  const nemotronReceipt = await runner.commitFreshNemotronAttempt({
    attemptId: attemptIds[0]!,
    authority: nemotronAuthority,
  });
  attempts.push(nemotronReceipt);
  await persistAttemptReceipt(request.campaignRoot, nemotronReceipt);

  for (let index = 0; index < nativePreflights.length; index += 1) {
    const preflightAuthority = nativePreflights[index]!;
    const receipt = await runner.runNativeAttempt({
      attemptId: attemptIds[index + 1]!,
      preflightAuthority,
    });
    attempts.push(receipt);
    await persistAttemptReceipt(request.campaignRoot, receipt);
  }

  const blindBatch = await runner.openBlindBatch({ attempts });
  const proxyArtifacts: string[] = [];
  for (;;) {
    const next = runner.nextBlindRolePacket(blindBatch);
    if (!next) break;
    if (proxyArtifacts.length >= attempts.length * NATIVE_PILOT_EVALUATION_ROLES.length) {
      fail("proxy-evidence-invalid");
    }
    const bytes = createHostProxyRoleResult(next.packet);
    runner.admitBlindRoleResult({ authority: next.authority, bytes });
    proxyArtifacts.push(
      await persistProxyResult(request.campaignRoot, next.packet.outputId, next.packet.role, bytes),
    );
  }
  const report = await runner.assembleCrossHarnessPilotReport(blindBatch);
  assertPilotReportShape(report);
  await persistPrivateJson(request.campaignRoot, "report.json", report);
  const attemptArtifacts = attempts
    .map((attempt) => `attempt-receipts/${attempt.receiptSha256}.json`)
    .sort();
  const result: PilotCampaignCliResultV1 = {
    schemaVersion: 1,
    kind: "docsfab-pilot-campaign-cli-result/v1",
    status: "completed",
    evidenceClass: "development-only-uncontained",
    fixtureSha256: runner.fixtureSha256,
    attemptReceiptSha256s: attempts.map((attempt) => attempt.receiptSha256).sort(),
    proxyArtifactCount: proxyArtifacts.length,
    proxyEvidenceClass: "unattested-agent-proxy",
    reportSha256: report.reportSha256,
    qualityComparisonStatus: report.qualityComparisonStatus,
    commonEvaluationEstablished: false,
    reliability: {
      succeeded: attempts.filter((attempt) => attempt.status === "succeeded").length,
      failed: attempts.filter((attempt) => attempt.status === "failed").length,
    },
    ranking: { winnerCompositionId: null },
    artifacts: {
      attemptReceipts: attemptArtifacts,
      proxyResults: [...proxyArtifacts].sort(),
      report: "report.json",
    },
    technicalApproval: "not-established",
    roleQualification: "not-established",
    releaseEligible: false,
  };
  await persistPrivateJson(request.campaignRoot, "campaign-result.json", result);
  log(
    request.json
      ? JSON.stringify(result, null, 2)
      : renderCliPresentation(projectPilotCampaignResult(result)).stdout.trimEnd(),
  );
  return result;
}

async function loadDefaultCorpus(): Promise<{
  readonly authority: InstalledNativePilotCorpusAuthority;
  readonly corpus: BoundNativePilotCorpus;
}> {
  const loaded = await loadInstalledNativePilotCorpusAuthority();
  return {
    authority: loaded.authority,
    corpus: resolveInstalledNativePilotCorpus({
      authority: loaded.authority,
      corpusId: "routing-task-guide-v1",
    }),
  };
}

function assertNemotronFreshness(
  corpus: BoundNativePilotCorpus,
  artifacts: NemotronPilotArtifacts,
): void {
  if (
    artifacts.freshness.sourceRevision !== corpus.repositoryRevision ||
    artifacts.freshness.sourceGitTree !== corpus.repositoryGitTree ||
    artifacts.freshness.contextPacketSha256s.length < 1 ||
    artifacts.freshness.contextPacketSha256s.length > corpus.runtimeBindings.skills.length ||
    artifacts.freshness.contextPacketSha256s.some((digest) => !SHA256_PATTERN.test(digest)) ||
    artifacts.freshness.skillBundleSha256s.length !==
      artifacts.freshness.contextPacketSha256s.length ||
    artifacts.freshness.skillBundleSha256s.some(
      (digest, index) => digest !== corpus.runtimeBindings.skills[index]?.bundleSha256,
    ) ||
    artifacts.freshness.toolPolicySha256s.length !==
      artifacts.freshness.contextPacketSha256s.length ||
    artifacts.freshness.toolPolicySha256s.some(
      (digest, index) => digest !== corpus.runtimeBindings.skills[index]?.toolPolicySha256,
    )
  ) {
    fail("nemotron-freshness");
  }
}

async function validateForbiddenRoots(
  requested: readonly [string, string],
  installedRoot: string,
  sourceRoot: string,
): Promise<readonly [string, string]> {
  const observed = await Promise.all(requested.map(canonicalExistingRoot));
  const expected = [installedRoot, await canonicalExistingRoot(sourceRoot)].sort();
  if (JSON.stringify([...observed].sort()) !== JSON.stringify(expected)) {
    fail("forbidden-root-mismatch");
  }
  return [observed[0]!, observed[1]!];
}

async function canonicalExistingRoot(value: string): Promise<string> {
  if (!isAbsolute(value) || resolve(value) !== value || value.includes("\0")) {
    fail("forbidden-root-mismatch");
  }
  try {
    const canonical = await realpath(value);
    const metadata = await lstat(canonical);
    if (canonical !== value || metadata.isSymbolicLink() || !metadata.isDirectory()) {
      fail("forbidden-root-mismatch");
    }
    return canonical;
  } catch (error) {
    if (error instanceof PilotCampaignCliError) throw error;
    fail("forbidden-root-mismatch");
  }
}

async function prepareDefaultDurableReplayRoot(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly campaignRoot: string;
}): Promise<string> {
  const stateDirectory = resolveDocsFabStateDirectory(input.environment);
  const root = resolve(dirname(stateDirectory), "native-pilot-replay");
  if (overlaps(root, input.campaignRoot)) fail("replay-root-invalid");
  try {
    await mkdir(root, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await chmod(root, PRIVATE_DIRECTORY_MODE);
    const canonical = await realpath(root);
    const metadata = await lstat(canonical);
    const owner = process.getuid?.() ?? metadata.uid;
    if (
      canonical !== root ||
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      metadata.uid !== owner ||
      (metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
    ) {
      fail("replay-root-invalid");
    }
    return canonical;
  } catch (error) {
    if (error instanceof PilotCampaignCliError) throw error;
    fail("replay-root-invalid");
  }
}

async function requirePrivateReplayRoot(value: string): Promise<string> {
  try {
    const canonical = await realpath(value);
    const metadata = await lstat(canonical);
    const owner = process.getuid?.() ?? metadata.uid;
    if (
      canonical !== value ||
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      metadata.uid !== owner ||
      (metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
    ) {
      fail("replay-root-invalid");
    }
    return canonical;
  } catch (error) {
    if (error instanceof PilotCampaignCliError) throw error;
    fail("replay-root-invalid");
  }
}

async function observeGitTree(sourceRoot: string, revision: string): Promise<string> {
  try {
    const result = await execFileAsync(
      "/usr/bin/git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-C",
        sourceRoot,
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${revision}^{tree}`,
      ],
      {
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 64 * 1024,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: "/dev/null",
          LANG: "C",
          LC_ALL: "C",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    );
    const tree = result.stdout.trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(tree)) fail("nemotron-freshness");
    return tree;
  } catch (error) {
    if (error instanceof PilotCampaignCliError) throw error;
    fail("nemotron-freshness");
  }
}

function overlaps(left: string, right: string): boolean {
  return left === right || inside(left, right) || inside(right, left);
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** Strictly open the three Nemotron inputs and derive canonical embedded evidence bytes. */
export async function loadNemotronPilotArtifacts(input: {
  readonly recordPath: string;
  readonly patchPath: string | null;
  readonly documentPath: string | null;
  readonly workflow?: WorkflowDefinition;
  readonly workflowIdentity?: { readonly id: string; readonly sourceSha256: string };
}): Promise<NemotronPilotArtifacts> {
  const runRecordBytes = await readPrivateInputFile(input.recordPath, MAX_INPUT_ARTIFACT_BYTES);
  const observedPatchBytes =
    input.patchPath === null
      ? null
      : await readPrivateInputFile(input.patchPath, MAX_INPUT_ARTIFACT_BYTES, true);
  const patchBytes = observedPatchBytes?.byteLength ? observedPatchBytes : null;
  const documentBytes =
    patchBytes === null
      ? null
      : input.documentPath === null
        ? null
        : await readPrivateInputFile(input.documentPath, MAX_INPUT_ARTIFACT_BYTES);
  try {
    const record = decodeNativePilotNemotronRunRecord(
      parseJsonEvidence(runRecordBytes),
      input.workflow,
      input.workflowIdentity,
    );
    if (!record.compositionExecution) fail("artifact-invalid");
    const executionEvidence = parseCompositionExecutionEvidence(record.compositionExecution);
    const aggregate = record.compositionExecutionAggregate
      ? parseCompositionExecutionAggregate(record.compositionExecutionAggregate)
      : null;
    const sourceRoot = await canonicalExistingRoot(record.repository.sourcePath);
    const sourceGitTree = await observeGitTree(sourceRoot, record.repository.revision);
    const terminalSteps = record.steps.filter((step) => step.status !== "pending");
    const contextPacketSha256s = terminalSteps.map((step) => {
      const context = step.contextPreflight;
      if (!context || !("packetDigest" in context) || typeof context.packetDigest !== "string") {
        fail("artifact-invalid");
      }
      return context.packetDigest;
    });
    const skillBundleSha256s = terminalSteps.map((step) => {
      const digest = step.skillEvidence?.bundleSha256;
      if (typeof digest !== "string") fail("artifact-invalid");
      return digest;
    });
    const toolPolicySha256s = terminalSteps.map((step) => {
      const policy = step.skillEvidence?.toolPolicy;
      if (!policy) fail("artifact-invalid");
      return canonicalDigest(policy);
    });
    const freshnessBody = {
      runRecordSha256: canonicalDigest(record),
      compositionEvidenceSha256: executionEvidence.evidenceSha256,
      aggregateSha256: aggregate?.aggregateSha256 ?? null,
      patchSha256: patchBytes === null ? null : sha256(patchBytes),
      documentSha256: documentBytes === null ? null : sha256(documentBytes),
      sourceRootSha256: canonicalDigest(sourceRoot),
      sourceRevision: record.repository.revision,
      sourceGitTree,
      contextPacketSha256s,
      skillBundleSha256s,
      toolPolicySha256s,
    };
    return {
      runRecordBytes,
      compositionEvidenceBytes: Buffer.from(canonicalJson(executionEvidence), "utf8"),
      aggregateBytes: aggregate === null ? null : Buffer.from(canonicalJson(aggregate), "utf8"),
      patchBytes,
      documentBytes,
      sourceRoot,
      freshness: {
        ...freshnessBody,
        evidenceSha256: canonicalDigest(freshnessBody),
      },
    };
  } catch (error) {
    if (error instanceof PilotCampaignCliError) throw error;
    fail("artifact-invalid");
  }
}

/** Create one role-bound host proxy result from already-blinded deterministic evidence. */
export function createHostProxyRoleResult(packet: NativePilotBlindRolePacket): Buffer {
  const evaluation = jsonObject(packet.deterministicEvaluation);
  const journey = jsonObject(packet.journeyEvidence);
  if (
    evaluation.kind !== "docsfab-routing-document-evaluation" ||
    journey.kind !== "docsfab-routing-clean-journey-result" ||
    evaluation.pageSha256 !== packet.documentSha256 ||
    journey.pageSha256 !== packet.documentSha256
  ) {
    fail("proxy-evidence-invalid");
  }
  const checks = evaluationChecks(evaluation.checks);
  const journeyMetrics = objectValue(journey.metrics);
  const taskSuccess = booleanValue(journey.taskSuccess);
  const recoverySuccess = booleanValue(journey.recoverySuccess);
  if (packet.evidenceClass !== "unattested-agent-proxy") fail("proxy-evidence-invalid");
  const evaluatorExecutionIdentitySha256 = canonicalDigest({
    kind: "docsfab-host-derived-proxy-evaluator-execution",
    role: packet.role,
    outputId: packet.outputId,
    documentSha256: packet.documentSha256,
    evaluationContextSha256: packet.evaluationContextSha256,
    evidenceClass: packet.evidenceClass,
    deterministicEvaluationSha256: canonicalDigest(evaluation),
    journeyEvidenceSha256: canonicalDigest(journey),
  });
  const artifact = {
    schemaVersion: 1,
    kind: NATIVE_PILOT_ROLE_RESULT_KIND,
    role: packet.role,
    outputId: packet.outputId,
    documentSha256: packet.documentSha256,
    evaluationContextSha256: packet.evaluationContextSha256,
    evidenceClass: "unattested-agent-proxy",
    evaluatorExecutionIdentitySha256,
    payload: proxyPayload(packet.role, {
      evaluation,
      checks,
      taskSuccess,
      recoverySuccess,
      journey,
      journeyMetrics,
    }),
  };
  return Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

interface ProxyInputs {
  readonly evaluation: Record<string, unknown>;
  readonly checks: readonly {
    id: string;
    status: "passed" | "failed" | "unavailable";
    hardGate: boolean;
  }[];
  readonly taskSuccess: boolean;
  readonly recoverySuccess: boolean;
  readonly journey: Record<string, unknown>;
  readonly journeyMetrics: Record<string, unknown>;
}

function proxyPayload(
  role: NativePilotEvaluationRole,
  input: ProxyInputs,
): Record<string, unknown> {
  if (role === "technical") {
    const relevant = input.checks.filter((check) => check.id.startsWith("ROUTE-L1-"));
    return reviewPayload(relevant, true);
  }
  if (role === "editorial") {
    const ids = new Set(["ROUTE-L1-009", "ROUTE-L2-001", "ROUTE-L2-002", "ROUTE-L3-001"]);
    return reviewPayload(
      input.checks.filter((check) => ids.has(check.id)),
      false,
    );
  }
  if (role === "audience") {
    return {
      evidenceStatus: "agent-proxy",
      taskSuccess: input.taskSuccess,
      recoverySuccess: input.recoverySuccess,
      steps: arrayValue(input.journey.steps).length,
      deadEnds: nonnegativeInteger(input.journeyMetrics.deadEnds),
    };
  }
  if (role === "layered") return layeredProxyPayload(input.evaluation);
  return qualityProxyPayload(input);
}

function reviewPayload(
  checks: readonly { status: "passed" | "failed" | "unavailable"; hardGate: boolean }[],
  hardGateIsCritical: boolean,
): Record<string, unknown> {
  const failed = checks.filter((check) => check.status === "failed");
  const unavailable = checks.some((check) => check.status === "unavailable");
  return {
    decision: failed.length > 0 ? "fail" : unavailable ? "human-review" : "pass",
    criticalFindings: hardGateIsCritical ? failed.filter((check) => check.hardGate).length : 0,
    majorFindings: hardGateIsCritical
      ? failed.filter((check) => !check.hardGate).length
      : failed.length,
    minorFindings: 0,
  };
}

function layeredProxyPayload(evaluation: Record<string, unknown>): Record<string, unknown> {
  const layered = objectValue(evaluation.layeredEvaluation);
  const layers = objectValue(layered.layers);
  const trustworthy = layerDecision(layers.trustworthy_information, false);
  const transferable = layerDecision(layers.transferable_understanding, true);
  const effective = layerDecision(layers.effective_experience, true);
  const constraints = objectValue(layered.constraints);
  const constraintsPass = Object.values(constraints).every((value) => {
    const assessment = objectValue(value).assessment;
    return assessment === "met" || assessment === "not-applicable";
  });
  const outcomes = objectValue(layered.outcomes);
  const humanOutcomes = arrayValue(outcomes.human);
  const agentOutcomes = arrayValue(outcomes.agent);
  const outcomesPass =
    humanOutcomes.length > 0 &&
    agentOutcomes.length > 0 &&
    [...humanOutcomes, ...agentOutcomes].every(
      (value) => objectValue(value).outcome === "success" && objectValue(value).verified === true,
    );
  const observedOverall = layered.overall_decision;
  return {
    overallDecision:
      observedOverall === "pass" || observedOverall === "fail"
        ? observedOverall
        : "insufficient-evidence",
    trustworthyInformation: trustworthy,
    transferableUnderstanding: transferable,
    effectiveExperience: effective,
    constraintsStatus: constraintsPass ? "pass" : "insufficient-evidence",
    outcomesStatus: outcomesPass ? "pass" : "insufficient-evidence",
  };
}

function layerDecision(value: unknown, agentQualified: boolean): string {
  const decision = objectValue(value).decision;
  if (decision === "pass") return agentQualified ? "agent-evidence-pass" : "pass";
  if (decision === "fail") return agentQualified ? "agent-evidence-fail" : "fail";
  return "insufficient-evidence";
}

function qualityProxyPayload(input: ProxyInputs): Record<string, unknown> {
  const score = objectValue(input.evaluation.qualityScore);
  const hardGates = objectValue(score.hard_gates);
  const deterministicChecks = input.checks.map((check) => ({
    id: check.id,
    passed: check.status === "passed",
  }));
  const hardGateFailures = Object.values(hardGates).reduce<number>(
    (sum, value) => sum + nonnegativeInteger(value),
    0,
  );
  const taskGuideScore = numberValue(score.total, 0, 100);
  if (score.decision !== "pass" && score.decision !== "fail") {
    fail("proxy-evidence-invalid");
  }
  return {
    decision: score.decision,
    taskGuideScore,
    hardGateFailures,
    deterministicChecks,
  };
}

function evaluationChecks(value: unknown): readonly {
  id: string;
  status: "passed" | "failed" | "unavailable";
  hardGate: boolean;
}[] {
  const checks = arrayValue(value).map((entry) => {
    const check = objectValue(entry);
    if (
      typeof check.id !== "string" ||
      !["passed", "failed", "unavailable"].includes(String(check.status)) ||
      typeof check.hardGate !== "boolean"
    ) {
      fail("proxy-evidence-invalid");
    }
    return {
      id: check.id,
      status: check.status as "passed" | "failed" | "unavailable",
      hardGate: check.hardGate,
    };
  });
  if (checks.length !== 17 || new Set(checks.map((check) => check.id)).size !== 17) {
    fail("proxy-evidence-invalid");
  }
  return checks;
}

function jsonObject(bytes: Buffer): Record<string, unknown> {
  try {
    return objectValue(parseJsonEvidence(bytes));
  } catch (error) {
    if (error instanceof PilotCampaignCliError) throw error;
    fail("proxy-evidence-invalid");
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("proxy-evidence-invalid");
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown): unknown[] {
  if (!Array.isArray(value)) fail("proxy-evidence-invalid");
  return value;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") fail("proxy-evidence-invalid");
  return value;
}

function nonnegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail("proxy-evidence-invalid");
  return value as number;
}

function numberValue(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail("proxy-evidence-invalid");
  }
  return value;
}

function requireRandomBytes(value: Buffer, size: number): Buffer {
  if (!Buffer.isBuffer(value) || value.byteLength !== size) fail("campaign-failed");
  return Buffer.from(value);
}

function opaqueAttemptId(random: (size: number) => Buffer): string {
  return `attempt-${requireRandomBytes(random(16), 16).toString("hex")}`;
}

async function requireEmptyPrivateCampaignRoot(value: string): Promise<void> {
  try {
    const canonical = await realpath(value);
    const metadata = await lstat(canonical);
    const owner = process.getuid?.() ?? metadata.uid;
    if (
      canonical !== value ||
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      metadata.uid !== owner ||
      (metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
      (await readdir(canonical)).length !== 0
    ) {
      fail("campaign-root-invalid");
    }
  } catch (error) {
    if (error instanceof PilotCampaignCliError) throw error;
    fail("campaign-root-invalid");
  }
}

async function readPrivateInputFile(
  path: string,
  maximum: number,
  allowEmpty = false,
): Promise<Buffer> {
  try {
    const canonical = await realpath(path);
    const before = await lstat(canonical);
    const owner = process.getuid?.() ?? before.uid;
    if (
      canonical !== path ||
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== owner ||
      (before.mode & 0o077) !== 0 ||
      (!allowEmpty && before.size < 1) ||
      before.size > maximum
    ) {
      fail("artifact-invalid");
    }
    const bytes = await readFile(canonical);
    const after = await lstat(canonical);
    assertSameFile(before, after);
    return bytes;
  } catch (error) {
    if (error instanceof PilotCampaignCliError) throw error;
    fail("artifact-invalid");
  }
}

function assertSameFile(before: Stats, after: Stats): void {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    fail("artifact-invalid");
  }
}

async function persistAttemptReceipt(
  campaignRoot: string,
  receipt: NativePilotAttemptReceiptV1,
): Promise<string> {
  if (receipt.kind !== NATIVE_PILOT_ATTEMPT_RECEIPT_KIND) fail("persistence-failed");
  const path = `attempt-receipts/${receipt.receiptSha256}.json`;
  await persistPrivateJson(campaignRoot, path, receipt);
  return path;
}

async function persistProxyResult(
  campaignRoot: string,
  outputId: string,
  role: NativePilotEvaluationRole,
  bytes: Buffer,
): Promise<string> {
  if (
    !/^candidate-[a-f0-9]{24}$/u.test(outputId) ||
    !NATIVE_PILOT_EVALUATION_ROLES.includes(role)
  ) {
    fail("persistence-failed");
  }
  const path = `proxy-results/${outputId}/${role}.json`;
  await persistPrivateBytes(campaignRoot, path, bytes);
  return path;
}

async function persistPrivateJson(
  campaignRoot: string,
  path: string,
  value: unknown,
): Promise<void> {
  await persistPrivateBytes(
    campaignRoot,
    path,
    Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
  );
}

async function persistPrivateBytes(
  campaignRoot: string,
  path: string,
  bytes: Buffer,
): Promise<void> {
  const destination = safeCampaignPath(campaignRoot, path);
  const directory = resolve(destination, "..");
  const temporary = `${destination}.tmp`;
  try {
    await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await chmod(directory, PRIVATE_DIRECTORY_MODE);
    await writeFile(temporary, bytes, { flag: "wx", mode: PRIVATE_FILE_MODE });
    await link(temporary, destination);
    await rm(temporary);
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined);
    fail("persistence-failed");
  }
}

function safeCampaignPath(root: string, path: string): string {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    fail("persistence-failed");
  }
  const candidate = resolve(root, path);
  const scoped = relative(root, candidate);
  if (scoped === ".." || scoped.startsWith(`..${sep}`) || isAbsolute(scoped)) {
    fail("persistence-failed");
  }
  return candidate;
}

export function assertPilotReportShape(report: CrossHarnessPilotReportV1): void {
  const { reportSha256, ...body } = report;
  if (
    report.kind !== CROSS_HARNESS_PILOT_REPORT_KIND ||
    report.evidenceClass !== "development-only-uncontained" ||
    report.commonEvaluationEstablished !== false ||
    report.qualityComparisonStatus !== "proxy-evaluation-incomplete" ||
    report.comparisons.some((comparison) => comparison.outputBarMet) ||
    report.ranking.winnerCompositionId !== null ||
    report.releaseEligible !== false ||
    canonicalDigest(body) !== reportSha256
  ) {
    fail("campaign-failed");
  }
}
