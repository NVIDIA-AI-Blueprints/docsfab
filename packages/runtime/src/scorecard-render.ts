// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { detectCredentialRuleIds } from "./security/repository-scanner.js";
import {
  renderDocumentationGapLedgerMarkdown,
  type DocumentationGapLedgerV1,
} from "./search/gap-ledger.js";
import type {
  MvpDecision,
  MvpScorecardV1,
  ScorecardFailureClass,
  ScorecardJudgeDisposition,
} from "./scorecard.js";
import {
  isScorecardIsoDate as validDate,
  isScorecardIsoTimestamp as validTimestamp,
  isScorecardSafeId as safeId,
  isScorecardSha256 as sha256,
} from "./scorecard-validators.js";
export {
  createReleaseDocumentationReadinessScorecard,
  renderReleaseDocumentationReadinessScorecard,
} from "./release-documentation-scorecard.js";

const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const SAMPLE_LIMITATION =
  "Five independent observations on one revision and model profile; this is not a confidence bound or shared-service SLO.";
const FIXTURE_NAME = "Multi-turn governed live readiness";

const FAILURE_CLASSES: Array<Exclude<ScorecardFailureClass, "none">> = [
  "blank-response",
  "malformed-response",
  "context-exhausted",
  "timeout",
  "throttled",
  "provider-transient",
  "provider-terminal",
  "host-runtime-failure",
  "invalid-request",
  "no-progress",
  "policy-security-blocked",
  "policy-security-denied",
  "policy-scanner-failed",
  "policy-context-preflight",
  "unclassified",
];

const ZERO_ATTEMPT_POLICY_FAILURES = new Set<ScorecardFailureClass>([
  "policy-security-blocked",
  "policy-security-denied",
  "policy-scanner-failed",
  "policy-context-preflight",
]);

const COST_SCALE = 1_000_000_000_000;

const DECISION_REASONS = new Set([
  "campaign-observed-failure",
  "campaign-structural-failure",
  "live-acceptance-not-proven",
  "model-profile-not-current",
  "dependency-advisory-failed",
  "dependency-advisory-contained",
  "semantic-judge-contained",
  "semantic-judge-error",
  "pricing-unknown",
  "local-verification-failed",
  "all-internal-mvp-gates-passed",
]);

const STRUCTURAL_ASSERTIONS = new Set([
  "run-count",
  "status",
  "workflow",
  "all-steps-succeeded",
  "summaries-present",
  "step-skills",
  "governed-skill-evidence",
  "allowed-tools",
  "required-tools",
  "forbidden-tools",
  "turn-governance-evidence",
  "evidence-identity-consistent",
  "governed-terminal-status",
  "record-shape-consistent",
]);

const FORBIDDEN_KEYS = new Set([
  "apiKey",
  "baseUrl",
  "changedFiles",
  "credential",
  "endpoint",
  "error",
  "findingPaths",
  "instruction",
  "messages",
  "patch",
  "path",
  "prompt",
  "rationale",
  "record",
  "records",
  "requestedRevision",
  "response",
  "sourcePath",
  "summary",
  "toolArguments",
  "toolResults",
  "transcript",
]);

const ABSOLUTE_OR_HOST_PATH =
  /(?:^|[\s"'`(=:])\/(?:[^\s|]*)|(?:^|[\s"'`(=])~[\\/]|(?:^|[\s"'`(=])[A-Za-z]:[\\/]|(?:^|[\s"'`(=])\\\\|\bfile:\/\//u;
const URL = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\//u;
const CONTROL = /[\u0000-\u001f\u007f]/u;

export type ScorecardRenderErrorCode =
  | "invalid-shape"
  | "unsafe-content"
  | "inconsistent-scorecard";

/** Safe scorecard section for a revision-bound documentation gap ledger. */
export function renderDocumentationGapLedgerScorecardMarkdown(
  ledger: DocumentationGapLedgerV1,
): string {
  return renderDocumentationGapLedgerMarkdown(ledger);
}

/** Publication errors deliberately omit the rejected value. */
export class ScorecardRenderError extends Error {
  public constructor(public readonly code: ScorecardRenderErrorCode) {
    super(`MVP scorecard rendering failed (${code}).`);
    this.name = "ScorecardRenderError";
  }
}

/** Validate the complete publication allowlist without retaining rejected data. */
export function assertSafeMvpScorecard(value: MvpScorecardV1): void {
  inspectEveryValue(value);
  const root = plain(value);
  exact(root, [
    "schemaVersion",
    "kind",
    "campaign",
    "decision",
    "decisionReasons",
    "modelProfile",
    "inputs",
    "reliability",
    "structural",
    "runs",
    "gates",
    "judge",
    "remainingWork",
    "rawRecords",
  ]);
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-mvp-stabilization-scorecard") {
    invalid();
  }

  const campaign = plain(root.campaign);
  exact(campaign, [
    "id",
    "evaluatedAt",
    "testedCommit",
    "generatorRevision",
    "declarationSha256",
    "sampleSize",
  ]);
  if (
    !safeId(campaign.id) ||
    !validTimestamp(campaign.evaluatedAt) ||
    !revision(campaign.testedCommit) ||
    !revision(campaign.generatorRevision) ||
    !sha256(campaign.declarationSha256) ||
    campaign.sampleSize !== 5
  ) {
    invalid();
  }

  if (
    !isDecision(root.decision) ||
    !Array.isArray(root.decisionReasons) ||
    root.decisionReasons.length === 0 ||
    root.decisionReasons.some(
      (reason) => typeof reason !== "string" || !DECISION_REASONS.has(reason),
    ) ||
    new Set(root.decisionReasons).size !== root.decisionReasons.length
  ) {
    invalid();
  }

  const modelProfile = plain(root.modelProfile);
  exactOptional(
    modelProfile,
    ["provider", "model", "status", "sha256", "pricing"],
    ["reviewAfter"],
  );
  if (
    !safeId(modelProfile.provider) ||
    !safeModel(modelProfile.model) ||
    !oneOf(modelProfile.status, ["current", "stale", "unknown"]) ||
    !sha256(modelProfile.sha256) ||
    !oneOf(modelProfile.pricing, ["known", "unknown"]) ||
    (modelProfile.reviewAfter !== undefined && !validDate(modelProfile.reviewAfter))
  ) {
    invalid();
  }

  const inputs = validateInputs(root.inputs);
  const reliability = validateReliability(root.reliability);
  const structural = validateStructural(root.structural);
  const runs = validateRuns(root.runs);
  const gates = validateGates(root.gates);
  const judge = validateJudge(root.judge);
  validateRemainingWork(root.remainingWork);

  const rawRecords = plain(root.rawRecords);
  exact(rawRecords, ["location", "committed"]);
  if (rawRecords.location !== "operator-private" || rawRecords.committed !== false) {
    invalid();
  }

  validateConsistency({
    decision: root.decision,
    decisionReasons: root.decisionReasons,
    modelProfile,
    reliability,
    structural,
    runs,
    gates,
    judge,
    inputs,
  });
}

/** Stable, recursively key-sorted, two-space JSON with one terminal newline. */
export function prettyMvpScorecardJson(scorecard: MvpScorecardV1): string {
  scorecard = finalizeSanitizationGate(scorecard);
  assertSafeMvpScorecard(scorecard);
  return `${JSON.stringify(sortJson(scorecard), null, 2)}\n`;
}

/** CLI-facing name for the canonical pretty JSON artifact. */
export function serializeMvpScorecard(scorecard: MvpScorecardV1): string {
  return prettyMvpScorecardJson(scorecard);
}

/** Render Markdown using only the allowlisted scorecard projection. */
export function renderMvpScorecardMarkdown(scorecard: MvpScorecardV1): string {
  scorecard = finalizeSanitizationGate(scorecard);
  assertSafeMvpScorecard(scorecard);
  const incidentRows = FAILURE_CLASSES.map(
    (failureClass) =>
      `| ${code(failureClass)} | ${scorecard.reliability.incidents[failureClass]} | ${scorecard.reliability.terminalFailures[failureClass]} |`,
  );
  const runRows = [...scorecard.runs]
    .sort((left, right) => left.slot - right.slot)
    .map(
      (run) =>
        `| ${run.slot} | ${code(run.id)} | ${code(shortDigest(run.sha256))} | ${code(run.successClass)} | ${code(run.failureClass)} | ${run.structuralPassed ? "passed" : "failed"} | ${run.durationMs} | ${run.attempts} | ${run.retries} |`,
    );
  const gateRows = gateEntries(scorecard).map(
    ({ label, status, owner, reason }) =>
      `| ${label} | ${code(status)} | ${owner ? code(owner) : "—"} | ${reason ? code(reason) : "—"} |`,
  );
  const remainingRows = [...scorecard.remainingWork]
    .sort((left, right) => left.issue - right.issue || left.scope.localeCompare(right.scope))
    .map(
      (work) =>
        `| #${work.issue} | ${code(work.scope)} | ${code(work.owner)} | ${code(work.reason)} |`,
    );
  const judgeLines = judgeMarkdown(scorecard.judge);
  const cost =
    scorecard.reliability.usage.cost === undefined
      ? "unknown"
      : String(scorecard.reliability.usage.cost);

  return [
    "# DocsFab MVP stabilization scorecard",
    "",
    `Decision: **${scorecard.decision}**`,
    "",
    `- Tested commit: ${code(scorecard.campaign.testedCommit)}`,
    `- Generator revision: ${code(scorecard.campaign.generatorRevision)}`,
    `- Campaign: ${code(scorecard.campaign.id)}`,
    `- Evaluated at: ${code(scorecard.campaign.evaluatedAt)}`,
    "- Sample size: **n=5** independent observations.",
    "",
    "## Decision basis",
    "",
    ...scorecard.decisionReasons.map((reason) => `- ${code(reason)}`),
    "",
    "## Observed reliability",
    "",
    `Observed reliability was **${scorecard.reliability.observedReliability.numerator}/${scorecard.reliability.observedReliability.denominator} (${scorecard.reliability.observedReliability.percentage}%)**.`,
    "",
    `Sample-size limitation (n=5): ${scorecard.reliability.sampleLimitation}`,
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Successful runs | ${scorecard.reliability.successes} |`,
    `| Non-successful runs | ${scorecard.reliability.failures} |`,
    `| First-attempt successes | ${scorecard.reliability.firstAttemptSuccesses} |`,
    `| Recovered runs | ${scorecard.reliability.recoveredRuns} |`,
    `| Attempts | ${scorecard.reliability.attempts} |`,
    `| Retries | ${scorecard.reliability.retries} |`,
    `| Scheduled backoff | ${scorecard.reliability.scheduledBackoffMs} ms |`,
    `| Latency minimum | ${scorecard.reliability.latencyMs.minimum} ms |`,
    `| Latency median | ${scorecard.reliability.latencyMs.median} ms |`,
    `| Latency mean | ${scorecard.reliability.latencyMs.mean} ms |`,
    `| Latency maximum | ${scorecard.reliability.latencyMs.maximum} ms |`,
    "",
    "### Failure classification",
    "",
    "| Class | Observed incidents | Terminal runs |",
    "| --- | ---: | ---: |",
    ...incidentRows,
    "",
    "### Usage",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Input tokens | ${scorecard.reliability.usage.input} |`,
    `| Output tokens | ${scorecard.reliability.usage.output} |`,
    `| Cache-read tokens | ${scorecard.reliability.usage.cacheRead} |`,
    `| Cache-write tokens | ${scorecard.reliability.usage.cacheWrite} |`,
    `| Total tokens | ${scorecard.reliability.usage.total} |`,
    `| Turns | ${scorecard.reliability.usage.turns} |`,
    `| Cost | ${cost} |`,
    "",
    "## Revision and model provenance",
    "",
    `- Provider/model: ${code(`${scorecard.modelProfile.provider}/${scorecard.modelProfile.model}`)}`,
    `- Profile status: ${code(scorecard.modelProfile.status)}`,
    `- Profile digest: ${code(scorecard.modelProfile.sha256)}`,
    `- Pricing: ${code(scorecard.modelProfile.pricing)}`,
    ...(scorecard.modelProfile.reviewAfter
      ? [`- Profile review after: ${code(scorecard.modelProfile.reviewAfter)}`]
      : []),
    "",
    "## Run evidence",
    "",
    "| Slot | Run ID | Record digest | Result | Failure class | Structural | Duration (ms) | Attempts | Retries |",
    "| ---: | --- | --- | --- | --- | --- | ---: | ---: | ---: |",
    ...runRows,
    "",
    "## Gate disposition",
    "",
    "| Gate | Status | Owner | Reason |",
    "| --- | --- | --- | --- |",
    ...gateRows,
    "",
    "## Semantic judge",
    "",
    ...judgeLines,
    "",
    "## Dependency disposition",
    "",
    `- Advisory: ${code(scorecard.inputs.dependency.advisoryId)}`,
    `- Status: ${code(scorecard.inputs.dependency.status)}`,
    `- Owner: ${code(scorecard.inputs.dependency.owner)}`,
    ...(scorecard.inputs.dependency.reviewOn
      ? [`- Review on: ${code(scorecard.inputs.dependency.reviewOn)}`]
      : []),
    `- Package-state digest: ${code(scorecard.inputs.dependency.packageStateSha256)}`,
    "",
    "## Remaining work",
    "",
    "| Issue | Scope | Owner | Reason |",
    "| --- | --- | --- | --- |",
    ...remainingRows,
    "",
    "## Reproduction inputs",
    "",
    `- Campaign declaration: ${code(scorecard.campaign.declarationSha256)}`,
    `- Structural fixture: ${code(`${scorecard.inputs.structuralFixture.name}@${scorecard.inputs.structuralFixture.version}`)} (${code(scorecard.inputs.structuralFixture.sha256)})`,
    `- Acceptance manifest: ${code(scorecard.inputs.acceptanceManifest.sha256)} (${scorecard.inputs.acceptanceManifest.passed ? "passed" : "failed"}, live=${String(scorecard.inputs.acceptanceManifest.live)})`,
    "",
    "## Evidence boundary",
    "",
    "Raw records remain operator-private and are not committed. This scorecard contains only revision-bound, content-minimized aggregates and digests.",
    "",
  ].join("\n");
}

function finalizeSanitizationGate(scorecard: MvpScorecardV1): MvpScorecardV1 {
  if (
    scorecard.gates.artifactSanitization !== "pending" &&
    scorecard.gates.artifactSanitization !== "passed"
  ) {
    invalid();
  }
  return scorecard.gates.artifactSanitization === "passed"
    ? scorecard
    : {
        ...scorecard,
        gates: { ...scorecard.gates, artifactSanitization: "passed" },
      };
}

/**
 * Prove that a pair of publication bytes is exactly reproducible from the
 * validated JSON scorecard. Any appended prose or independently composed
 * Markdown fails rather than creating a second, weaker publication surface.
 */
export function assertSanitizedScorecardArtifacts(json: string, markdown: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    invalid();
  }
  assertSafeMvpScorecard(parsed as MvpScorecardV1);
  if (
    serializeMvpScorecard(parsed as MvpScorecardV1) !== json ||
    renderMvpScorecardMarkdown(parsed as MvpScorecardV1) !== markdown
  ) {
    inconsistent();
  }
}

function validateInputs(value: unknown): MvpScorecardV1["inputs"] {
  const inputs = plain(value);
  exact(inputs, ["structuralFixture", "acceptanceManifest", "dependency"]);
  const fixture = plain(inputs.structuralFixture);
  exact(fixture, ["name", "version", "sha256"]);
  if (fixture.name !== FIXTURE_NAME || fixture.version !== 1 || !sha256(fixture.sha256)) {
    invalid();
  }
  const acceptance = plain(inputs.acceptanceManifest);
  exact(acceptance, ["sha256", "passed", "live"]);
  if (
    !sha256(acceptance.sha256) ||
    typeof acceptance.passed !== "boolean" ||
    typeof acceptance.live !== "boolean"
  ) {
    invalid();
  }
  const dependency = plain(inputs.dependency);
  exactOptional(dependency, ["advisoryId", "status", "owner", "packageStateSha256"], ["reviewOn"]);
  if (
    dependency.advisoryId !== "GHSA-mh99-v99m-4gvg" ||
    !oneOf(dependency.status, ["resolved", "contained", "failed"]) ||
    dependency.owner !== "docsfab-maintainers" ||
    !sha256(dependency.packageStateSha256) ||
    (dependency.reviewOn !== undefined && !validDate(dependency.reviewOn)) ||
    (dependency.status === "contained" && dependency.reviewOn === undefined)
  ) {
    invalid();
  }
  return inputs as unknown as MvpScorecardV1["inputs"];
}

function validateReliability(value: unknown): MvpScorecardV1["reliability"] {
  const reliability = plain(value);
  exact(reliability, [
    "sampleSize",
    "successes",
    "failures",
    "observedReliability",
    "firstAttemptSuccesses",
    "recoveredRuns",
    "incidents",
    "terminalFailures",
    "latencyMs",
    "usage",
    "attempts",
    "retries",
    "scheduledBackoffMs",
    "sampleLimitation",
  ]);
  const counts = [
    reliability.successes,
    reliability.failures,
    reliability.firstAttemptSuccesses,
    reliability.recoveredRuns,
    reliability.attempts,
    reliability.retries,
    reliability.scheduledBackoffMs,
  ];
  if (
    reliability.sampleSize !== 5 ||
    counts.some((item) => !natural(item)) ||
    reliability.sampleLimitation !== SAMPLE_LIMITATION
  ) {
    invalid();
  }
  const observed = plain(reliability.observedReliability);
  exact(observed, ["numerator", "denominator", "percentage"]);
  if (!natural(observed.numerator) || observed.denominator !== 5 || !natural(observed.percentage)) {
    invalid();
  }
  validateFailureCounts(reliability.incidents);
  validateFailureCounts(reliability.terminalFailures);
  const latency = plain(reliability.latencyMs);
  exact(latency, ["minimum", "median", "maximum", "sum", "mean"]);
  if (
    [latency.minimum, latency.median, latency.maximum, latency.sum, latency.mean].some(
      (item) => !natural(item),
    )
  ) {
    invalid();
  }
  validateUsage(reliability.usage);
  return reliability as unknown as MvpScorecardV1["reliability"];
}

function validateFailureCounts(value: unknown): void {
  const counts = plain(value);
  exact(counts, FAILURE_CLASSES);
  if (FAILURE_CLASSES.some((failureClass) => !natural(counts[failureClass]))) {
    invalid();
  }
}

function validateUsage(value: unknown): void {
  const usage = plain(value);
  exactOptional(usage, ["input", "output", "cacheRead", "cacheWrite", "total", "turns"], ["cost"]);
  if (
    [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.total, usage.turns].some(
      (item) => !natural(item),
    ) ||
    usage.total !==
      Number(usage.input) +
        Number(usage.output) +
        Number(usage.cacheRead) +
        Number(usage.cacheWrite) ||
    (usage.cost !== undefined &&
      (typeof usage.cost !== "number" || !Number.isFinite(usage.cost) || usage.cost < 0))
  ) {
    invalid();
  }
}

function validateStructural(value: unknown): MvpScorecardV1["structural"] {
  const structural = plain(value);
  exact(structural, ["passed", "failedCampaignAssertions"]);
  if (
    typeof structural.passed !== "boolean" ||
    !Array.isArray(structural.failedCampaignAssertions) ||
    structural.failedCampaignAssertions.some(
      (item) => typeof item !== "string" || !STRUCTURAL_ASSERTIONS.has(item),
    ) ||
    new Set(structural.failedCampaignAssertions).size !== structural.failedCampaignAssertions.length
  ) {
    invalid();
  }
  return structural as unknown as MvpScorecardV1["structural"];
}

function validateRuns(value: unknown): MvpScorecardV1["runs"] {
  if (!Array.isArray(value) || value.length !== 5) invalid();
  const runs = value.map((item) => {
    const run = plain(item);
    exact(run, [
      "slot",
      "id",
      "sha256",
      "structuralPassed",
      "successClass",
      "failureClass",
      "durationMs",
      "usage",
      "attempts",
      "retries",
    ]);
    if (
      !natural(run.slot) ||
      Number(run.slot) < 1 ||
      Number(run.slot) > 5 ||
      !safeId(run.id) ||
      !sha256(run.sha256) ||
      typeof run.structuralPassed !== "boolean" ||
      !oneOf(run.successClass, ["succeeded", "explained-context-stop", "failed"]) ||
      !oneOf(run.failureClass, ["none", ...FAILURE_CLASSES]) ||
      !natural(run.durationMs) ||
      !natural(run.attempts) ||
      !natural(run.retries)
    ) {
      invalid();
    }
    validateUsage(run.usage);
    const zeroAttemptPolicyFailure =
      run.attempts === 0 &&
      run.retries === 0 &&
      run.structuralPassed === false &&
      run.successClass === "failed" &&
      ZERO_ATTEMPT_POLICY_FAILURES.has(run.failureClass as ScorecardFailureClass) &&
      zeroUsage(run.usage);
    if (
      run.attempts === 0 ? !zeroAttemptPolicyFailure : Number(run.retries) >= Number(run.attempts)
    ) {
      invalid();
    }
    return run as unknown as MvpScorecardV1["runs"][number];
  });
  if (
    new Set(runs.map((run) => run.slot)).size !== 5 ||
    new Set(runs.map((run) => run.id)).size !== 5 ||
    new Set(runs.map((run) => run.sha256)).size !== 5 ||
    [...runs]
      .sort((left, right) => left.slot - right.slot)
      .some((run, index) => run.slot !== index + 1)
  ) {
    invalid();
  }
  return runs;
}

function validateGates(value: unknown): MvpScorecardV1["gates"] {
  const gates = plain(value);
  exact(gates, [
    "fiveRunCampaign",
    "structuralEvaluation",
    "packagedLiveAcceptance",
    "modelProfileProvenance",
    "dependencyAdvisory",
    "semanticJudge",
    "artifactSanitization",
    "npmCheck",
    "npmBuild",
    "gitDiffCheck",
  ]);
  for (const key of [
    "fiveRunCampaign",
    "structuralEvaluation",
    "packagedLiveAcceptance",
    "modelProfileProvenance",
    "npmCheck",
    "npmBuild",
    "gitDiffCheck",
  ]) {
    if (!oneOf(gates[key], ["passed", "failed"])) invalid();
  }
  // A renderer that completes successfully is the sanitization proof. A
  // purportedly failed sanitization gate is therefore not a publishable no-go
  // scorecard; accepting it would turn an unperformed/failed check into
  // self-attested evidence.
  if (
    gates.artifactSanitization !== "passed" ||
    !oneOf(gates.dependencyAdvisory, ["passed", "contained", "failed"]) ||
    !oneOf(gates.semanticJudge, ["passed", "contained", "failed"])
  ) {
    invalid();
  }
  return gates as unknown as MvpScorecardV1["gates"];
}

function validateJudge(value: unknown): ScorecardJudgeDisposition {
  const judge = plain(value);
  if (judge.status === "skipped") {
    exact(judge, ["status", "owner", "issue", "reason", "reviewOn"]);
    if (
      !safeOwner(judge.owner) ||
      judge.issue !== 5 ||
      !oneOf(judge.reason, ["judge-destination-not-approved", "judge-evidence-pending"]) ||
      !validDate(judge.reviewOn)
    ) {
      invalid();
    }
    return judge as unknown as ScorecardJudgeDisposition;
  }
  if (!oneOf(judge.status, ["passed", "disagreed", "error"])) invalid();
  const decided = judge.status === "passed" || judge.status === "disagreed";
  exact(
    judge,
    decided
      ? ["status", "rubric", "model", "score", "evidenceSha256"]
      : ["status", "rubric", "model", "evidenceSha256"],
  );
  const rubric = plain(judge.rubric);
  exact(rubric, ["id", "version"]);
  if (
    rubric.id !== "docsfab.semantic-evidence-quality" ||
    rubric.version !== 1 ||
    !sha256(judge.evidenceSha256)
  ) {
    invalid();
  }
  const model = plain(judge.model);
  exact(model, ["provider", "model"]);
  if (
    !safeId(model.provider) ||
    !safeModel(model.model) ||
    (decided &&
      (typeof judge.score !== "number" ||
        !Number.isFinite(judge.score) ||
        judge.score < 0 ||
        judge.score > 1))
  ) {
    invalid();
  }
  return judge as unknown as ScorecardJudgeDisposition;
}

function validateRemainingWork(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) invalid();
  const seen = new Set<string>();
  let issue28 = false;
  let sharedService = false;
  for (const item of value) {
    const work = plain(item);
    exact(work, ["issue", "scope", "owner", "reason"]);
    if (
      !natural(work.issue) ||
      Number(work.issue) < 1 ||
      !oneOf(work.scope, ["issue-28-dogfood", "shared-service"]) ||
      !safeOwner(work.owner) ||
      !oneOf(work.reason, ["product-validation", "post-mvp-scope", "external-governance"]) ||
      (work.scope === "issue-28-dogfood" && work.issue !== 28)
    ) {
      invalid();
    }
    const key = `${String(work.issue)}:${String(work.scope)}`;
    if (seen.has(key)) invalid();
    seen.add(key);
    issue28 ||= work.issue === 28 && work.scope === "issue-28-dogfood";
    sharedService ||= work.scope === "shared-service";
  }
  if (!issue28 || !sharedService) invalid();
}

function validateConsistency(input: {
  decision: MvpDecision;
  decisionReasons: unknown[];
  modelProfile: Record<string, unknown>;
  reliability: MvpScorecardV1["reliability"];
  structural: MvpScorecardV1["structural"];
  runs: MvpScorecardV1["runs"];
  gates: MvpScorecardV1["gates"];
  judge: ScorecardJudgeDisposition;
  inputs: MvpScorecardV1["inputs"];
}): void {
  const terminalCount = FAILURE_CLASSES.reduce(
    (total, failureClass) => total + input.reliability.terminalFailures[failureClass],
    0,
  );
  const usageKeys = ["input", "output", "cacheRead", "cacheWrite", "total", "turns"] as const;
  const summedUsage = Object.fromEntries(
    usageKeys.map((key) => [
      key,
      input.runs.reduce((total, run) => safeNaturalSum(total, run.usage[key]), 0),
    ]),
  ) as Record<(typeof usageKeys)[number], number>;
  const runCosts = input.runs.map((run) => run.usage.cost);
  const expectedCost = runCosts.every((cost) => cost !== undefined)
    ? roundedCost(runCosts.reduce((total, cost) => total + cost!, 0))
    : undefined;
  const expectedPublishedCost = input.modelProfile.pricing === "known" ? expectedCost : undefined;
  if (
    input.reliability.successes + input.reliability.failures !== 5 ||
    input.reliability.observedReliability.numerator !== input.reliability.successes ||
    input.reliability.observedReliability.percentage !== input.reliability.successes * 20 ||
    terminalCount !== input.reliability.failures ||
    input.reliability.firstAttemptSuccesses > input.reliability.successes ||
    input.reliability.recoveredRuns > input.reliability.successes ||
    input.reliability.latencyMs.minimum > input.reliability.latencyMs.median ||
    input.reliability.latencyMs.median > input.reliability.latencyMs.maximum ||
    input.reliability.latencyMs.mean !== Math.round(input.reliability.latencyMs.sum / 5) ||
    input.runs.filter((run) => run.successClass === "succeeded").length !==
      input.reliability.successes ||
    input.runs.reduce((total, run) => total + run.durationMs, 0) !==
      input.reliability.latencyMs.sum ||
    input.runs.reduce((total, run) => total + run.attempts, 0) !== input.reliability.attempts ||
    input.runs.reduce((total, run) => total + run.retries, 0) !== input.reliability.retries ||
    usageKeys.some((key) => summedUsage[key] !== input.reliability.usage[key]) ||
    input.reliability.usage.cost !== expectedPublishedCost ||
    input.runs.some((run) => (run.successClass === "succeeded") !== (run.failureClass === "none"))
  ) {
    inconsistent();
  }
  const sortedDurations = input.runs
    .map((run) => run.durationMs)
    .sort((left, right) => left - right);
  if (
    input.reliability.latencyMs.minimum !== sortedDurations[0] ||
    input.reliability.latencyMs.median !== sortedDurations[2] ||
    input.reliability.latencyMs.maximum !== sortedDurations[4]
  ) {
    inconsistent();
  }
  const expectedJudgeGate =
    input.judge.status === "passed"
      ? "passed"
      : input.judge.status === "error"
        ? "failed"
        : "contained";
  if (
    input.gates.fiveRunCampaign !== (input.reliability.failures === 0 ? "passed" : "failed") ||
    input.gates.structuralEvaluation !== (input.structural.passed ? "passed" : "failed") ||
    input.gates.modelProfileProvenance !==
      (input.modelProfile.status === "current" ? "passed" : "failed") ||
    input.gates.packagedLiveAcceptance !==
      (input.inputs.acceptanceManifest.passed && input.inputs.acceptanceManifest.live
        ? "passed"
        : "failed") ||
    input.gates.dependencyAdvisory !==
      (input.inputs.dependency.status === "resolved" ? "passed" : input.inputs.dependency.status) ||
    input.gates.semanticJudge !== expectedJudgeGate
  ) {
    inconsistent();
  }
  const hardFailure = [
    input.gates.fiveRunCampaign,
    input.gates.structuralEvaluation,
    input.gates.packagedLiveAcceptance,
    input.gates.modelProfileProvenance,
    input.gates.dependencyAdvisory,
    input.gates.semanticJudge,
    input.gates.artifactSanitization,
    input.gates.npmCheck,
    input.gates.npmBuild,
    input.gates.gitDiffCheck,
  ].some((gate) => gate === "failed");
  const contained =
    input.gates.dependencyAdvisory === "contained" ||
    input.gates.semanticJudge === "contained" ||
    input.modelProfile.pricing === "unknown" ||
    input.reliability.usage.cost === undefined;
  const expectedDecision: MvpDecision = hardFailure
    ? "not ready"
    : contained
      ? "ready with contained limitations"
      : "ready for internal MVP dogfood";
  if (
    input.decision !== expectedDecision ||
    JSON.stringify(input.decisionReasons) !==
      JSON.stringify(expectedDecisionReasons(input.gates, input.modelProfile, input.reliability))
  ) {
    inconsistent();
  }
}

function safeNaturalSum(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) inconsistent();
  return result;
}

function roundedCost(value: number): number {
  if (!Number.isFinite(value) || value < 0) inconsistent();
  return Math.round(value * COST_SCALE) / COST_SCALE;
}

function zeroUsage(value: unknown): boolean {
  const usage = value as Record<string, unknown>;
  return (
    usage.input === 0 &&
    usage.output === 0 &&
    usage.cacheRead === 0 &&
    usage.cacheWrite === 0 &&
    usage.total === 0 &&
    usage.turns === 0 &&
    usage.cost === undefined
  );
}

function expectedDecisionReasons(
  gates: MvpScorecardV1["gates"],
  profile: Record<string, unknown>,
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
  if (
    [gates.artifactSanitization, gates.npmCheck, gates.npmBuild, gates.gitDiffCheck].some(
      (gate) => gate === "failed",
    )
  ) {
    reasons.push("local-verification-failed");
  }
  if (reasons.length === 0) reasons.push("all-internal-mvp-gates-passed");
  return reasons;
}

function gateEntries(scorecard: MvpScorecardV1): Array<{
  label: string;
  status: string;
  owner?: string;
  reason?: string;
}> {
  const judge =
    scorecard.judge.status === "skipped"
      ? { owner: scorecard.judge.owner, reason: scorecard.judge.reason }
      : {};
  return [
    { label: "Five-run campaign", status: scorecard.gates.fiveRunCampaign },
    { label: "Structural evaluation", status: scorecard.gates.structuralEvaluation },
    { label: "Packaged live acceptance", status: scorecard.gates.packagedLiveAcceptance },
    { label: "Model-profile provenance", status: scorecard.gates.modelProfileProvenance },
    {
      label: "Dependency advisory",
      status: scorecard.gates.dependencyAdvisory,
      owner: scorecard.inputs.dependency.owner,
      ...(scorecard.inputs.dependency.status === "contained"
        ? { reason: "reviewed-temporary-containment" }
        : {}),
    },
    { label: "Semantic judge", status: scorecard.gates.semanticJudge, ...judge },
    { label: "Artifact sanitization", status: scorecard.gates.artifactSanitization },
    { label: "npm run check", status: scorecard.gates.npmCheck },
    { label: "npm run build", status: scorecard.gates.npmBuild },
    { label: "git diff --check", status: scorecard.gates.gitDiffCheck },
  ];
}

function judgeMarkdown(judge: ScorecardJudgeDisposition): string[] {
  if (judge.status === "skipped") {
    return [
      `- Status: ${code(judge.status)}`,
      `- Owner: ${code(judge.owner)}`,
      `- Tracking issue: #${judge.issue}`,
      `- Reason: ${code(judge.reason)}`,
      `- Review on: ${code(judge.reviewOn)}`,
    ];
  }
  return [
    `- Status: ${code(judge.status)}`,
    `- Rubric: ${code(`${judge.rubric.id}@${judge.rubric.version}`)}`,
    ...(judge.model ? [`- Model: ${code(`${judge.model.provider}/${judge.model.model}`)}`] : []),
    ...(judge.score !== undefined ? [`- Score: ${judge.score}`] : []),
    `- Evidence digest: ${code(judge.evidenceSha256)}`,
  ];
}

function inspectEveryValue(value: unknown): void {
  const seen = new Set<object>();
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      if (
        CONTROL.test(item) ||
        ABSOLUTE_OR_HOST_PATH.test(item) ||
        URL.test(item) ||
        detectCredentialRuleIds(item).length > 0
      ) {
        unsafe();
      }
      return;
    }
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) invalid();
      return;
    }
    if (!item || typeof item !== "object" || seen.has(item)) invalid();
    seen.add(item);
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (Object.getPrototypeOf(item) !== Object.prototype) invalid();
    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key)) unsafe();
      visit(child);
    }
  };
  visit(value);
}

function sortJson(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(sortJson);
  const object = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => [key, sortJson(object[key])]),
  );
}

function plain(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalid();
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) invalid();
}

function exactOptional(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): void {
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    invalid();
  }
}

function safeOwner(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{1,63}$/u.test(value);
}

function safeModel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    SAFE_MODEL.test(value) &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function revision(value: unknown): value is string {
  return typeof value === "string" && REVISION.test(value);
}

function natural(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function isDecision(value: unknown): value is MvpDecision {
  return oneOf(value, [
    "not ready",
    "ready with contained limitations",
    "ready for internal MVP dogfood",
  ]);
}

function code(value: string): string {
  if (value.includes("`") || value.includes("\n") || value.includes("\r")) unsafe();
  return `\`${value}\``;
}

function shortDigest(value: string): string {
  return value.slice(0, 12);
}

function invalid(): never {
  throw new ScorecardRenderError("invalid-shape");
}

function unsafe(): never {
  throw new ScorecardRenderError("unsafe-content");
}

function inconsistent(): never {
  throw new ScorecardRenderError("inconsistent-scorecard");
}
