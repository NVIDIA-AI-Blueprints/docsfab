// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ModelEvidence,
  ModelProfileEvidence,
  RunRecord,
  TokenUsage,
} from "./records/contracts.js";
import {
  INFERENCE_FAILURE_CATEGORIES,
  type InferenceFailureCategory,
} from "./inference-attempt-taxonomy.js";
import type {
  EvaluationFixture,
  StructuralAssertion,
  StructuralEvaluation,
} from "./quality-evaluation/contracts.js";
import { governedTurnLimitStop } from "./config/execution-limit-stops.js";
import { evaluateStructure, parseEvaluationFixture } from "./quality-evaluation/structural.js";
import { parseJsonEvidence } from "./json-evidence.js";
import { validModelEvidenceProjection } from "./model/profile-evidence.js";
import { parseScorecardRunRecord } from "./scorecard-record.js";
import { authorizeSecurityScan } from "./security/scan-override.js";
import { resolveSecurityScanEffectiveDisposition } from "./security/scan-disposition.js";
import {
  isScorecardIsoDate as validDate,
  isScorecardIsoTimestamp as validTimestamp,
  isScorecardSha256,
} from "./scorecard-validators.js";
import { sha256 as digest } from "./content-ir/canonical.js";
import {
  ScorecardInputError,
  canonical,
  REQUIRED_RECORDS,
  REVISION,
  type ScorecardInputErrorCode,
} from "./scorecard/value-primitives.js";
import {
  parseScorecardAcceptanceEvidence,
  parseScorecardCampaignDeclaration,
  parseScorecardJudgeArtifact,
} from "./scorecard/input-codecs.js";
export { ScorecardInputError };
export { canonicalJson } from "./scorecard/value-primitives.js";
export type { ScorecardInputErrorCode };
export { parseScorecardAcceptanceEvidence, parseScorecardCampaignDeclaration };

const SECURITY_SCAN_POLICY = {
  authorizeSecurityScan,
  resolveSecurityScanEffectiveDisposition,
} as const;

export type MvpDecision =
  | "not ready"
  | "ready with contained limitations"
  | "ready for internal MVP dogfood";

/** Failure classes the scorecard owns itself: policy stops, not inference. */
export type ScorecardPolicyFailureClass =
  | "policy-security-blocked"
  | "policy-security-denied"
  | "policy-scanner-failed"
  | "policy-context-preflight";

export type ScorecardFailureClass =
  | "none"
  | InferenceFailureCategory
  | ScorecardPolicyFailureClass
  | "unclassified";

export type ScorecardJudgeDisposition =
  | {
      status: "passed" | "disagreed" | "error";
      rubric: { id: "docsfab.semantic-evidence-quality"; version: 1 };
      model: { provider: string; model: string };
      score?: number;
      evidenceSha256: string;
    }
  | {
      status: "skipped";
      owner: string;
      issue: 5;
      reason: "judge-destination-not-approved" | "judge-evidence-pending";
      reviewOn: string;
    };

export interface ScorecardCampaignDeclarationV1 {
  schemaVersion: 1;
  campaignId: string;
  evaluatedAt: string;
  testedCommit: string;
  records: Array<{
    slot: number;
    file: string;
    id: string;
    sha256: string;
  }>;
  judge: ScorecardJudgeDisposition;
  remainingWork: Array<{
    issue: number;
    scope: "issue-28-dogfood" | "shared-service";
    owner: string;
    reason: "product-validation" | "post-mvp-scope" | "external-governance";
  }>;
}

export interface ScorecardAcceptanceEvidence {
  sha256: string;
  testedCommit: string;
  generatedAt: string;
  passed: boolean;
  live: boolean;
  policyProfileStatus: "current" | "stale" | "unknown";
  policyModel: { provider: string; model: string; profileSha256: string };
  judge?: Exclude<ScorecardJudgeDisposition, { status: "skipped" }>;
}

export interface ScorecardDependencyEvidence {
  advisoryId: "GHSA-mh99-v99m-4gvg";
  status: "resolved" | "contained" | "failed";
  owner: "docsfab-maintainers";
  reviewOn?: string;
  packageStateSha256: string;
}

export type ScorecardVerificationId = "npm-check" | "npm-build" | "git-diff-check";

export interface ScorecardVerificationEvidence {
  id: ScorecardVerificationId;
  passed: boolean;
}

export interface ScorecardRecordLeaf {
  file: string;
  bytes: Buffer;
}

export interface MvpScorecardV1 {
  schemaVersion: 1;
  kind: "docsfab-mvp-stabilization-scorecard";
  campaign: {
    id: string;
    evaluatedAt: string;
    testedCommit: string;
    generatorRevision: string;
    declarationSha256: string;
    sampleSize: 5;
  };
  decision: MvpDecision;
  decisionReasons: string[];
  modelProfile: {
    provider: string;
    model: string;
    status: "current" | "stale" | "unknown";
    sha256: string;
    pricing: "known" | "unknown";
    reviewAfter?: string;
  };
  inputs: {
    structuralFixture: { name: string; version: 1; sha256: string };
    acceptanceManifest: { sha256: string; passed: boolean; live: boolean };
    dependency: ScorecardDependencyEvidence;
  };
  reliability: {
    sampleSize: 5;
    successes: number;
    failures: number;
    observedReliability: { numerator: number; denominator: 5; percentage: number };
    firstAttemptSuccesses: number;
    recoveredRuns: number;
    incidents: Record<Exclude<ScorecardFailureClass, "none">, number>;
    terminalFailures: Record<Exclude<ScorecardFailureClass, "none">, number>;
    latencyMs: { minimum: number; median: number; maximum: number; sum: number; mean: number };
    usage: TokenUsage;
    attempts: number;
    retries: number;
    scheduledBackoffMs: number;
    sampleLimitation: "Five independent observations on one revision and model profile; this is not a confidence bound or shared-service SLO.";
  };
  structural: {
    passed: boolean;
    failedCampaignAssertions: string[];
  };
  runs: Array<{
    slot: number;
    id: string;
    sha256: string;
    structuralPassed: boolean;
    successClass: "succeeded" | "explained-context-stop" | "failed";
    failureClass: ScorecardFailureClass;
    durationMs: number;
    usage: TokenUsage;
    attempts: number;
    retries: number;
  }>;
  gates: {
    fiveRunCampaign: "passed" | "failed";
    structuralEvaluation: "passed" | "failed";
    packagedLiveAcceptance: "passed" | "failed";
    modelProfileProvenance: "passed" | "failed";
    dependencyAdvisory: "passed" | "contained" | "failed";
    semanticJudge: "passed" | "contained" | "failed";
    artifactSanitization: "pending" | "passed" | "failed";
    npmCheck: "passed" | "failed";
    npmBuild: "passed" | "failed";
    gitDiffCheck: "passed" | "failed";
  };
  judge: ScorecardJudgeDisposition;
  remainingWork: ScorecardCampaignDeclarationV1["remainingWork"];
  rawRecords: { location: "operator-private"; committed: false };
}

export function buildMvpScorecard(input: {
  declarationBytes: Buffer;
  recordLeaves: ScorecardRecordLeaf[];
  fixtureBytes: Buffer;
  acceptanceBytes: Buffer;
  judgeBytes?: Buffer;
  dependency: ScorecardDependencyEvidence;
  verification: ScorecardVerificationEvidence[];
  generatorRevision: string;
}): MvpScorecardV1 {
  const declaration = parseJsonBytes(
    input.declarationBytes,
    parseScorecardCampaignDeclaration,
    "invalid-campaign",
  );
  const fixture = parseJsonBytes(
    input.fixtureBytes,
    parseEvaluationFixture,
    "structural-evaluation-failed",
  );
  assertCanonicalScorecardFixture(fixture);
  const acceptance = parseJsonBytes(
    input.acceptanceBytes,
    (value) => parseScorecardAcceptanceEvidence(value, digest(input.acceptanceBytes)),
    "invalid-acceptance",
  );
  const campaignJudge =
    declaration.judge.status === "skipped"
      ? input.judgeBytes === undefined
        ? undefined
        : (() => {
            throw new ScorecardInputError("invalid-campaign");
          })()
      : input.judgeBytes
        ? parseJsonBytes(
            input.judgeBytes,
            (value) => parseScorecardJudgeArtifact(value, digest(input.judgeBytes!), declaration),
            "invalid-campaign",
          )
        : (() => {
            throw new ScorecardInputError("invalid-campaign");
          })();
  validateTopLevelInput(input, declaration, fixture, acceptance);
  const recordsByFile = new Map(input.recordLeaves.map((leaf) => [leaf.file, leaf]));
  const parsed = declaration.records.map((declared) => {
    const leaf = recordsByFile.get(declared.file);
    if (!leaf || digest(leaf.bytes) !== declared.sha256) {
      throw new ScorecardInputError("invalid-record-set");
    }
    const record = parseJsonBytes(leaf.bytes, parseRecord, "invalid-record");
    if (record.id !== declared.id) throw new ScorecardInputError("invalid-record-set");
    return { declared, record };
  });
  const records = parsed.map(({ record }) => record);
  validateCampaignTimeline(records, declaration.evaluatedAt);
  let structural: StructuralEvaluation;
  try {
    structural = evaluateStructure(fixture, records, () => SECURITY_SCAN_POLICY);
  } catch {
    throw new ScorecardInputError("structural-evaluation-failed");
  }
  const profile = validateProvenance(records, declaration, acceptance);
  if (
    declaration.judge.status !== "skipped" &&
    (!campaignJudge ||
      canonical(declaration.judge) !== canonical(campaignJudge) ||
      !acceptance.judge ||
      acceptance.judge.status === "error" ||
      acceptance.judge.model.provider !== declaration.judge.model.provider ||
      acceptance.judge.model.model !== declaration.judge.model.model)
  ) {
    throw new ScorecardInputError("invalid-acceptance");
  }
  const runRows = parsed.map(({ declared, record }) => summarizeRun(declared, record, structural));
  const reliability = aggregateRuns(runRows, records, profile.profile);
  const verification = verificationMap(input.verification);
  const gates = {
    fiveRunCampaign: reliability.failures === 0 ? ("passed" as const) : ("failed" as const),
    structuralEvaluation: structural.passed ? ("passed" as const) : ("failed" as const),
    packagedLiveAcceptance:
      acceptance.passed && acceptance.live ? ("passed" as const) : ("failed" as const),
    modelProfileProvenance:
      profile.profile.status === "current" ? ("passed" as const) : ("failed" as const),
    dependencyAdvisory:
      input.dependency.status === "resolved" ? ("passed" as const) : input.dependency.status,
    semanticJudge:
      declaration.judge.status === "passed"
        ? ("passed" as const)
        : declaration.judge.status === "error"
          ? ("failed" as const)
          : ("contained" as const),
    artifactSanitization: "pending" as const,
    npmCheck: verification.get("npm-check") ? ("passed" as const) : ("failed" as const),
    npmBuild: verification.get("npm-build") ? ("passed" as const) : ("failed" as const),
    gitDiffCheck: verification.get("git-diff-check") ? ("passed" as const) : ("failed" as const),
  };
  const hardFailures = [
    gates.fiveRunCampaign,
    gates.structuralEvaluation,
    gates.packagedLiveAcceptance,
    gates.modelProfileProvenance,
    gates.dependencyAdvisory,
    gates.semanticJudge,
    gates.npmCheck,
    gates.npmBuild,
    gates.gitDiffCheck,
  ].some((gate) => gate === "failed");
  const contained =
    gates.dependencyAdvisory === "contained" ||
    gates.semanticJudge === "contained" ||
    profile.profile.pricing === "unknown" ||
    reliability.usage.cost === undefined;
  const decision: MvpDecision = hardFailures
    ? "not ready"
    : contained
      ? "ready with contained limitations"
      : "ready for internal MVP dogfood";
  const decisionReasons = decisionReasonList(gates, profile.profile, reliability);
  const failedCampaignAssertions = structural.results
    .filter((result) => !result.passed && !result.recordId)
    .map((result) => result.assertion.type)
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort();
  return {
    schemaVersion: 1,
    kind: "docsfab-mvp-stabilization-scorecard",
    campaign: {
      id: declaration.campaignId,
      evaluatedAt: declaration.evaluatedAt,
      testedCommit: declaration.testedCommit,
      generatorRevision: input.generatorRevision,
      declarationSha256: digest(input.declarationBytes),
      sampleSize: 5,
    },
    decision,
    decisionReasons,
    modelProfile: {
      provider: profile.provider,
      model: profile.model,
      status: profile.profile.status,
      sha256: profile.profile.sha256,
      pricing: profile.profile.pricing,
      ...(profile.profile.reviewAfter ? { reviewAfter: profile.profile.reviewAfter } : {}),
    },
    inputs: {
      structuralFixture: {
        name: fixture.name,
        version: 1,
        sha256: digest(input.fixtureBytes),
      },
      acceptanceManifest: {
        sha256: acceptance.sha256,
        passed: acceptance.passed,
        live: acceptance.live,
      },
      dependency: input.dependency,
    },
    reliability,
    structural: { passed: structural.passed, failedCampaignAssertions },
    runs: runRows,
    gates,
    judge: declaration.judge,
    remainingWork: declaration.remainingWork,
    rawRecords: { location: "operator-private", committed: false },
  };
}

function validateTopLevelInput(
  input: Parameters<typeof buildMvpScorecard>[0],
  declaration: ScorecardCampaignDeclarationV1,
  fixture: EvaluationFixture,
  acceptance: ScorecardAcceptanceEvidence,
): void {
  if (
    !REVISION.test(input.generatorRevision) ||
    fixture.version !== 1 ||
    input.recordLeaves.length !== REQUIRED_RECORDS ||
    new Set(input.recordLeaves.map((leaf) => leaf.file)).size !== REQUIRED_RECORDS ||
    acceptance.testedCommit !== declaration.testedCommit ||
    acceptance.generatedAt > declaration.evaluatedAt ||
    !isScorecardSha256(input.dependency.packageStateSha256) ||
    input.dependency.advisoryId !== "GHSA-mh99-v99m-4gvg" ||
    input.dependency.owner !== "docsfab-maintainers" ||
    !["resolved", "contained", "failed"].includes(input.dependency.status) ||
    (input.dependency.status === "contained" && !validDate(input.dependency.reviewOn))
  ) {
    throw new ScorecardInputError("invalid-provenance");
  }
  if (
    input.dependency.status === "contained" &&
    input.dependency.reviewOn &&
    input.dependency.reviewOn < declaration.evaluatedAt.slice(0, 10)
  ) {
    throw new ScorecardInputError("invalid-dependency");
  }
}

function parseJsonBytes<T>(
  bytes: Buffer,
  parse: (value: unknown) => T,
  code: ScorecardInputErrorCode,
): T {
  try {
    return parse(parseJsonEvidence(bytes));
  } catch (error) {
    if (error instanceof ScorecardInputError) throw error;
    throw new ScorecardInputError(code);
  }
}

const CANONICAL_SCORECARD_ASSERTIONS: StructuralAssertion[] = [
  { type: "run-count", minimum: 5 },
  { type: "workflow", equals: "readiness" },
  { type: "governed-terminal-status" },
  { type: "step-skills", equals: ["doc-context-analyzer"] },
  { type: "governed-skill-evidence" },
  { type: "allowed-tools", tools: ["read", "grep", "find", "ls"] },
  { type: "forbidden-tools", tools: ["edit", "write"] },
  { type: "turn-governance-evidence" },
  { type: "evidence-identity-consistent" },
];

function assertCanonicalScorecardFixture(fixture: EvaluationFixture): void {
  if (
    fixture.name !== "Multi-turn governed live readiness" ||
    canonical(fixture.assertions) !== canonical(CANONICAL_SCORECARD_ASSERTIONS)
  ) {
    throw new ScorecardInputError("structural-evaluation-failed");
  }
}

function parseRecord(value: unknown): RunRecord {
  try {
    return parseScorecardRunRecord(value);
  } catch {
    throw new ScorecardInputError("invalid-record");
  }
}

function validateCampaignTimeline(records: RunRecord[], evaluatedAt: string): void {
  const createdAt = new Set<string>();
  for (const record of records) {
    if (
      !validTimestamp(record.createdAt) ||
      !validTimestamp(record.completedAt) ||
      record.createdAt > record.completedAt! ||
      record.completedAt! > evaluatedAt ||
      createdAt.has(record.createdAt)
    ) {
      throw new ScorecardInputError("invalid-provenance");
    }
    createdAt.add(record.createdAt);
    if (
      record.startedAt !== undefined &&
      (!validTimestamp(record.startedAt) ||
        record.createdAt > record.startedAt ||
        record.startedAt > record.completedAt!)
    ) {
      throw new ScorecardInputError("invalid-provenance");
    }
    const durationStart = record.startedAt ?? record.createdAt;
    if (Date.parse(record.completedAt!) - Date.parse(durationStart) !== record.durationMs) {
      throw new ScorecardInputError("invalid-arithmetic");
    }
  }
}

function validateProvenance(
  records: RunRecord[],
  declaration: ScorecardCampaignDeclarationV1,
  acceptance: ScorecardAcceptanceEvidence,
): ModelEvidence & { profile: ModelProfileEvidence } {
  const models: Array<ModelEvidence & { profile: ModelProfileEvidence }> = [];
  for (const record of records) {
    if (
      record.repository.revision !== declaration.testedCommit ||
      !REVISION.test(record.repository.revision) ||
      record.models.length > 1
    ) {
      throw new ScorecardInputError("invalid-provenance");
    }
    const attempts = record.steps.flatMap((step) => step.inference?.attempts ?? []);
    const model = record.models[0];
    if (attempts.length === 0) {
      if (!isLocalPolicyFailure(record) || model !== undefined) {
        throw new ScorecardInputError("invalid-provenance");
      }
      continue;
    }
    if (!model || !validModelEvidenceProjection(model)) {
      throw new ScorecardInputError("invalid-provenance");
    }
    models.push(model);
    for (const step of record.steps) {
      for (const attempt of step.inference?.attempts ?? []) {
        if (
          attempt.identity?.repositoryRevision !== declaration.testedCommit ||
          !attempt.model ||
          !validModelEvidenceProjection(attempt.model) ||
          attempt.model.provider !== model.provider ||
          attempt.model.model !== model.model ||
          attempt.model.profile.sha256 !== model.profile.sha256
        ) {
          throw new ScorecardInputError("invalid-provenance");
        }
        if (
          (attempt.turns ?? []).some(
            (turn) =>
              (model.profile.schemaVersion === 2) !== (turn.contextBudgetSchemaVersion === 2) ||
              turn.configuredContextWindow !== model.profile.configuredContextWindow ||
              turn.effectiveContextWindow !== model.profile.effectiveContextWindow ||
              turn.configuredMaxInputTokens !== model.profile.configuredMaxInputTokens ||
              turn.effectiveMaxInputTokens !== model.profile.effectiveMaxInputTokens ||
              turn.configuredMaxOutputTokens !== model.profile.configuredMaxOutputTokens ||
              turn.effectiveMaxOutputTokens !== model.profile.effectiveMaxOutputTokens ||
              turn.reservedTokens !== model.profile.requestPolicy.reservedContextTokens ||
              turn.requiredMinimumOutputTokens !== model.profile.requestPolicy.minimumOutputTokens,
          )
        ) {
          throw new ScorecardInputError("invalid-provenance");
        }
      }
    }
  }
  const first = models[0];
  if (!first) throw new ScorecardInputError("invalid-provenance");
  if (
    models.some(
      (model) =>
        model.provider !== first.provider ||
        model.model !== first.model ||
        model.profile.sha256 !== first.profile.sha256 ||
        model.profile.status !== first.profile.status,
    ) ||
    acceptance.policyProfileStatus !== first.profile.status ||
    acceptance.policyModel.provider !== first.provider ||
    acceptance.policyModel.model !== first.model ||
    acceptance.policyModel.profileSha256 !== first.profile.sha256
  ) {
    throw new ScorecardInputError("invalid-provenance");
  }
  validateProfileFreshness(first.profile, declaration.evaluatedAt.slice(0, 10));
  return first;
}

function isLocalPolicyFailure(record: RunRecord): boolean {
  const disposition = record.securityScanEffectiveDisposition?.status;
  return (
    disposition === "blocked" ||
    disposition === "denied" ||
    disposition === "failed" ||
    record.securityScan?.status === "failed" ||
    record.steps.some((step) => step.contextPreflight?.status === "failed")
  );
}

function validateProfileFreshness(profile: ModelProfileEvidence, evaluatedDate: string): void {
  const hasProvenance = Boolean(
    profile.approvedSourceSha256 && profile.effectiveDate && profile.reviewAfter,
  );
  if (profile.status === "unknown") {
    if (
      hasProvenance ||
      profile.approvedSourceSha256 ||
      profile.effectiveDate ||
      profile.reviewAfter ||
      profile.effectiveLimitReason !== "metadata-unknown" ||
      profile.pricing !== "unknown" ||
      profile.effectiveContextWindow > 8_192 ||
      (profile.effectiveMaxInputTokens !== undefined && profile.effectiveMaxInputTokens > 8_192) ||
      profile.effectiveMaxOutputTokens > 4_096
    ) {
      throw new ScorecardInputError("invalid-provenance");
    }
    return;
  }
  if (
    !hasProvenance ||
    !isScorecardSha256(profile.approvedSourceSha256!) ||
    !validDate(profile.effectiveDate) ||
    !validDate(profile.reviewAfter) ||
    profile.effectiveDate! > evaluatedDate
  ) {
    throw new ScorecardInputError("invalid-provenance");
  }
  // A current record evaluated after its review date is still current: the
  // date is advisory. The `stale` branch below only decodes saved legacy
  // records.
  if (
    profile.status === "current" &&
    (profile.effectiveLimitReason !== "none" ||
      profile.effectiveContextWindow !== profile.configuredContextWindow ||
      (profile.configuredMaxInputTokens !== undefined &&
        profile.effectiveMaxInputTokens !== profile.configuredMaxInputTokens) ||
      profile.effectiveMaxOutputTokens !== profile.configuredMaxOutputTokens)
  ) {
    throw new ScorecardInputError("invalid-provenance");
  }
  if (
    profile.status === "stale" &&
    (profile.effectiveLimitReason !== "metadata-stale" ||
      profile.reviewAfter! >= evaluatedDate ||
      profile.pricing !== "unknown" ||
      profile.effectiveContextWindow > 8_192 ||
      (profile.effectiveMaxInputTokens !== undefined && profile.effectiveMaxInputTokens > 8_192) ||
      profile.effectiveMaxOutputTokens > 4_096)
  ) {
    throw new ScorecardInputError("invalid-provenance");
  }
}

function summarizeRun(
  declared: ScorecardCampaignDeclarationV1["records"][number],
  record: RunRecord,
  structural: StructuralEvaluation,
): MvpScorecardV1["runs"][number] {
  const usage = validUsage(record.usage);
  const attempts = record.steps.flatMap((step) => step.inference?.attempts ?? []);
  if (
    attempts.length === 0 &&
    (!isLocalPolicyFailure(record) ||
      usage.total !== 0 ||
      usage.turns !== 0 ||
      record.tools.totalCalls !== 0)
  ) {
    throw new ScorecardInputError("invalid-record");
  }
  for (const attempt of attempts) {
    if (!Number.isSafeInteger(attempt.durationMs) || attempt.durationMs < 0) {
      throw new ScorecardInputError("invalid-arithmetic");
    }
    if (attempt.usage) validUsage(attempt.usage);
  }
  let recomputedRunUsage = emptyUsage();
  let recomputedRunCost = 0;
  let recomputedRunCostComplete = true;
  let sawRunUsage = false;
  let recomputedToolCalls = 0;
  let recomputedToolFailures = 0;
  for (const step of record.steps.filter((item) => item.kind !== "host-operation")) {
    const stepAttempts = step.inference?.attempts ?? [];
    const attemptUsage = sumOptionalUsage(stepAttempts.map((attempt) => attempt.usage));
    if (
      attemptUsage.present !== (step.usage !== undefined) ||
      (step.usage && !usageEquals(validUsage(step.usage), attemptUsage.usage))
    ) {
      throw new ScorecardInputError("invalid-arithmetic");
    }
    recomputedRunUsage = addUsage(recomputedRunUsage, attemptUsage.usage);
    if (attemptUsage.costComplete && attemptUsage.present) {
      recomputedRunCost = roundedCost(recomputedRunCost + (attemptUsage.usage.cost ?? 0));
      sawRunUsage = true;
    } else if (attemptUsage.present) {
      recomputedRunCostComplete = false;
      sawRunUsage = true;
    }
    const attemptTools = stepAttempts.map((attempt) => attempt.tools);
    const presentTools = attemptTools.filter((tools) => tools !== undefined);
    if (presentTools.length > 0 && presentTools.length !== attemptTools.length) {
      throw new ScorecardInputError("invalid-arithmetic");
    }
    const toolTotals = presentTools.reduce(
      (total, tools) => ({
        calls: safeAdd(total.calls, validToolCount(tools!.totalCalls)),
        failures: safeAdd(total.failures, validToolCount(tools!.failedCalls)),
      }),
      { calls: 0, failures: 0 },
    );
    if (
      presentTools.length > 0 !== (step.tools !== undefined) ||
      (step.tools &&
        (step.tools.totalCalls !== toolTotals.calls ||
          step.tools.failedCalls !== toolTotals.failures))
    ) {
      throw new ScorecardInputError("invalid-arithmetic");
    }
    recomputedToolCalls = safeAdd(recomputedToolCalls, toolTotals.calls);
    recomputedToolFailures = safeAdd(recomputedToolFailures, toolTotals.failures);
    const attemptDuration = stepAttempts.reduce(
      (total, attempt) => safeAdd(total, attempt.durationMs),
      0,
    );
    const backoff = stepAttempts.reduce(
      (total, attempt) => safeAdd(total, attempt.backoffMs ?? 0),
      0,
    );
    const authenticLocalStop =
      stepAttempts.length === 0 && isLocalPolicyFailure(record) && step.durationMs === undefined;
    if (
      !authenticLocalStop &&
      (!Number.isSafeInteger(step.durationMs) || step.durationMs! < attemptDuration + backoff)
    ) {
      throw new ScorecardInputError("invalid-arithmetic");
    }
  }
  if (sawRunUsage && recomputedRunCostComplete) {
    recomputedRunUsage.cost = recomputedRunCost;
  }
  validToolCount(record.tools.totalCalls);
  validToolCount(record.tools.failedCalls);
  if (
    !usageEquals(usage, recomputedRunUsage) ||
    record.tools.totalCalls !== recomputedToolCalls ||
    record.tools.failedCalls !== recomputedToolFailures ||
    record.tools.failedCalls > record.tools.totalCalls ||
    !durationMatchesTimestamps(
      record.startedAt ?? record.createdAt,
      record.completedAt,
      record.durationMs!,
    )
  ) {
    throw new ScorecardInputError("invalid-arithmetic");
  }
  const recordResults = structural.results.filter((result) => result.recordId === record.id);
  const structuralPassed =
    recordResults.length > 0 && recordResults.every((result) => result.passed);
  const classification = classifyRun(record, structuralPassed);
  return {
    slot: declared.slot,
    id: record.id,
    sha256: declared.sha256,
    structuralPassed,
    ...classification,
    durationMs: record.durationMs!,
    usage,
    attempts: attempts.length,
    retries: Math.max(
      0,
      attempts.length - record.steps.filter((step) => step.kind !== "host-operation").length,
    ),
  };
}

function classifyRun(
  record: RunRecord,
  structuralPassed: boolean,
): Pick<MvpScorecardV1["runs"][number], "successClass" | "failureClass"> {
  const policy = record.securityScanEffectiveDisposition?.status;
  if (policy === "blocked")
    return { successClass: "failed", failureClass: "policy-security-blocked" };
  if (policy === "denied")
    return { successClass: "failed", failureClass: "policy-security-denied" };
  if (policy === "failed" || record.securityScan?.status === "failed") {
    return { successClass: "failed", failureClass: "policy-scanner-failed" };
  }
  if (record.steps.some((step) => step.contextPreflight?.status === "failed")) {
    return { successClass: "failed", failureClass: "policy-context-preflight" };
  }
  const terminalAttempts = record.steps
    .filter((step) => step.kind !== "host-operation")
    .map((step) => step.inference?.attempts.at(-1));
  const terminal = terminalAttempts.map((attempt) => attempt?.outcome);
  if (
    record.status === "succeeded" &&
    structuralPassed &&
    terminal.length > 0 &&
    terminal.every((outcome) => outcome === "succeeded") &&
    record.steps.every((step) => step.status === "succeeded")
  ) {
    return { successClass: "succeeded", failureClass: "none" };
  }
  const failures = terminal.filter((outcome): outcome is InferenceFailureCategory =>
    Boolean(outcome && outcome !== "succeeded"),
  );
  if (failures.length !== 1) return { successClass: "failed", failureClass: "unclassified" };
  const failure = failures[0]!;
  // A governor stop at the tool-call or provider-turn ceiling also records
  // `context-exhausted`, but the model used the step's whole allowance without
  // answering; only a stop the context itself forced is explained.
  const ceilingStop = terminalAttempts.some((attempt) => {
    const ceiling = governedTurnLimitStop(attempt?.turns?.at(-1))?.ceiling;
    return ceiling === "tool-calls" || ceiling === "provider-turns";
  });
  if (failure === "context-exhausted" && structuralPassed && !ceilingStop) {
    return { successClass: "explained-context-stop", failureClass: failure };
  }
  return { successClass: "failed", failureClass: failure };
}

const SCORECARD_POLICY_FAILURE_CLASSES = [
  "policy-security-blocked",
  "policy-security-denied",
  "policy-scanner-failed",
  "policy-context-preflight",
] as const satisfies readonly ScorecardPolicyFailureClass[];

/**
 * Reporting order for the reliability counters and the rendered incident
 * table. The inference prefix is the shared taxonomy, in its declared order,
 * so this list cannot drift from outcome validation or the live corpus.
 */
export const SCORECARD_FAILURE_CLASSES: ReadonlyArray<Exclude<ScorecardFailureClass, "none">> =
  Object.freeze([
    ...INFERENCE_FAILURE_CATEGORIES,
    ...SCORECARD_POLICY_FAILURE_CLASSES,
    "unclassified",
  ]);

function aggregateRuns(
  rows: MvpScorecardV1["runs"],
  records: RunRecord[],
  profile: ModelProfileEvidence,
): MvpScorecardV1["reliability"] {
  const successes = rows.filter((row) => row.successClass === "succeeded").length;
  const terminalFailures = Object.fromEntries(
    SCORECARD_FAILURE_CLASSES.map((item) => [item, 0]),
  ) as Record<Exclude<ScorecardFailureClass, "none">, number>;
  const incidents = Object.fromEntries(
    SCORECARD_FAILURE_CLASSES.map((item) => [item, 0]),
  ) as Record<Exclude<ScorecardFailureClass, "none">, number>;
  let firstAttemptSuccesses = 0;
  let recoveredRuns = 0;
  let scheduledBackoffMs = 0;
  for (const [index, record] of records.entries()) {
    const attempts = record.steps.flatMap((step) => step.inference?.attempts ?? []);
    const first = attempts[0]?.outcome;
    const last = attempts.at(-1)?.outcome;
    if (first === "succeeded") firstAttemptSuccesses += 1;
    if (first !== "succeeded" && last === "succeeded") recoveredRuns += 1;
    for (const attempt of attempts) {
      if (attempt.outcome !== "succeeded") incidents[classForOutcome(attempt.outcome)] += 1;
      if (attempt.retryScheduled) {
        if (!Number.isSafeInteger(attempt.backoffMs) || Number(attempt.backoffMs) < 0) {
          throw new ScorecardInputError("invalid-arithmetic");
        }
        scheduledBackoffMs = safeAdd(scheduledBackoffMs, Number(attempt.backoffMs));
      }
    }
    const row = rows[index]!;
    if (row.failureClass !== "none") terminalFailures[row.failureClass] += 1;
  }
  const durations = rows.map((row) => row.durationMs).sort((left, right) => left - right);
  const durationSum = durations.reduce(safeAdd, 0);
  const usage = rows.map((row) => row.usage).reduce(addUsage, emptyUsage());
  if (
    profile.status === "current" &&
    profile.pricing === "known" &&
    rows.every((row) => row.usage.cost !== undefined)
  ) {
    usage.cost = roundedCost(rows.reduce((total, row) => total + row.usage.cost!, 0));
  }
  return {
    sampleSize: 5,
    successes,
    failures: REQUIRED_RECORDS - successes,
    observedReliability: {
      numerator: successes,
      denominator: 5,
      percentage: successes * 20,
    },
    firstAttemptSuccesses,
    recoveredRuns,
    incidents,
    terminalFailures,
    latencyMs: {
      minimum: durations[0]!,
      median: durations[2]!,
      maximum: durations[4]!,
      sum: durationSum,
      mean: Math.round(durationSum / REQUIRED_RECORDS),
    },
    usage,
    attempts: rows.reduce((total, row) => safeAdd(total, row.attempts), 0),
    retries: rows.reduce((total, row) => safeAdd(total, row.retries), 0),
    scheduledBackoffMs,
    sampleLimitation:
      "Five independent observations on one revision and model profile; this is not a confidence bound or shared-service SLO.",
  };
}

function classForOutcome(
  outcome: InferenceFailureCategory,
): Exclude<ScorecardFailureClass, "none"> {
  return outcome;
}

function validUsage(value: TokenUsage): TokenUsage {
  const keys = ["input", "output", "cacheRead", "cacheWrite", "total", "turns"] as const;
  if (
    keys.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0) ||
    value.total !== value.input + value.output + value.cacheRead + value.cacheWrite ||
    (value.cost !== undefined && (!Number.isFinite(value.cost) || value.cost < 0))
  ) {
    throw new ScorecardInputError("invalid-arithmetic");
  }
  return {
    input: value.input,
    output: value.output,
    cacheRead: value.cacheRead,
    cacheWrite: value.cacheWrite,
    total: value.total,
    turns: value.turns,
    ...(value.cost !== undefined ? { cost: roundedCost(value.cost) } : {}),
  };
}

function usageEquals(left: TokenUsage, right: TokenUsage): boolean {
  return (
    left.input === right.input &&
    left.output === right.output &&
    left.cacheRead === right.cacheRead &&
    left.cacheWrite === right.cacheWrite &&
    left.total === right.total &&
    left.turns === right.turns &&
    left.cost === right.cost
  );
}

function sumOptionalUsage(values: Array<TokenUsage | undefined>): {
  usage: TokenUsage;
  present: boolean;
  costComplete: boolean;
} {
  const present = values.filter((value): value is TokenUsage => value !== undefined);
  let usage = present.reduce((total, value) => addUsage(total, validUsage(value)), emptyUsage());
  const costComplete = present.length > 0 && present.every((value) => value.cost !== undefined);
  if (costComplete) {
    usage.cost = roundedCost(present.reduce((total, value) => total + value.cost!, 0));
  }
  return { usage, present: present.length > 0, costComplete };
}

function validToolCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ScorecardInputError("invalid-arithmetic");
  }
  return value;
}

function durationMatchesTimestamps(
  startedAt: string | undefined,
  completedAt: string | undefined,
  durationMs: number,
): boolean {
  if (!startedAt || !completedAt || !validTimestamp(startedAt) || !validTimestamp(completedAt)) {
    return false;
  }
  return Date.parse(completedAt) - Date.parse(startedAt) === durationMs;
}

function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 };
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    input: safeAdd(left.input, right.input),
    output: safeAdd(left.output, right.output),
    cacheRead: safeAdd(left.cacheRead, right.cacheRead),
    cacheWrite: safeAdd(left.cacheWrite, right.cacheWrite),
    total: safeAdd(left.total, right.total),
    turns: safeAdd(left.turns, right.turns),
  };
}

function roundedCost(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new ScorecardInputError("invalid-arithmetic");
  }
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new ScorecardInputError("invalid-arithmetic");
  }
  return result;
}

function verificationMap(
  values: ScorecardVerificationEvidence[],
): Map<ScorecardVerificationId, boolean> {
  const ids: ScorecardVerificationId[] = ["npm-check", "npm-build", "git-diff-check"];
  if (
    values.length !== ids.length ||
    new Set(values.map((value) => value.id)).size !== ids.length ||
    values.some((value) => !ids.includes(value.id) || typeof value.passed !== "boolean")
  ) {
    throw new ScorecardInputError("invalid-verification");
  }
  return new Map(values.map((value) => [value.id, value.passed]));
}

function decisionReasonList(
  gates: MvpScorecardV1["gates"],
  profile: ModelProfileEvidence,
  reliability: MvpScorecardV1["reliability"],
): string[] {
  const reasons: string[] = [];
  if (reliability.failures > 0) reasons.push("campaign-observed-failure");
  if (gates.structuralEvaluation === "failed") reasons.push("campaign-structural-failure");
  if (gates.packagedLiveAcceptance === "failed") reasons.push("live-acceptance-not-proven");
  if (gates.modelProfileProvenance === "failed") reasons.push("model-profile-not-current");
  if (gates.dependencyAdvisory === "failed") reasons.push("dependency-advisory-failed");
  if (gates.dependencyAdvisory === "contained") reasons.push("dependency-advisory-contained");
  if (gates.semanticJudge === "contained") reasons.push("semantic-judge-contained");
  if (gates.semanticJudge === "failed") reasons.push("semantic-judge-error");
  if (profile.pricing === "unknown" || reliability.usage.cost === undefined) {
    reasons.push("pricing-unknown");
  }
  if ([gates.npmCheck, gates.npmBuild, gates.gitDiffCheck].some((gate) => gate === "failed"))
    reasons.push("local-verification-failed");
  if (reasons.length === 0) reasons.push("all-internal-mvp-gates-passed");
  return reasons;
}
