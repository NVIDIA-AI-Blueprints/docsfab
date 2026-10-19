// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHmac } from "node:crypto";
import { dirname, join } from "node:path";

import { canonicalDigest, createHostAuthorityFactory, deepFreeze } from "../contract-kit/index.js";
import { parseJsonEvidence } from "../json-evidence.js";
import { documentationAuditSearch } from "../maturity/audit-search-plan.js";
import { detectCredentialRuleIdsInValue } from "../security/repository-scanner.js";
import { NATIVE_PILOT_EVIDENCE_CLASS } from "./pilot-contracts.js";
import { documentationObservationSearch } from "../search/observation-search-plan.js";
import { NATIVE_PILOT_COMPOSITION_IDS, NATIVE_PILOT_CORPUS_PATHS } from "./pilot-corpus.js";
import { fail } from "./pilot-runner-error.js";
import {
  SHA256,
  MAX_HOST_STDERR_BYTES,
  MAX_HOST_STDOUT_BYTES,
  assertRunnerNewWritePath,
  boundedNumber,
  compareText,
  decodeUtf8,
  ensureRunnerPrivateDirectory,
  enumeration,
  exactKeys,
  hostEnvironment,
  identifier,
  nonnegativeInteger,
  persistPrivateBytesSync,
  readPrivateArtifact,
  runBoundedHostProcess,
  safeJoin,
  sha256,
  strictObject,
} from "./pilot-paths.js";
import { verifyCopiedKit } from "./pilot-repository.js";
import {
  CROSS_HARNESS_PILOT_REPORT_KIND,
  NATIVE_PILOT_EVALUATION_ROLES,
  NATIVE_PILOT_ROLE_RESULT_KIND,
  ROUTING_CHECK_IDS,
} from "./pilot-runner-constants.js";
import {
  attemptAuthorities,
  buildPrivateArtifactLedger,
  kit,
  reattestAttempt,
} from "./pilot-attempt.js";
import type {
  AttemptPrivateState,
  BlindBatchState,
  BlindEntryState,
  BlindRoleState,
  CrossHarnessPilotReportV1,
  EvaluationPrivateState,
  NativePilotAttemptReceiptV1,
  NativePilotBlindBatchAuthority,
  NativePilotBlindRoleAuthority,
  NativePilotBlindRolePacket,
  NativePilotEvaluationRole,
  NativePilotRunner,
  NormalizedRoleResult,
  PrivateArtifactLedgerEntry,
  RunnerState,
} from "./pilot-runner.js";

const blindBatchAuthorities = createHostAuthorityFactory<
  "docsfab-native-pilot-blind-batch-authority",
  BlindBatchState
>({
  kind: "docsfab-native-pilot-blind-batch-authority",
  invalidMessage: "invalid-native-pilot-blind-batch-verifier",
});
const blindRoleAuthorities = createHostAuthorityFactory<
  "docsfab-native-pilot-blind-role-authority",
  BlindRoleState
>({
  kind: "docsfab-native-pilot-blind-role-authority",
  invalidMessage: "invalid-native-pilot-blind-role-verifier",
});

export async function openBlindBatch(
  state: RunnerState,
  input: { readonly attempts: readonly NativePilotAttemptReceiptV1[] },
): Promise<NativePilotBlindBatchAuthority> {
  if (state.evaluationOpened || input.attempts.length !== NATIVE_PILOT_COMPOSITION_IDS.length) {
    fail("attempt-set-mismatch");
  }
  const attempts = input.attempts.map((receipt) => {
    const privateState = attemptAuthorities.get(receipt);
    if (
      !privateState?.verifyCurrent() ||
      privateState.runner !== state.runnerKey ||
      privateState.consumed ||
      privateState.receipt.receiptSha256 !== receipt.receiptSha256 ||
      receipt.fixtureSha256 !== state.corpus.fixtureSha256
    ) {
      fail("attempt-replay");
    }
    return privateState;
  });
  await Promise.all(attempts.map((attempt) => reattestAttempt(state, attempt)));
  const compositionIds = attempts.map((attempt) => attempt.receipt.compositionId).sort();
  if (canonicalDigest(compositionIds) !== canonicalDigest([...NATIVE_PILOT_COMPOSITION_IDS])) {
    fail("attempt-set-mismatch");
  }
  const authorIdentities = attempts.flatMap((attempt) => attempt.authorIdentities);
  if (new Set(authorIdentities).size !== authorIdentities.length) fail("session-replay");
  state.evaluationOpened = true;
  const evaluationRoot = join(state.campaignRoot, "evaluations");
  await assertRunnerNewWritePath(state, evaluationRoot);
  await ensureRunnerPrivateDirectory(state, evaluationRoot, false);
  const successful = attempts.filter(
    (attempt) => attempt.receipt.status === "succeeded" && attempt.documentBytes !== null,
  );
  const entries = await Promise.all(
    successful.map(async (attempt) => {
      const outputId = `candidate-${blindDigest(state, `output:${attempt.receipt.receiptSha256}`).slice(0, 24)}`;
      const orderSha256 = blindDigest(state, `order:${outputId}`);
      const evidence = await runCandidateEvaluation(state, attempt, outputId);
      const evaluationContextSha256 = canonicalDigest({
        fixtureSha256: state.corpus.fixtureSha256,
        sourceFixtureSha256: state.corpus.sourceFixtureSha256,
        rubricSha256: state.corpus.bindings.rubricSha256,
        checkerSha256: state.corpus.bindings.checkerSha256,
        sourceBundleSha256: state.corpus.bindings.sourceBundleSha256,
        qualityPackSha256: state.corpus.bindings.qualityPackSha256,
        profileSha256: state.corpus.bindings.profileSha256,
        audienceScenarioSha256: state.corpus.bindings.audienceScenarioSha256,
        documentSha256: attempt.receipt.documentSha256,
        journeySha256: sha256(evidence.journeyEvidence),
        deterministicEvaluationSha256: sha256(evidence.deterministicEvaluation),
      });
      return {
        attempt,
        outputId,
        orderSha256,
        ...evidence,
        evaluationContextSha256,
        roleIndex: 0,
        pending: null,
        roleResults: [],
        evaluation: null,
      } satisfies BlindEntryState;
    }),
  );
  entries.sort((left, right) => left.orderSha256.localeCompare(right.orderSha256));
  const batchAttestationSha256 = canonicalDigest({
    campaignNonceSha256: state.campaignNonceSha256,
    attempts: attempts.map((attempt) => attempt.receipt.receiptSha256),
    entries: entries.map((entry) => ({
      outputId: entry.outputId,
      orderSha256: entry.orderSha256,
      evaluationContextSha256: entry.evaluationContextSha256,
      evidenceClass: "unattested-agent-proxy",
      journeySha256: sha256(entry.journeyEvidence),
      deterministicEvaluationSha256: sha256(entry.deterministicEvaluation),
      journeyPathSha256: sha256(Buffer.from(entry.journeyPath)),
      deterministicEvaluationPathSha256: sha256(Buffer.from(entry.deterministicEvaluationPath)),
      evaluationArtifactLedgerSha256: canonicalDigest(entry.evaluationArtifactLedger),
    })),
  });
  const batch: BlindBatchState = {
    runner: state.runnerKey,
    attempts,
    entries,
    entryIndex: 0,
    consumed: false,
    reportCreated: false,
    attestationSha256: batchAttestationSha256,
    verifyCurrent: () =>
      batchAttestationSha256 ===
      canonicalDigest({
        campaignNonceSha256: state.campaignNonceSha256,
        attempts: batch.attempts.map((attempt) => attempt.receipt.receiptSha256),
        entries: batch.entries.map((entry) => ({
          outputId: entry.outputId,
          orderSha256: entry.orderSha256,
          evaluationContextSha256: entry.evaluationContextSha256,
          evidenceClass: "unattested-agent-proxy",
          journeySha256: sha256(entry.journeyEvidence),
          deterministicEvaluationSha256: sha256(entry.deterministicEvaluation),
          journeyPathSha256: sha256(Buffer.from(entry.journeyPath)),
          deterministicEvaluationPathSha256: sha256(Buffer.from(entry.deterministicEvaluationPath)),
          evaluationArtifactLedgerSha256: canonicalDigest(entry.evaluationArtifactLedger),
        })),
      }),
  };
  return blindBatchAuthorities.create(batch) as NativePilotBlindBatchAuthority;
}

export function nextBlindRolePacket(
  state: RunnerState,
  authority: NativePilotBlindBatchAuthority,
): {
  readonly authority: NativePilotBlindRoleAuthority;
  readonly packet: NativePilotBlindRolePacket;
} | null {
  const batch = blindBatchAuthorities.lookup(authority);
  if (!batch?.verifyCurrent() || batch.runner !== state.runnerKey || batch.consumed) {
    fail("evaluation-replay");
  }
  const entry = batch.entries[batch.entryIndex];
  if (!entry) return null;
  if (entry.pending !== null) fail("campaign-phase-invalid");
  const role = NATIVE_PILOT_EVALUATION_ROLES[entry.roleIndex];
  if (!role) {
    if (entry.evaluation === null) fail("campaign-phase-invalid");
    batch.entryIndex += 1;
    return nextBlindRolePacket(state, authority);
  }
  const roleAttestationSha256 = canonicalDigest({
    batchAttestationSha256: batch.attestationSha256,
    outputId: entry.outputId,
    role,
    roleIndex: entry.roleIndex,
  });
  const roleState: BlindRoleState = {
    batch,
    entry,
    role,
    attestationSha256: roleAttestationSha256,
    consumed: false,
    verifyCurrent: () =>
      roleAttestationSha256 ===
      canonicalDigest({
        batchAttestationSha256: roleState.batch.attestationSha256,
        outputId: roleState.entry.outputId,
        role: roleState.role,
        roleIndex: roleState.entry.roleIndex,
      }),
  };
  const roleAuthority = blindRoleAuthorities.create(roleState) as NativePilotBlindRoleAuthority;
  entry.pending = roleState;
  return {
    authority: roleAuthority,
    packet: Object.freeze({
      role,
      outputId: entry.outputId,
      fixtureSha256: state.corpus.fixtureSha256,
      documentSha256: entry.attempt.receipt.documentSha256!,
      evaluationContextSha256: entry.evaluationContextSha256,
      evidenceClass: "unattested-agent-proxy",
      compositionVisible: false,
      document: Buffer.from(entry.attempt.documentBytes!),
      journeyEvidence: Buffer.from(entry.journeyEvidence),
      deterministicEvaluation: Buffer.from(entry.deterministicEvaluation),
    }),
  };
}

export function admitBlindRoleResult(
  state: RunnerState,
  input: { readonly authority: NativePilotBlindRoleAuthority; readonly bytes: Buffer },
): unknown {
  const roleState = blindRoleAuthorities.lookup(input.authority);
  if (
    !roleState?.verifyCurrent() ||
    roleState.batch.runner !== state.runnerKey ||
    roleState.consumed ||
    roleState.entry.pending !== roleState
  ) {
    fail("evaluation-replay");
  }
  roleState.consumed = true;
  const normalized = parseRoleResult(input.bytes, roleState);
  const artifactPath = safeJoin(
    state.campaignRoot,
    `evaluations/${roleState.entry.outputId}/roles/${String(roleState.entry.roleIndex + 1).padStart(2, "0")}-${roleState.role}.json`,
  );
  persistPrivateBytesSync(state, artifactPath, input.bytes);
  const authorIdentities = roleState.batch.attempts.flatMap((attempt) => attempt.authorIdentities);
  if (
    authorIdentities.includes(normalized.evaluatorExecutionIdentitySha256) ||
    state.evaluatorSessions.has(normalized.evaluatorExecutionIdentitySha256)
  ) {
    fail("review-independence-failed");
  }
  state.evaluatorSessions.add(normalized.evaluatorExecutionIdentitySha256);
  roleState.entry.roleResults.push({ ...normalized, artifactPath });
  roleState.entry.roleIndex += 1;
  roleState.entry.pending = null;
  if (roleState.entry.roleIndex === NATIVE_PILOT_EVALUATION_ROLES.length) {
    roleState.entry.evaluation = finishEvaluation(roleState.entry);
  }
  return deepFreeze({
    role: normalized.role,
    outputId: roleState.entry.outputId,
    roleResultSha256: normalized.roleResultSha256,
  });
}

export function parseRoleResult(bytes: Buffer, state: BlindRoleState): NormalizedRoleResult {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.byteLength < 1 ||
    bytes.byteLength > 1024 * 1024 ||
    detectCredentialRuleIdsInValue(decodeUtf8(bytes)).length > 0
  ) {
    fail("evaluation-binding-mismatch");
  }
  let value: Record<string, unknown>;
  try {
    value = strictObject(parseJsonEvidence(bytes));
  } catch {
    fail("evaluation-binding-mismatch");
  }
  exactKeys(value, [
    "schemaVersion",
    "kind",
    "role",
    "outputId",
    "documentSha256",
    "evaluationContextSha256",
    "evidenceClass",
    "evaluatorExecutionIdentitySha256",
    "payload",
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.kind !== NATIVE_PILOT_ROLE_RESULT_KIND ||
    value.role !== state.role ||
    value.outputId !== state.entry.outputId ||
    value.documentSha256 !== state.entry.attempt.receipt.documentSha256 ||
    value.evaluationContextSha256 !== state.entry.evaluationContextSha256 ||
    value.evidenceClass !== "unattested-agent-proxy" ||
    typeof value.evaluatorExecutionIdentitySha256 !== "string" ||
    !SHA256.test(value.evaluatorExecutionIdentitySha256)
  ) {
    fail("evaluation-binding-mismatch");
  }
  const payload = normalizeRolePayload(state.role, value.payload);
  if (state.role === "quality") assertQualityRoleBinding(state.entry, payload);
  const artifactSha256 = sha256(bytes);
  const roleResultSha256 = canonicalDigest({
    role: state.role,
    outputId: state.entry.outputId,
    documentSha256: state.entry.attempt.receipt.documentSha256,
    evaluationContextSha256: state.entry.evaluationContextSha256,
    evidenceClass: "unattested-agent-proxy",
    evaluatorExecutionIdentitySha256: value.evaluatorExecutionIdentitySha256,
    payload,
    artifactSha256,
  });
  return deepFreeze({
    role: state.role,
    evaluatorExecutionIdentitySha256: value.evaluatorExecutionIdentitySha256,
    evidenceClass: "unattested-agent-proxy",
    payload,
    artifactSha256,
    roleResultSha256,
    artifactPath: "pending-host-admission",
    artifactMode: 0o600,
  });
}

export function normalizeRolePayload(
  role: NativePilotEvaluationRole,
  value: unknown,
): Record<string, unknown> {
  const payload = strictObject(value);
  if (role === "technical" || role === "editorial") {
    exactKeys(payload, ["decision", "criticalFindings", "majorFindings", "minorFindings"]);
    const decision = enumeration(payload.decision, ["pass", "fail", "human-review"]);
    return {
      decision,
      criticalFindings: nonnegativeInteger(payload.criticalFindings),
      majorFindings: nonnegativeInteger(payload.majorFindings),
      minorFindings: nonnegativeInteger(payload.minorFindings),
    };
  }
  if (role === "audience") {
    exactKeys(payload, ["evidenceStatus", "taskSuccess", "recoverySuccess", "steps", "deadEnds"]);
    if (
      payload.evidenceStatus !== "agent-proxy" ||
      typeof payload.taskSuccess !== "boolean" ||
      typeof payload.recoverySuccess !== "boolean"
    ) {
      fail("evaluation-binding-mismatch");
    }
    return {
      evidenceStatus: "agent-proxy",
      taskSuccess: payload.taskSuccess,
      recoverySuccess: payload.recoverySuccess,
      steps: nonnegativeInteger(payload.steps),
      deadEnds: nonnegativeInteger(payload.deadEnds),
    };
  }
  if (role === "layered") {
    exactKeys(payload, [
      "overallDecision",
      "trustworthyInformation",
      "transferableUnderstanding",
      "effectiveExperience",
      "constraintsStatus",
      "outcomesStatus",
    ]);
    return {
      overallDecision: enumeration(payload.overallDecision, [
        "pass",
        "fail",
        "insufficient-evidence",
      ]),
      trustworthyInformation: enumeration(payload.trustworthyInformation, ["pass", "fail"]),
      transferableUnderstanding: enumeration(payload.transferableUnderstanding, [
        "agent-evidence-pass",
        "agent-evidence-fail",
        "insufficient-evidence",
      ]),
      effectiveExperience: enumeration(payload.effectiveExperience, [
        "agent-evidence-pass",
        "agent-evidence-fail",
        "insufficient-evidence",
      ]),
      constraintsStatus: enumeration(payload.constraintsStatus, ["pass", "insufficient-evidence"]),
      outcomesStatus: enumeration(payload.outcomesStatus, ["pass", "insufficient-evidence"]),
    };
  }
  exactKeys(payload, ["decision", "taskGuideScore", "hardGateFailures", "deterministicChecks"]);
  if (!Array.isArray(payload.deterministicChecks) || payload.deterministicChecks.length !== 17) {
    fail("evaluation-binding-mismatch");
  }
  const deterministicChecks = payload.deterministicChecks.map((value) => {
    const check = strictObject(value);
    exactKeys(check, ["id", "passed"]);
    if (typeof check.id !== "string" || typeof check.passed !== "boolean") {
      fail("evaluation-binding-mismatch");
    }
    return { id: check.id, passed: check.passed };
  });
  if (new Set(deterministicChecks.map((check) => check.id)).size !== 17) {
    fail("evaluation-binding-mismatch");
  }
  if (
    canonicalDigest(deterministicChecks.map((check) => check.id).sort()) !==
    canonicalDigest([...ROUTING_CHECK_IDS].sort())
  ) {
    fail("evaluation-binding-mismatch");
  }
  return {
    decision: enumeration(payload.decision, ["pass", "fail", "human-review"]),
    taskGuideScore: boundedNumber(payload.taskGuideScore, 0, 100),
    hardGateFailures: nonnegativeInteger(payload.hardGateFailures),
    deterministicChecks,
  };
}

export function finishEvaluation(entry: BlindEntryState): EvaluationPrivateState {
  const byRole = Object.fromEntries(entry.roleResults.map((result) => [result.role, result]));
  const technical = byRole.technical!.payload;
  const editorial = byRole.editorial!.payload;
  const audience = byRole.audience!.payload;
  const layered = byRole.layered!.payload;
  const quality = byRole.quality!.payload;
  const checks = quality.deterministicChecks as Array<{ id: string; passed: boolean }>;
  const proxyCandidateBarMet =
    checks.every((check) => check.passed) &&
    quality.hardGateFailures === 0 &&
    (quality.taskGuideScore as number) >= 90 &&
    quality.decision === "pass" &&
    technical.decision === "pass" &&
    technical.criticalFindings === 0 &&
    technical.majorFindings === 0 &&
    editorial.decision === "pass" &&
    editorial.criticalFindings === 0 &&
    editorial.majorFindings === 0 &&
    layered.trustworthyInformation === "pass" &&
    audience.taskSuccess === true &&
    audience.recoverySuccess === true;
  const body = {
    attemptSha256: entry.attempt.receipt.receiptSha256,
    outputId: entry.outputId,
    documentSha256: entry.attempt.receipt.documentSha256!,
    evaluationContextSha256: entry.evaluationContextSha256,
    roleResultSha256s: entry.roleResults.map((result) => result.roleResultSha256),
    evaluatorExecutionIdentitySha256s: entry.roleResults.map(
      (result) => result.evaluatorExecutionIdentitySha256,
    ),
    evaluatorEvidenceClass: "unattested-agent-proxy" as const,
    taskGuideScore: quality.taskGuideScore as number,
    proxyCandidateBarMet,
    outputBarMet: false,
  };
  return deepFreeze({ ...body, evaluationSha256: canonicalDigest(body) });
}

export function assertQualityRoleBinding(
  entry: BlindEntryState,
  payload: Record<string, unknown>,
): void {
  const deterministic = strictObject(parseJsonEvidence(entry.deterministicEvaluation));
  if (!Array.isArray(deterministic.checks)) fail("evaluation-binding-mismatch");
  const expected = new Map(
    deterministic.checks.map((value) => {
      const check = strictObject(value);
      if (typeof check.id !== "string" || typeof check.status !== "string") {
        fail("evaluation-binding-mismatch");
      }
      const passed = check.status === "passed";
      return [check.id, passed] as const;
    }),
  );
  const observed = payload.deterministicChecks as Array<{ id: string; passed: boolean }>;
  if (
    observed.some((check) => expected.get(check.id) !== check.passed) ||
    expected.size !== observed.length
  ) {
    fail("evaluation-binding-mismatch");
  }
  const baseScore = strictObject(deterministic.qualityScore);
  const hardGates = strictObject(baseScore.hard_gates);
  const expectedHardGateFailures = Object.values(hardGates).reduce<number>(
    (sum, value) => sum + nonnegativeInteger(value),
    0,
  );
  if (
    payload.hardGateFailures !== expectedHardGateFailures ||
    payload.taskGuideScore !== baseScore.total ||
    payload.decision !== baseScore.decision
  ) {
    fail("evaluation-binding-mismatch");
  }
}

export async function assembleCrossHarnessPilotReport(
  state: RunnerState,
  authority: NativePilotBlindBatchAuthority,
): Promise<CrossHarnessPilotReportV1> {
  const batch = blindBatchAuthorities.lookup(authority);
  if (!batch?.verifyCurrent() || batch.runner !== state.runnerKey || batch.consumed) {
    fail(batch?.reportCreated ? "report-replay" : "evaluation-replay");
  }
  if (
    batch.entryIndex !== batch.entries.length ||
    batch.entries.some((entry) => entry.pending !== null || entry.evaluation === null)
  ) {
    fail("campaign-phase-invalid");
  }
  await Promise.all(batch.attempts.map((attempt) => reattestAttempt(state, attempt)));
  await Promise.all(batch.entries.map((entry) => reattestBlindEntry(entry)));
  await reattestEvaluationTree(state, batch);
  const body = {
    evidenceClass: NATIVE_PILOT_EVIDENCE_CLASS,
    liveEvidenceEstablished: state.executionEvidenceClass === "live-observed",
    commonEvaluationEstablished: false as const,
    track: "cross-harness-composition-six-step" as const,
    fixtureSha256: state.corpus.fixtureSha256,
    blindingSeedCommitmentSha256: state.blindingSeedCommitmentSha256,
    attemptSha256s: batch.attempts.map((attempt) => attempt.receipt.receiptSha256).sort(),
    evaluationSha256s: batch.entries.map((entry) => entry.evaluation!.evaluationSha256).sort(),
    reviewOrderSha256: canonicalDigest(
      batch.entries.map((entry) => ({ outputId: entry.outputId, orderSha256: entry.orderSha256 })),
    ),
    qualityComparisonStatus: "proxy-evaluation-incomplete" as const,
    comparisons: batch.attempts
      .map((attempt) => {
        const evaluation = batch.entries.find((entry) => entry.attempt === attempt)?.evaluation;
        return {
          compositionId: attempt.receipt.compositionId,
          status: attempt.receipt.status,
          failureCategory: attempt.receipt.failureCategory,
          taskGuideScore: evaluation?.taskGuideScore ?? null,
          outputBarMet: evaluation?.outputBarMet ?? false,
          durationMs: attempt.receipt.durationMs,
          usage: attempt.receipt.usage,
          providerTurns: attempt.receipt.providerTurns,
          providerRequests: attempt.receipt.providerRequests,
        };
      })
      .sort((left, right) => left.compositionId.localeCompare(right.compositionId)),
    ranking: { winnerCompositionId: null, reason: "development-pilot-cannot-rank" as const },
    technicalApproval: "not-established" as const,
    roleQualification: "not-established" as const,
    releaseEligible: false as const,
    limitations: [
      "cross-harness-not-pure-model",
      "darwin-descendant-containment-unsupported",
      "codex-effective-model-unavailable",
      "token-and-latency-telemetry-descriptive-only",
      "no-human-audience-evidence",
      "unattested-agent-proxies-do-not-establish-common-evaluation",
      ...(batch.entries.length === 0 ? ["no-successful-output-evidence"] : []),
    ],
  };
  const report = deepFreeze(
    kit.seal(CROSS_HARNESS_PILOT_REPORT_KIND, "reportSha256", body) as CrossHarnessPilotReportV1,
  );
  for (const attempt of batch.attempts) {
    attempt.consumed = true;
  }
  batch.consumed = true;
  batch.reportCreated = true;
  return report;
}

export async function reattestBlindEntry(entry: BlindEntryState): Promise<void> {
  const expectedArtifactLedger = expectedEvaluationArtifactLedger(entry);
  const evaluationRoot = dirname(entry.journeyPath);
  const observedArtifactLedger = await buildPrivateArtifactLedger(
    evaluationRoot,
    join(evaluationRoot, ".no-repository"),
  );
  if (canonicalDigest(observedArtifactLedger) !== canonicalDigest(expectedArtifactLedger)) {
    fail("re-attestation-failed");
  }
  const journey = await readPrivateArtifact(entry.journeyPath, 2 * 1024 * 1024);
  const deterministic = await readPrivateArtifact(
    entry.deterministicEvaluationPath,
    4 * 1024 * 1024,
  );
  if (
    !journey.equals(entry.journeyEvidence) ||
    !deterministic.equals(entry.deterministicEvaluation)
  ) {
    fail("re-attestation-failed");
  }
  for (const result of entry.roleResults) {
    const bytes = await readPrivateArtifact(result.artifactPath, 1024 * 1024);
    if (sha256(bytes) !== result.artifactSha256) fail("re-attestation-failed");
  }
}

export function expectedEvaluationArtifactLedger(
  entry: BlindEntryState,
): readonly PrivateArtifactLedgerEntry[] {
  const roleDirectory = join(dirname(entry.journeyPath), "roles");
  return [
    ...entry.evaluationArtifactLedger,
    {
      path: roleDirectory,
      kind: "directory" as const,
      sha256: null,
      mode: 0o700,
      allowEmpty: true,
    },
    ...entry.roleResults.map((result) => ({
      path: result.artifactPath,
      kind: "file" as const,
      sha256: result.artifactSha256,
      mode: result.artifactMode,
      allowEmpty: false,
    })),
  ].sort((left, right) => compareText(left.path, right.path));
}

export async function reattestEvaluationTree(
  state: RunnerState,
  batch: BlindBatchState,
): Promise<void> {
  const root = join(state.campaignRoot, "evaluations");
  const observed = await buildPrivateArtifactLedger(root, join(root, ".no-repository"));
  const expected = batch.entries
    .flatMap((entry) => [
      {
        path: dirname(entry.journeyPath),
        kind: "directory" as const,
        sha256: null,
        mode: 0o700,
        allowEmpty: true,
      },
      ...expectedEvaluationArtifactLedger(entry),
    ])
    .sort((left, right) => compareText(left.path, right.path));
  if (canonicalDigest(observed) !== canonicalDigest(expected)) {
    fail("re-attestation-failed");
  }
}

export async function runCandidateEvaluation(
  state: RunnerState,
  attempt: AttemptPrivateState,
  outputId: string,
): Promise<{
  readonly journeyEvidence: Buffer;
  readonly deterministicEvaluation: Buffer;
  readonly journeyPath: string;
  readonly deterministicEvaluationPath: string;
  readonly evaluationArtifactLedger: readonly PrivateArtifactLedgerEntry[];
}> {
  const root = safeJoin(state.campaignRoot, `evaluations/${outputId}`);
  await assertRunnerNewWritePath(state, root);
  await ensureRunnerPrivateDirectory(state, root, true);
  const page = join(attempt.repository, state.corpus.allowedPage);
  const journeyPath = join(root, "journey.json");
  const evaluationPath = join(root, "evaluation.json");
  await Promise.all([
    assertRunnerNewWritePath(state, journeyPath),
    assertRunnerNewWritePath(state, evaluationPath),
  ]);
  await runPythonScript(state, NATIVE_PILOT_CORPUS_PATHS.cleanJourney, [
    "--fixture",
    state.corpusRoot,
    "--repo",
    attempt.repository,
    "--page",
    page,
    "--router",
    join(attempt.repository, "bin/skill-router"),
    "--output",
    journeyPath,
  ]);
  await runPythonScript(state, NATIVE_PILOT_CORPUS_PATHS.documentChecker, [
    "--fixture",
    state.corpusRoot,
    "--repo",
    attempt.repository,
    "--page",
    page,
    "--journey",
    journeyPath,
    "--output",
    evaluationPath,
  ]);
  const journeyEvidence = await readPrivateArtifact(journeyPath, 2 * 1024 * 1024);
  const deterministicEvaluation = await readPrivateArtifact(evaluationPath, 4 * 1024 * 1024);
  const journey = strictObject(parseJsonEvidence(journeyEvidence));
  const evaluation = strictObject(parseJsonEvidence(deterministicEvaluation));
  if (
    journey.kind !== "docsfab-routing-clean-journey-result" ||
    journey.repositoryRevision !== state.corpus.repositoryRevision ||
    evaluation.kind !== "docsfab-routing-document-evaluation" ||
    evaluation.repositoryRevision !== state.corpus.repositoryRevision ||
    evaluation.pageSha256 !== attempt.receipt.documentSha256
  ) {
    fail("evaluation-binding-mismatch");
  }
  const evaluationArtifactLedger = await buildPrivateArtifactLedger(
    root,
    join(root, ".no-repository"),
  );
  return {
    journeyEvidence,
    deterministicEvaluation,
    journeyPath,
    deterministicEvaluationPath: evaluationPath,
    evaluationArtifactLedger,
  };
}

async function runPythonScript(
  state: RunnerState,
  kitPath: string,
  argumentsValue: readonly string[],
): Promise<void> {
  await verifyCopiedKit(state);
  const result = await runBoundedHostProcess({
    executablePath: state.pythonExecutablePath,
    arguments: [safeJoin(state.kitRoot, kitPath), ...argumentsValue],
    workingDirectory: state.campaignRoot,
    environment: hostEnvironment(state.environment),
    stdin: null,
    timeoutMs: 60_000,
    maxStdoutBytes: 1024 * 1024,
    maxStderrBytes: 1024 * 1024,
  });
  if (result.exitCode !== 0 || result.stdout.byteLength !== 0 || result.stderr.byteLength !== 0) {
    fail("host-operation-failed");
  }
  await verifyCopiedKit(state);
}

function blindDigest(state: RunnerState, message: string): string {
  return createHmac("sha256", state.blindingSeed).update(message, "utf8").digest("hex");
}
