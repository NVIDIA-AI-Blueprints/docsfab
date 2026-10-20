// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  sourceObligationObserverFixture,
  sourceObligationProposalFixture,
  verificationFixture,
} from "./helpers/verification.js";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  appendFile,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { internalOnly } from "./helpers/internal-path.js";
import { observeQualityArtifactStore } from "./helpers/quality-artifact-store-observer.js";

import { DurableArtifactStore } from "../src/artifacts/store.js";
import { LocalContextPreflightService } from "../src/context/index.js";
import {
  decodeSuccessfulReviewRunRecord,
  PublicationRunRecordDecodeError,
} from "../src/delivery/run-record.js";
import { FileRunStore } from "../src/records/file-store.js";
import { applyRunDeletion, previewRunDeletion } from "../src/records/run-deletion.js";
import { writeRunTombstone } from "../src/records/run-maintenance-gate.js";
import { authoringReviewFindingsRecord } from "./helpers/authoring-review-record.js";
import { handleRunsCommand } from "../src/cli/commands/runs.js";
import { deliverCliRunResult } from "../src/cli/run/delivery.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import { limit } from "../src/config/limits.js";
import * as limitsModule from "../src/config/limits.js";
import { InferenceStepError } from "../src/execution/contracts.js";
import { AnswerRecordHostError } from "../src/harness/answer-record-fill.js";
import {
  EXECUTION_LEASE_DEFAULTS,
  resolveLeaseShapeForTurns,
} from "../src/execution/lease-contracts.js";
import type {
  AgentHarness,
  HarnessStepInput,
  HarnessStepResult,
  InferenceRetryPolicy,
  QualityArtifactCandidateV1,
  QualityAnswerRecordSessionV1,
} from "../src/execution/contracts.js";
import { grantedToolsForStep } from "../src/harness/pi-tool-confine.js";
import { responseCorrectionInstruction } from "../src/harness/response-correction.js";
import {
  describeEvaluationTarget,
  evaluationTargetReplacedLimitation,
  HOST_WRITTEN_EVALUATION_FIELDS,
} from "../src/evaluation-report/evaluation-target.js";
import { QUALITY_RESPONSE_RULE_HINTS } from "../src/workflow-execution/quality-rejection-rule-hints.js";
import { OUTPUT_RECORD_CONTRACTS, outputRuleFor } from "../src/contracts/model-output.js";
import { QUALITY_ANSWER_RECORD_TOOL_NAME } from "../src/harness/answer-submission.js";
import { planAnswerRecords } from "../src/harness/answer-records.js";
import { QUALITY_REPORT_DECLINE_STEM } from "../src/workflow-execution/quality-correction-round.js";
import {
  decodeQualityReportProjection,
  projectQualityReportFromRun,
} from "../src/evaluation-report/contracts.js";
import {
  AUDIENCE_PREREQUISITES_LIMITATION,
  PROFILE_CEILING_LIMITATION,
  QualityArtifactValidationError,
  QualityDerivationError,
  QualityValidatorHost,
} from "../src/evaluation-report/quality-validator-host.js";
import {
  hostCheckError,
  QUALITY_CHECK_REJECTION_CODES,
} from "../src/evaluation-report/quality-check-rejections.js";
import { formatStepRejectionSentence } from "../src/operator/retry-disposition.js";
import { projectRunIndexRows } from "../src/records/run-index.js";
import {
  assertTechnicalFactTrace,
  decodeQualityValidationBinding,
  HOST_CARRIED_LOCATOR_EVIDENCE,
  hostCarriedLocatorDescription,
  inspectTechnicalFactTrace,
  loadStagedQualityArtifact,
  QualityArtifactStagingError,
  renderAdmittedTechnicalFactEvidence,
  sealQualityValidationBinding,
  TECHNICAL_FACT_TRACE_MAX_VIOLATIONS,
} from "../src/evaluation-report/quality-artifact-staging.js";
import { selectDocumentationQualityProfile } from "../src/evaluation-report/quality-profile-selection.js";
import { verifyQualityPackContext } from "../src/quality-pack/manifest.js";
import type { RunRecord } from "../src/records/contracts.js";
import type { RunStore } from "../src/records/contracts.js";
import { buildRepositoryDiscoveryInventory } from "../src/repository/inventory.js";
import { GitPatchEvidenceCollector } from "../src/repository/evidence.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import type { RepositoryWorkspace } from "../src/repository/workspace/contracts.js";
import type { RepositorySecurityScanner } from "../src/security/contracts.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import * as runnerStepLoop from "../src/workflow-execution/runner-step-loop.js";
import {
  createQualityCandidateValidationTool,
  decodeQualityArtifactResponse,
  QualityArtifactEnvelopeError,
} from "../src/harness/quality-candidate-tool.js";
import { resolveLocalReviewScope } from "../src/workflow-execution/local-review-scope.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { projectCandidateReviewResult } from "../src/host-invoker/main.js";
import type { HostRuntimeRequestV1 } from "../src/host-invoker/contracts.js";
import { readyContextPreflight, validModelConfig } from "./helpers.js";
import { createModelEvidence } from "../src/model/profile-evidence.js";
import { governProviderTurn } from "../src/model/turn-governor.js";
import {
  loadVerifiedReviewEvaluationArtifact,
  projectReviewFindingsFromRetainedRun,
  projectReviewFindingsFromRun,
} from "../src/review/index.js";
import { decodeRunResultV1 } from "../src/operator/run-result.js";
import {
  canonicalizeJsonEvidence,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../src/operator/json-evidence.js";
import { loadReviewPresentation } from "../src/operator/review-evidence.js";
import { collectRunResultNextSteps } from "../src/operator/run-summary.js";
import {
  RECORDED_CAPABILITY,
  rawToolCallTurn,
  recordingProvider as fixtureRecordingProvider,
  SUBMIT,
  submissionCall,
  qualityStepInput,
  toolPathHarness as fixtureToolPathHarness,
} from "./support/answer-submission-fixtures.js";
import { textTurn } from "./support/pi-harness-session-fixtures.js";
import {
  decodeAdmittedVerificationSummary,
  TECHNICAL_FACT_DIMENSIONS,
  type VerificationResult,
  validateVerificationResult,
} from "../src/workflow-execution/review-response.js";
import {
  TECHNICAL_CORRECTION_PROPOSAL_KIND,
  bindTechnicalCorrectionResponse,
  bindHostOwnedTechnicalCorrectionProposalV3,
  canonicalSourceObligationProposal,
  requiresSourceObligationLedger,
  requiresTechnicalCorrection,
} from "../src/workflow-execution/source-obligation.js";
import { sealOriginalSourceAuthority } from "../src/workflow-execution/source-obligation-authority.js";
import { registerConfiguredCredential } from "../src/security/configured-credentials.js";
import { configureCredentialsForEachTest } from "./helpers/configured-credential.js";

// Configured for every test: only a configured credential is refused (#1807).
configureCredentialsForEachTest(`glpat-${"x".repeat(24)}`);

const stagedSchemaState = vi.hoisted(() => ({ reviewUnavailable: false }));
vi.mock("../src/evaluation-report/quality-schema-validation.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/evaluation-report/quality-schema-validation.js")>();
  return {
    ...actual,
    validateStagedQualityArtifact: (
      ...args: Parameters<typeof actual.validateStagedQualityArtifact>
    ) =>
      stagedSchemaState.reviewUnavailable && args[0] === "review-result.schema.json"
        ? "schema-unavailable"
        : actual.validateStagedQualityArtifact(...args),
  };
});

const EVALUATOR_IDENTITY = "e".repeat(64);
const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));
const roots: string[] = [];
const workspaces: RepositoryWorkspace[] = [];
const exec = promisify(execFile);

// Opt-in, test-local timing. The normal suite neither wraps calls nor writes a profile.
const qualityProfileOutput = process.env.DOCSFAB_QUALITY_ARTIFACT_PROFILE_OUTPUT;
type QualityProfilePhase =
  | "fixture"
  | "workspace"
  | "quality-pack"
  | "discovery-and-selection"
  | "provider-replay"
  | "correction-replay"
  | "correction-round"
  | "evaluator-harness"
  | "evaluator-validation"
  | "artifact-write"
  | "cleanup"
  | "case-total";
type QualityProfileStamp = { wall: bigint; cpu: NodeJS.CpuUsage };
const qualityProfileRows: Array<{
  caseId: number;
  phase: QualityProfilePhase;
  wallMs: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  outcome: "completed" | "threw";
}> = [];
let qualityProfileCaseId = 0;
let qualityProfileCaseStart: QualityProfileStamp | undefined;

function qualityProfileStamp(): QualityProfileStamp {
  return { wall: process.hrtime.bigint(), cpu: process.cpuUsage() };
}

function qualityProfileRecord(
  phase: QualityProfilePhase,
  start: QualityProfileStamp,
  outcome: "completed" | "threw",
): void {
  const cpu = process.cpuUsage(start.cpu);
  qualityProfileRows.push({
    caseId: qualityProfileCaseId,
    phase,
    wallMs: Number(process.hrtime.bigint() - start.wall) / 1e6,
    cpuUserMs: cpu.user / 1e3,
    cpuSystemMs: cpu.system / 1e3,
    outcome,
  });
}

async function qualityProfilePhase<T>(
  phase: QualityProfilePhase,
  work: () => Promise<T>,
): Promise<T> {
  if (!qualityProfileOutput) return work();
  const start = qualityProfileStamp();
  try {
    const result = await work();
    qualityProfileRecord(phase, start, "completed");
    return result;
  } catch (error) {
    qualityProfileRecord(phase, start, "threw");
    throw error;
  }
}

function recordingProvider(responses: readonly Response[], correctionTurnIndex?: number) {
  const bodies = fixtureRecordingProvider(responses);
  if (qualityProfileOutput) {
    const replay = globalThis.fetch;
    let turnIndex = 0;
    let correctionStart: QualityProfileStamp | undefined;
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      if (correctionStart) {
        qualityProfileRecord("correction-round", correctionStart, "completed");
        correctionStart = undefined;
      }
      const phase = turnIndex++ === correctionTurnIndex ? "correction-replay" : "provider-replay";
      const response = await qualityProfilePhase(phase, () => replay(...args));
      if (phase === "correction-replay") correctionStart = qualityProfileStamp();
      return response;
    });
  }
  return bodies;
}

function toolPathHarness(options: Parameters<typeof fixtureToolPathHarness>[0] = {}) {
  const harness = fixtureToolPathHarness(options);
  if (qualityProfileOutput) {
    const runStep = harness.runStep.bind(harness);
    harness.runStep = async (input) =>
      qualityProfilePhase("evaluator-harness", () => runStep(input));
  }
  return harness;
}

beforeEach(() => {
  if (!qualityProfileOutput) return;
  qualityProfileCaseId += 1;
  qualityProfileCaseStart = qualityProfileStamp();
});

afterAll(async () => {
  if (!qualityProfileOutput) return;
  await writeFile(
    qualityProfileOutput,
    JSON.stringify({ schema: "quality-artifact-test-profile-v1", rows: qualityProfileRows }) + "\n",
  );
});

const HISTORICAL_CORPUS_HOST_LIMITATIONS = new Set([
  AUDIENCE_PREREQUISITES_LIMITATION,
  PROFILE_CEILING_LIMITATION,
  "No supported native documentation checks were found. Supported entry points are documentation lint/check/link package scripts and documentation check Make targets.",
]);
const HISTORICAL_COPY_PATTERNS = [
  /Uncertainty: [^.]*\./gu,
  /(FACT-\d+(?: and its linked issue ID TECH-\d+)?|FACT-\d+ states|TECH-\d+): ([^.]*\.)/gu,
  /FACT-\d+ (Derived from|This is)[^.]*\./gu,
];
const HISTORICAL_HOST_SCOPE_PATTERN =
  /(reviewed|covers exactly) \d+ of \d+ tracked Markdown pages/u;
const HISTORICAL_HOST_INVENTORY_PATTERN = /^Completeness is bounded/u;
// Independent N15 oracle output for the pinned raw fixtures under rule-module
// SHA c65dca4f9d5a9fe14b4dd908d7971afb83ab55d08414ca406af9008f2b2eb2e4 and
// corpus SHA 334933a1b38a3e4fc7a01c9575e1ec302231ddc9ecd591c31b7c3d490825b716.
const HISTORICAL_COHERENCE_LABELS: Readonly<Record<"a" | "b", readonly string[]>> = {
  a: [
    "Coherence: required dimension functional-validity is not met, and no finding names it.",
    "Coherence: required dimension consistency is not met, and no finding names it.",
    "Coherence: required dimension examples is not met, and no finding names it.",
    "Coherence: required dimension task-effectiveness is not met, and no finding names it.",
    "Coherence: required dimension prevention-recovery is not met, and no finding names it.",
    "Coherence: required dimension calibrated-confidence is not met, and no finding names it.",
  ],
  b: [
    "Coherence: required dimension functional-validity is not met, and no finding names it.",
    "Coherence: required dimension consistency is not met, and no finding names it.",
    "Coherence: required dimension task-effectiveness is not met, and no finding names it.",
    "Coherence: required dimension calibrated-confidence is not met, and no finding names it.",
  ],
};

function stripHistoricalCorpusCopies(text: string): string {
  return HISTORICAL_COPY_PATTERNS.reduce((current, pattern) => current.replace(pattern, ""), text);
}

function isHistoricalCorpusHostLimitation(text: string): boolean {
  return (
    HISTORICAL_CORPUS_HOST_LIMITATIONS.has(text) ||
    HISTORICAL_HOST_SCOPE_PATTERN.test(text) ||
    HISTORICAL_HOST_INVENTORY_PATTERN.test(text)
  );
}

function historicalOriginatingIds(finding: Record<string, any>): string[] {
  const text = [
    finding.description,
    ...finding.evidence.map((entry: Record<string, unknown>) => entry.description),
    finding.acceptance_condition,
  ].join(" ");
  const ids = [...new Set(text.match(/\b(?:REV|TECH|FACT)-\d+\b/gu) ?? [])];
  const linkOrder = (id: string): [string, number] => {
    const [namespace, serial] = id.split("-");
    return [namespace ?? "", Number(serial)];
  };
  return ids.sort((left, right) => {
    const [leftNamespace, leftSerial] = linkOrder(left);
    const [rightNamespace, rightSerial] = linkOrder(right);
    return leftNamespace === rightNamespace
      ? leftSerial - rightSerial
      : leftNamespace < rightNamespace
        ? -1
        : 1;
  });
}

function syntheticReplayRecordProjection(
  fixture: "a" | "b",
  evaluation: Record<string, any>,
): Array<{ fixture: string; group: number; type: string; key?: string; record: unknown }> {
  const groups = new Map<number, Array<{ type: string; key?: string; record: unknown }>>([
    [1, []],
    [2, []],
    [3, []],
    [4, []],
  ]);
  const add = (group: number, type: string, record: unknown, key?: string) => {
    groups.get(group)!.push({ type, ...(key === undefined ? {} : { key }), record });
  };
  const hostTargetMembers = new Set([
    "scope_type",
    "paths",
    "repository_revision",
    "documentation_revision",
    "approved_evidence_revision",
    "delivery_surface_locator",
  ]);
  add(
    1,
    "target-judgment",
    Object.fromEntries(
      Object.entries(evaluation.target).filter(([member]) => !hostTargetMembers.has(member)),
    ),
  );

  const gates = new Map<string, string[]>();
  const layered = new Set<string>();
  const attribute = (key: string, gate: string) => {
    const current = gates.get(key) ?? [];
    if (!current.includes(gate)) current.push(gate);
    gates.set(key, current);
  };
  for (const layer of Object.values(evaluation.layers) as Array<Record<string, any>>) {
    const firstNotMet = layer.dimensions.find(
      (dimension: Record<string, unknown>) => dimension.assessment === "not-met",
    );
    for (const gate of layer.hard_gate_failures as string[]) {
      layered.add(gate);
      if (firstNotMet) attribute(firstNotMet.dimension_id as string, gate);
    }
  }
  const notMetConstraint = Object.values(evaluation.constraints).find(
    (constraint: any) => constraint.assessment === "not-met",
  ) as Record<string, unknown> | undefined;
  for (const gate of evaluation.hard_gate_failures as string[]) {
    if (!layered.has(gate) && notMetConstraint) {
      attribute(notMetConstraint.dimension_id as string, gate);
    }
  }
  const addDimension = (
    group: number,
    dimension: Record<string, unknown>,
    key: string,
    keepApplicability: boolean,
  ) => {
    const recordKey = String(dimension.dimension_id);
    const record: Record<string, unknown> = {};
    if (keepApplicability && dimension.applicability !== undefined) {
      record.applicability = dimension.applicability;
    }
    for (const field of [
      "assessment",
      "confidence",
      "evidence",
      "measures",
      "rationale",
    ] as const) {
      if (dimension[field] !== undefined) record[field] = dimension[field];
    }
    record.hard_gate_failures = gates.get(recordKey) ?? [];
    add(group, "dimension", record, recordKey);
  };
  const layerGroups = [
    ["trustworthy_information", 1],
    ["transferable_understanding", 2],
    ["effective_experience", 3],
  ] as const;
  for (const [layerId, group] of layerGroups) {
    for (const dimension of evaluation.layers[layerId].dimensions as Array<
      Record<string, unknown>
    >) {
      addDimension(group, dimension, String(dimension.dimension_id), false);
    }
  }
  for (const [key, constraint] of Object.entries(evaluation.constraints) as Array<
    [string, Record<string, unknown>]
  >) {
    addDimension(4, constraint, key, key === "global_and_localization_readiness");
  }
  for (const finding of evaluation.findings as Array<Record<string, any>>) {
    add(4, "finding", {
      severity: finding.severity,
      dimension_id: finding.dimension_id,
      description: stripHistoricalCorpusCopies(finding.description),
      evidence: finding.evidence.map((entry: Record<string, unknown>) => ({
        ...entry,
        description:
          typeof entry.description === "string"
            ? stripHistoricalCorpusCopies(entry.description)
            : entry.description,
      })),
      acceptance_condition: finding.acceptance_condition,
      originating_ids: historicalOriginatingIds(finding),
    });
  }
  for (const [layerId, group] of layerGroups) {
    add(
      4,
      "layer-note",
      {
        limitations: (evaluation.layers[layerId].limitations as string[]).filter(
          (text) => !isHistoricalCorpusHostLimitation(text),
        ),
      },
      layerId,
    );
  }
  add(4, "evaluation-note", {
    limitations: (evaluation.limitations as string[]).filter(
      (text) => !isHistoricalCorpusHostLimitation(text),
    ),
    findings_complete: true,
  });
  add(4, "quality-score", evaluation.qualityScore ?? null);
  return [...groups.entries()].flatMap(([group, records]) =>
    records.map((entry) => ({ fixture, group, ...entry })),
  );
}

function historicalCorpusEvaluation(evaluation: Record<string, any>): Record<string, any> {
  const projected = structuredClone(evaluation) as Record<string, any>;
  projected.limitations = (projected.limitations as string[]).filter(
    (text) => !isHistoricalCorpusHostLimitation(text),
  );
  for (const layer of Object.values(projected.layers) as Array<Record<string, any>>) {
    layer.limitations = (layer.limitations as string[]).filter(
      (text) => !isHistoricalCorpusHostLimitation(text),
    );
  }
  for (const finding of projected.findings as Array<Record<string, any>>) {
    finding.description = stripHistoricalCorpusCopies(finding.description);
    finding.evidence = finding.evidence.map((entry: Record<string, unknown>) => ({
      ...entry,
      description:
        typeof entry.description === "string"
          ? stripHistoricalCorpusCopies(entry.description)
          : entry.description,
    }));
    delete finding.originating_ids;
  }
  return projected;
}

function historicalHostLimitations(
  evaluation: Record<string, any>,
  profile: Readonly<Record<string, any>>,
  fixture: "a" | "b",
): string[] {
  const limitations: string[] = [];
  const policy = profile.decision_policy as Record<string, unknown>;
  if (
    evaluation.overall_decision === "insufficient-evidence" &&
    profile.status === "experimental" &&
    profile.release_gate_eligible === false &&
    policy.experimental_profile_maximum_decision === "insufficient-evidence"
  ) {
    limitations.push(PROFILE_CEILING_LIMITATION);
  }
  const calibration = profile.calibration as Record<string, unknown>;
  if (
    calibration.human_outcome_baseline === "pending" &&
    calibration.agent_outcome_baseline === "pending"
  ) {
    limitations.push(AUDIENCE_PREREQUISITES_LIMITATION);
  }
  limitations.push(...HISTORICAL_COHERENCE_LABELS[fixture]);
  return limitations;
}

afterEach(async () => {
  stagedSchemaState.reviewUnavailable = false;
  try {
    await qualityProfilePhase("cleanup", async () => {
      await Promise.all(workspaces.splice(0).map((workspace) => workspace.dispose()));
      await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });
  } finally {
    if (qualityProfileOutput && qualityProfileCaseStart) {
      qualityProfileRecord("case-total", qualityProfileCaseStart, "completed");
      qualityProfileCaseStart = undefined;
    }
  }
});

async function fixture(
  discoveryGap = false,
  focused = false,
  outOfScopeDoc = false,
  answerRecordsTestInjection = false,
  syntheticReplayFixture = false,
  answerRecordsExperimentalDiscovery = false,
) {
  const fixtureStart = qualityProfileOutput ? qualityProfileStamp() : undefined;
  const root = await mkdtemp(join(tmpdir(), "docsfab-quality-artifacts-"));
  roots.push(root);
  const repository = join(root, "repository");
  await mkdir(join(repository, "docs"), { recursive: true });
  await writeFile(join(repository, "README.md"), "# Fixture\n");
  await writeFile(join(repository, "docs/guide.md"), "# Guide\n\nDeterministic instructions.\n");
  // Keep the deliberately incorrect quickstart claims: the replay oracle checks
  // correction against this self-contained, public-export-safe source fixture.
  if (syntheticReplayFixture) {
    await writeFile(
      join(repository, "docs/quickstart.md"),
      [
        "# Get started with Sprout",
        "",
        "Sprout prints a greeting in your terminal. Run the command from the repository root.",
        "",
        "## Run a greeting",
        "",
        "Start with the default greeting:",
        "",
        "```sh",
        "node src/sprout.mjs greet",
        "```",
        "",
        "The default name is `world`, so the command prints `Hello, world!`.",
        "",
        "## Structured output",
        "",
        "Pass a name and select JSON output:",
        "",
        "```sh",
        "node src/sprout.mjs greet --name Ada --format json",
        "```",
        "The result contains the greeting in a `greeting` property.",
      ].join("\n") + "\n",
    );
    await writeFile(
      join(repository, "docs/guide.md"),
      "# Sprout guide\n\nThe command accepts text or JSON output. JSON uses a `message` property.\n",
    );
    await mkdir(join(repository, "src"), { recursive: true });
    await writeFile(
      join(repository, "src/sprout.mjs"),
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "if (args.includes('--help')) {",
        "  console.log('Usage: node src/sprout.mjs greet [--name NAME] [--format text|json]');",
        "  console.log('Defaults: name=friend, format=text. No network or config required.');",
        "  process.exit(0);",
        "}",
        "if (args[0] !== 'greet') {",
        "  console.error('Expected command: greet. Use --help for usage.');",
        "  process.exit(2);",
        "}",
        "let name = 'friend';",
        "let format = 'text';",
        "for (let i = 1; i < args.length; i += 2) {",
        "  if (!['--name', '--format'].includes(args[i]) || args[i + 1] === undefined) {",
        "    console.error('Expected --name NAME or --format text|json.');",
        "    process.exit(2);",
        "  }",
        "  if (args[i] === '--name') name = args[i + 1];",
        "  else format = args[i + 1];",
        "}",
        "if (!['text', 'json'].includes(format)) {",
        "  console.error(`Unsupported format: ${format}. Use text or json.`);",
        "  process.exit(2);",
        "}",
        "const message = `Hello, ${name}!`;",
        "console.log(format === 'json' ? JSON.stringify({ message }) : message);",
        "",
      ].join("\n"),
    );
  }
  await writeFile(join(repository, "package.json"), '{"name":"quality-artifact-fixture"}\n');
  if (outOfScopeDoc) {
    await mkdir(join(repository, "docs/private"), { recursive: true });
    await writeFile(join(repository, "docs/private/notes.md"), "# Private notes\n");
  }
  await git(repository, ["init"]);
  await git(repository, ["config", "user.email", "docsfab@example.test"]);
  await git(repository, ["config", "user.name", "DocsFab Test"]);
  await git(repository, ["config", "commit.gpgsign", "false"]);
  if (discoveryGap)
    await writeFile(join(repository, "diagram.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await git(repository, ["add", "-A"]);
  await git(repository, ["commit", "-m", "fixture"]);
  const workspace = await qualityProfilePhase("workspace", () =>
    prepareRepositoryWorkspace(repository, "HEAD"),
  );
  workspaces.push(workspace);
  const pack = await qualityProfilePhase("quality-pack", () =>
    verifyQualityPackContext({
      qualityDirectory: `${runtimeRoot}/quality`,
      qualityPackDirectory: `${runtimeRoot}/quality-pack`,
      skillCrateDirectory: `${runtimeRoot}/skill-crate`,
    }),
  );
  const inventory = await qualityProfilePhase("discovery-and-selection", () =>
    buildRepositoryDiscoveryInventory({ workspace }),
  );
  const reviewScope =
    focused || syntheticReplayFixture
      ? resolveLocalReviewScope({
          inventory,
          instruction: syntheticReplayFixture
            ? "Review exactly docs/quickstart.md. Remain read-only."
            : "Review exactly docs/guide.md. Remain read-only.",
        })
      : undefined;
  const selection = await qualityProfilePhase("discovery-and-selection", () =>
    selectDocumentationQualityProfile({
      workflow: getWorkflow("review-documentation"),
      workspace,
      inventory,
      ...(reviewScope ? { targetPaths: reviewScope.targetPaths } : {}),
      pack,
    }),
  );
  const store = new DurableArtifactStore(join(root, "artifacts"));
  if (qualityProfileOutput) {
    const put = store.put.bind(store);
    store.put = async (artifact, validation) =>
      qualityProfilePhase("artifact-write", () => put(artifact, validation));
    const putRecord = store.putRecord.bind(store);
    store.putRecord = async (digest, value) =>
      qualityProfilePhase("artifact-write", () => putRecord(digest, value));
  }
  const host = new QualityValidatorHost({
    store,
    selection,
    temporaryRoot: join(root, "validator-tmp"),
    answerRecordsTestInjection,
    stateDirectory: join(root, "state"),
    answerRecordsExperimentalDiscovery,
  });
  if (qualityProfileOutput) {
    const validate = host.validate.bind(host);
    host.validate = async (input) =>
      qualityProfilePhase("evaluator-validation", () => validate(input));
  }
  if (fixtureStart) qualityProfileRecord("fixture", fixtureStart, "completed");
  return {
    root,
    workspace,
    sourcePath: workspace.sourcePath,
    workspacePath: workspace.path,
    revision: workspace.revision,
    selection,
    reviewScope,
    store,
    stateDirectory: join(root, "state"),
    host,
  };
}

function closedHostFailureSummary(error: unknown): string {
  if (error === null || typeof error !== "object") return typeof error;
  const value = error as Record<string, unknown>;
  const rejection =
    value.rejection !== null && typeof value.rejection === "object"
      ? (value.rejection as Record<string, unknown>)
      : undefined;
  const stack = typeof value.stack === "string" ? value.stack : "";
  const callsites = stack
    .split("\n")
    .flatMap(
      (line) =>
        /(?:quality-answer-record-admission|quality-validator-host)\.ts:\d+:\d+/u.exec(line)?.[0] ??
        [],
    )
    .slice(0, 4);
  return [
    typeof value.name === "string" ? value.name : "unknown-error",
    typeof rejection?.validator === "string" ? rejection.validator : "",
    typeof rejection?.code === "string"
      ? rejection.code
      : typeof value.code === "string"
        ? value.code
        : "",
    callsites.length > 0 ? callsites.join(">") : "no-host-callsite",
  ]
    .filter(Boolean)
    .join(":");
}

function answerRecordReceiptSummary(bodies: readonly Record<string, unknown>[]) {
  const receipts = new Map<
    string,
    {
      status: string;
      code: string;
      type: string;
      key: string;
      location: string;
      remaining: readonly string[];
    }
  >();
  let latestRemaining: readonly string[] = [];
  for (const body of bodies) {
    for (const message of (body.messages ?? []) as Array<Record<string, unknown>>) {
      if (message.role !== "tool" || typeof message.tool_call_id !== "string") continue;
      if (typeof message.content !== "string") continue;
      try {
        const receipt = JSON.parse(message.content) as Record<string, unknown>;
        if (
          !["admitted", "replaced", "unchanged", "withdrawn", "refused"].includes(
            String(receipt.status),
          )
        )
          continue;
        const remaining = Array.isArray(receipt.remaining)
          ? receipt.remaining.filter((value): value is string => typeof value === "string")
          : [];
        latestRemaining = remaining;
        receipts.set(message.tool_call_id, {
          status: receipt.status,
          code: typeof receipt.code === "string" ? receipt.code : "none",
          type: typeof receipt.type === "string" ? receipt.type : "none",
          key: typeof receipt.key === "string" ? receipt.key : "singleton",
          location: typeof receipt.location === "string" ? receipt.location : "none",
          remaining,
        });
      } catch {
        // A non-receipt tool response contributes no content to this summary.
      }
    }
  }
  const values = [...receipts.values()];
  const statusCounts = new Map<string, number>();
  for (const receipt of values) {
    statusCounts.set(receipt.status, (statusCounts.get(receipt.status) ?? 0) + 1);
  }
  return {
    statusCounts: Object.fromEntries([...statusCounts].sort()),
    refused: values
      .filter((receipt) => receipt.status === "refused")
      .map(({ type, key, code, location }) => ({ type, key, code, location })),
    missingRequiredKeys: latestRemaining,
  };
}

type QualityFixture = Awaited<ReturnType<typeof fixture>>;

function validationInput(
  value: QualityFixture,
  runId: string,
  artifactCandidate: QualityArtifactCandidateV1,
) {
  return {
    runId,
    repositoryRevision: value.revision,
    evaluatorIdentitySha256: EVALUATOR_IDENTITY,
    evaluatorStepId: "evaluate-document-quality",
    evaluatorAttempt: 1,
    evaluatedAt: "2026-10-09T12:00:00.000Z",
    evaluatorProviderId: "fixture-provider",
    candidate: artifactCandidate,
  };
}

function validatedRunRecord(
  value: QualityFixture,
  validated: Awaited<ReturnType<QualityValidatorHost["validate"]>>,
): RunRecord {
  return runRecord(
    value.selection.receipt,
    validated.binding,
    validated.reportMarkdown,
    value.sourcePath,
  );
}

/** The host-written summary; the locked report validator checked it against the rows. */
function validatedSummary(markdown: string): {
  report_contract: string;
  validation: { evaluation: string; quality_score: string; report_binding: string };
  limitations: string[];
  retained_gap_evidence: Array<{ limitation: string }>;
} {
  const blocks = [
    ...markdown.matchAll(
      /^## Validated result summary\s+^```json\s*$\n(?<json>\{.*?\})\n^```$/gmsu,
    ),
  ];
  expect(blocks).toHaveLength(1);
  return JSON.parse(blocks[0]!.groups!.json!) as {
    limitations: string[];
    retained_gap_evidence: Array<{ limitation: string }>;
  };
}

function reviewRunRequest(value: QualityFixture) {
  return {
    workflow: "review-documentation" as const,
    workspacePath: value.workspacePath,
    repository: {
      sourcePath: value.sourcePath,
      requestedRevision: "HEAD",
      revision: value.revision,
    },
    allowWrite: false,
  };
}

function safeRunFailureSummary(record: RunRecord): string {
  return JSON.stringify({
    recordError: record.error?.split(/\r?\n/u)[0]?.slice(0, 240) ?? "none",
    steps: record.steps.map((step) => [
      step.skill,
      step.status,
      step.failure?.code ?? "none",
      step.error?.split(/\r?\n/u)[0]?.slice(0, 240) ?? "none",
    ]),
  });
}

function qualityRunnerOptions(value: QualityFixture, host: QualityValidatorHost = value.host) {
  return {
    repositoryScanner: passedScanner,
    contextPreflight: readyContextPreflight,
    workflowSearch: new LocalWorkflowSearchCoordinator(),
    sourceObligationObserver: sourceObligationObserverFixture,
    qualityPackEvidence: value.selection.pack.evidence,
    qualityValidation: { selection: value.selection, host },
  };
}

/**
 * The reconstructed historical corpus cites the checked-in Sprout source.
 * The generic source-obligation test observer seals a small canned path set;
 * this corpus fixture instead seals the exact tracked tree bytes so its later
 * source checks are backed by the real fixture repository.
 */
function historicalSourceObligationObserver(value: QualityFixture, trace: string[] = []) {
  const digest = async (path: string) =>
    createHash("sha256")
      .update(await readFile(join(value.workspacePath, path)))
      .digest("hex");
  return {
    observe: async (paths: readonly string[]) => {
      trace.push(`source-observe:start:${paths.length}`);
      try {
        const observed = await Promise.all(
          paths.map(async (path) => ({ path, sha256: await digest(path) })),
        );
        trace.push(`source-observe:ok:${observed.length}`);
        return observed;
      } catch (error) {
        trace.push(`source-observe:error:${error instanceof Error ? error.name : typeof error}`);
        throw error;
      }
    },
    assertUnchanged: async (
      sources: readonly { readonly path: string; readonly sha256: string }[],
      allowedChangedPaths: readonly string[] = [],
    ) => {
      trace.push(`source-recheck:start:${sources.length}`);
      const allowed = new Set(allowedChangedPaths);
      const protectedSources = sources.filter(({ path }) => !allowed.has(path));
      const current = new Map(
        await Promise.all(
          protectedSources.map(async ({ path }) => [path, await digest(path)] as const),
        ),
      );
      if (protectedSources.some(({ path, sha256 }) => current.get(path) !== sha256)) {
        trace.push("source-recheck:error:DigestMismatch");
        throw new Error("Historical source fixture changed after its evidence was sealed.");
      }
      trace.push("source-recheck:ok");
    },
    captureOriginalSourceAuthority: async (input: {
      runId: string;
      workflow: import("../src/workflow-contracts/contracts.js").WorkflowDefinition;
      repositoryRevision: string;
      scopeSha256: string;
      workspaceSnapshotSha256: string;
    }) => {
      trace.push("source-authority:start");
      if (input.workflow.name !== "review-documentation") {
        trace.push("source-authority:error:WrongWorkflow");
        throw new Error("Historical source authority is limited to the review fixture.");
      }
      const trackedPaths = (await git(value.sourcePath, ["ls-files", "-z"]))
        .split("\0")
        .filter(Boolean)
        .sort();
      if (!trackedPaths.includes("src/sprout.mjs")) {
        trace.push("source-authority:error:MissingTrackedSprout");
        throw new Error("Historical source authority is missing the cited Sprout implementation.");
      }
      const members = await Promise.all(
        trackedPaths.map(async (path) => {
          const absolutePath = join(value.workspacePath, path);
          const metadata = await lstat(absolutePath);
          if (!metadata.isFile() || metadata.isSymbolicLink()) {
            throw new Error("Historical source authority requires tracked regular files.");
          }
          const bytes = await readFile(absolutePath);
          return {
            path,
            mode: metadata.mode & 0o777,
            byteLength: bytes.byteLength,
            sourceSha256: createHash("sha256").update(bytes).digest("hex"),
          };
        }),
      );
      const descriptor = sealOriginalSourceAuthority({
        ...input,
        scope: "review-tracked-workspace",
        members,
      });
      trace.push(`source-authority:ok:${members.length}`);
      return descriptor;
    },
  };
}

function qualityAnswerRecordCalls(
  artifact: ReturnType<typeof candidate>,
  profile: Readonly<Record<string, unknown>>,
  reverse = false,
) {
  const calls: Array<{ id: string; name: string; chunks: readonly string[] }> = [];
  const submit = (type: string, key: string | null, record: unknown) => {
    const raw = JSON.stringify({ type, ...(key === null ? {} : { key }), record });
    calls.push({
      id: `quality-record-${calls.length + 1}`,
      name: QUALITY_ANSWER_RECORD_TOOL_NAME,
      chunks: [raw],
    });
  };
  const target = { ...(artifact.evaluation.target as Record<string, unknown>) };
  for (const field of [
    "scope_type",
    "paths",
    "repository_revision",
    "documentation_revision",
    "approved_evidence_revision",
    "delivery_surface_locator",
  ])
    delete target[field];
  if (Array.isArray(target.documentation_family_evidence)) {
    target.documentation_family_evidence = target.documentation_family_evidence.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
      const evidence = entry as Record<string, unknown>;
      return {
        ...evidence,
        ...(Array.isArray(evidence.paths)
          ? { paths: evidence.paths.map((path) => (path === "docs/" ? "docs" : path)) }
          : {}),
      };
    });
  }
  submit("target-judgment", null, target);

  const layers = artifact.evaluation.layers as Record<
    string,
    { dimensions: Array<Record<string, unknown>> }
  >;
  const requiredDimensions = requiredProfileDimensionIds(profile);
  for (const layer of Object.values(layers)) {
    for (const dimension of layer.dimensions) {
      const key = String(dimension.dimension_id);
      const record: Record<string, unknown> = { ...dimension, hard_gate_failures: [] };
      delete record.dimension_id;
      if (requiredDimensions.has(key)) delete record.applicability;
      submit("dimension", key, record);
    }
  }
  const constraints = artifact.evaluation.constraints as Record<string, Record<string, unknown>>;
  const profileConstraints = profile.constraints as {
    required: string[];
    conditional: string[];
  };
  const hostDerivedConstraintApplicability = new Set(
    profileConstraints.required.map((key) => key.replaceAll("-", "_")),
  );
  for (const key of [...profileConstraints.required, ...profileConstraints.conditional]) {
    const member = key.replaceAll("-", "_");
    const record = { ...constraints[member]!, hard_gate_failures: [] };
    delete record.dimension_id;
    if (hostDerivedConstraintApplicability.has(member)) delete record.applicability;
    submit("dimension", key, record);
  }
  for (const finding of artifact.evaluation.findings as Array<Record<string, unknown>>) {
    const record = { ...finding };
    for (const field of ["id", "owner", "status"]) delete record[field];
    submit("finding", null, record);
  }
  submit("evaluation-note", null, {
    limitations: artifact.evaluation.limitations,
    findings_complete: true,
  });
  // The provider-facing schema accepts an object or one JSON string, not a JSON
  // null token. The separately named probe keeps the raw-null normalization
  // counterexample so the host still proves captured bytes are authoritative.
  submit("quality-score", null, "null");
  const ordered = reverse ? [...calls].reverse() : calls;
  return ordered.map((call, index) => ({ ...call, id: `quality-record-${index + 1}` }));
}

function answerRecordReceiptFor(
  bodies: readonly Record<string, unknown>[],
  toolCallId: string,
): Record<string, unknown> | undefined {
  for (const body of bodies) {
    for (const message of (body.messages ?? []) as Array<Record<string, unknown>>) {
      if (
        message.role !== "tool" ||
        message.tool_call_id !== toolCallId ||
        typeof message.content !== "string"
      )
        continue;
      try {
        return JSON.parse(message.content) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

async function runPiQualityRecordCalls(
  value: Awaited<ReturnType<typeof fixture>>,
  calls: ReturnType<typeof qualityAnswerRecordCalls>,
  reportMarkdown = candidate(value.selection.profile, value.revision).reportMarkdown,
  options: { readonly composition?: boolean } = {},
) {
  const technical = technicalVerification();
  const piHarness = toolPathHarness({
    maxProviderTurns: EXECUTION_LEASE_DEFAULTS.maxProviderTurns,
    instantReplay: true,
    ...(options.composition === undefined ? {} : { composition: options.composition }),
  });
  const batches = Array.from({ length: Math.ceil(calls.length / 8) }, (_, index) =>
    calls.slice(index * 8, (index + 1) * 8),
  );
  const bodies = recordingProvider([
    ...batches.map((batch) => rawToolCallTurn(batch)),
    textTurn(reportMarkdown),
  ]);
  const harness: AgentHarness = {
    qualityAnswerRecordRouteBindingSha256: () => "f".repeat(64),
    qualityAnswerRecordProviderId: () => piHarness.qualityAnswerRecordProviderId(),
    runStep: async (input) => {
      if (input.step.skill === "evaluate-document-quality") return await piHarness.runStep(input);
      if (input.step.skill === "verify-technical-accuracy")
        return await technicalPhaseFixture(input, technical);
      if (input.step.skill === "review-documentation")
        return { summary: JSON.stringify({ verdict: "pass", issues: [] }) };
      return { summary: `${input.step.skill} completed` };
    },
  };
  const record = await new WorkflowRunner({
    harness,
    hostOperations: {
      runStep: async (input) => ({ summary: `${input.step.skill} completed` }),
    },
    store: new MemoryStore(),
    ...qualityRunnerOptions(value),
    id: () => "quality-records-caller-path-mutant",
  }).run(reviewRunRequest(value));
  return { record, bodies };
}

function expectExhaustedProviderTurn(
  record: RunRecord,
  bodies: readonly Record<string, unknown>[],
  scriptedResponses: number,
) {
  const step = record.steps.at(-1)!;
  expect(step).toMatchObject({ status: "failed", failure: { code: "provider-network" } });
  expect(step.inference?.attempts).toHaveLength(1);
  const attempt = step.inference!.attempts[0]!;
  expect(attempt).toMatchObject({
    outcome: "provider-transient",
    retryDecision: "declined",
    retryScheduled: false,
  });
  const maxAttempts = limit("providerAttempt.maxAttemptsPerTurn").value;
  expect(attempt.turns?.at(-1)).toMatchObject({
    providerRetries: maxAttempts - 1,
    providerReplayVeto: "attempts-exhausted",
  });
  // Earlier scripted turns succeeded; the catalog bound applies only to this tail.
  const exhaustedRequests = bodies.slice(scriptedResponses);
  expect(exhaustedRequests).toHaveLength(maxAttempts);
  expect(new Set(exhaustedRequests.map((body) => canonicalDigest(body))).size).toBe(1);
}

function callerGuardCandidate(value: QualityFixture, descriptionSuffix = "") {
  const artifact = candidate(value.selection.profile, value.revision, [
    {
      ...tracedFinding(),
      description:
        "FACT-TRACE-001 consolidates the source gap linked to TECH-001." + descriptionSuffix,
      originating_ids: ["FACT-TRACE-001", "TECH-001"],
    },
  ]);
  artifact.selectionSha256 = value.selection.receipt.selectionSha256;
  artifact.evaluation.limitations = [
    "Direct outcome evidence is unavailable.",
    "The focused source inventory does not prove repository-wide completeness.",
    "The environment prerequisite source is unavailable.",
    "environment-prerequisite: The environment prerequisite source is unavailable.",
  ];
  return artifact;
}

function qualityProfileRecordCallCeiling(profile: Readonly<Record<string, unknown>>): number {
  const applicability = profile.applicability as {
    documentation_set: { required_dimensions_by_layer: Record<string, string[]> };
  };
  const dimensionsByLayer = applicability.documentation_set.required_dimensions_by_layer;
  const constraints = profile.constraints as { required: string[]; conditional: string[] };
  const member = (key: string) => key.replaceAll("-", "_");
  return planAnswerRecords({
    declaration: OUTPUT_RECORD_CONTRACTS["quality-evaluation"],
    skeletons: {
      dimensions: Object.entries(dimensionsByLayer).flatMap(([layer, keys]) =>
        keys.map((key) => ({ key, slot: layer })),
      ),
      constraints: [...constraints.required, ...constraints.conditional].map((key) => ({
        key,
        slot: member(key),
      })),
      layers: Object.keys(dimensionsByLayer).map((key) => ({ key, slot: key })),
    },
    selectors: { required: constraints.required.map(member) },
  }).recordCallCeiling;
}

async function historicalQualityRecordFixture(
  name: "a" | "b",
  selectedProfile: Readonly<Record<string, unknown>>,
  minimalO4 = false,
) {
  const fixturePath = join(
    runtimeRoot,
    "..",
    "quality",
    "tests",
    "fixtures",
    "documentation-quality-evaluation",
    `review-live-main-f05a81f1-${name}.json`,
  );
  const rawEvaluation = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, any>;
  // Frozen projections of the public expected evaluations replace the internal corpus file.
  const records = syntheticReplayRecordProjection(name, rawEvaluation);
  expect(records).toHaveLength(43);
  expect(records.map(({ group }) => group)).toEqual([
    ...Array.from({ length: 9 }, () => 1),
    ...Array.from({ length: 10 }, () => 2),
    ...Array.from({ length: 10 }, () => 3),
    ...Array.from({ length: 14 }, () => 4),
  ]);
  expect(records.map(({ type }) => type)).toEqual([
    "target-judgment",
    ...Array.from({ length: 33 }, () => "dimension"),
    ...Array.from({ length: 4 }, () => "finding"),
    ...Array.from({ length: 3 }, () => "layer-note"),
    "evaluation-note",
    "quality-score",
  ]);
  const requiredDimensions = requiredProfileDimensionIds(selectedProfile);
  const requiredConstraints = new Set(
    ((selectedProfile.constraints as Record<string, unknown>).required as string[]).map((id) =>
      id.replaceAll("-", "_"),
    ),
  );
  const calls = records.map((entry, index) => {
    const record = structuredClone(entry.record) as Record<string, unknown> | null;
    if (entry.type === "dimension" && entry.key && record) {
      const member = entry.key.replaceAll("-", "_");
      if (Object.hasOwn(rawEvaluation.constraints ?? {}, member)) {
        if (!requiredConstraints.has(member)) {
          const applicability = rawEvaluation.constraints[member]?.applicability;
          if (applicability !== undefined) record.applicability = applicability;
        }
      } else if (!requiredDimensions.has(entry.key)) {
        const rawDimension = Object.values(
          rawEvaluation.layers as Record<string, { dimensions: Array<Record<string, unknown>> }>,
        )
          .flatMap((layer) => layer.dimensions)
          .find((dimension) => dimension.dimension_id === entry.key);
        if (rawDimension?.applicability !== undefined) {
          record.applicability = rawDimension.applicability;
        }
      }
    }
    if (minimalO4 && entry.type === "dimension" && record) {
      record.hard_gate_failures = entry.key === "examples" ? ["broken-required-example"] : [];
    }
    // The advertised provider schema accepts object|string; represent nullable
    // records as the single JSON string "null" on the wire.
    const transportedRecord = entry.type === "quality-score" && record === null ? "null" : record;
    return {
      id: `historical-${name}-${index + 1}`,
      name: QUALITY_ANSWER_RECORD_TOOL_NAME,
      chunks: [
        JSON.stringify({
          type: entry.type,
          ...(entry.key === undefined ? {} : { key: entry.key }),
          record: transportedRecord,
        }),
      ],
    };
  });
  return { rawEvaluation, records, calls };
}

function scrambleHistoricalRecordCalls(
  calls: Array<{ id: string; name: string; chunks: readonly string[] }>,
) {
  const findingCalls: typeof calls = [];
  const otherCalls: typeof calls = [];
  for (const call of calls) {
    const parsed = JSON.parse(call.chunks[0]!) as { type?: unknown; key?: unknown };
    if (parsed.type === "finding" && parsed.key === undefined) findingCalls.push(call);
    else otherCalls.push(call);
  }
  // Finding IDs are issued by the host in arrival order. Preserve that serial
  // while scrambling all keyed and singleton records around it.
  return [...otherCalls.reverse(), ...findingCalls];
}

function historicalApplyContract(
  input: Record<string, any>,
  profile: Readonly<Record<string, unknown>>,
) {
  const corrected = structuredClone(input) as Record<string, any>;
  const requiredByLayer = (
    (profile.applicability as Record<string, any>).documentation_set as Record<string, any>
  ).required_dimensions_by_layer as Record<string, string[]>;
  const lowestOverall: number[] = [];
  for (const [layerId, layer] of Object.entries(
    corrected.layers as Record<string, Record<string, any>>,
  )) {
    const required = new Set(requiredByLayer[layerId] ?? []);
    const requiredConfidences: number[] = [];
    for (const dimension of layer.dimensions as Array<Record<string, any>>) {
      if (!required.has(dimension.dimension_id)) continue;
      if (dimension.assessment === "not-applicable") {
        dimension.assessment = "not-assessed";
        for (const evidence of dimension.evidence as Array<Record<string, unknown>>) {
          evidence.strength = "none";
        }
        layer.limitations.push(
          `${dimension.dimension_id} was not assessed from the available evidence.`,
        );
      }
      requiredConfidences.push(Number(dimension.confidence));
    }
    if (requiredConfidences.length > 0) {
      layer.confidence = Math.min(Number(layer.confidence), ...requiredConfidences);
      lowestOverall.push(...requiredConfidences);
    }
  }
  if (lowestOverall.length > 0) {
    corrected.confidence = Math.min(Number(corrected.confidence), ...lowestOverall);
  }
  corrected.outcomes = { human: [], agent: [] };
  return corrected;
}

function historicalMinimalO4Oracle(
  input: Record<string, any>,
  profile: Readonly<Record<string, unknown>>,
) {
  const corrected = historicalApplyContract(input, profile);
  const layerOutcomes = {
    effective_experience: { decision: "insufficient-evidence", hard_gate_failures: [] },
    transferable_understanding: {
      decision: "fail",
      hard_gate_failures: ["broken-required-example"],
    },
    trustworthy_information: { decision: "insufficient-evidence", hard_gate_failures: [] },
  } as const;
  corrected.hard_gate_failures = ["broken-required-example"];
  corrected.overall_decision = "fail";
  for (const [layerId, layer] of Object.entries(
    corrected.layers as Record<string, Record<string, any>>,
  )) {
    layer.hard_gate_failures = [
      ...layerOutcomes[layerId as keyof typeof layerOutcomes].hard_gate_failures,
    ];
    layer.decision = layerOutcomes[layerId as keyof typeof layerOutcomes].decision;
  }
  return corrected;
}

function historicalDifferencePaths(
  left: unknown,
  right: unknown,
  path = "$",
  output: string[] = [],
) {
  if (output.length >= 20) return output;
  if (Object.is(left, right)) return output;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) !== Array.isArray(right)
  ) {
    output.push(path);
    return output;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) output.push(`${path}.length`);
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
      historicalDifferencePaths(left[index], right[index], `${path}[${index}]`, output);
    }
    return output;
  }
  const leftObject = left as Record<string, unknown>;
  const rightObject = right as Record<string, unknown>;
  for (const key of [
    ...new Set([...Object.keys(leftObject), ...Object.keys(rightObject)]),
  ].sort()) {
    if (!Object.hasOwn(leftObject, key) || !Object.hasOwn(rightObject, key)) {
      output.push(`${path}.${key}`);
    } else {
      historicalDifferencePaths(leftObject[key], rightObject[key], `${path}.${key}`, output);
    }
  }
  return output;
}

function normalizeHistoricalHostFields(
  actual: Record<string, any>,
  expected: Record<string, any>,
  input: {
    runId: string;
    stepId: string;
    startedAt: string;
    completedAt: string;
    revision: string;
    profile: Readonly<Record<string, any>>;
    targetPaths: readonly string[];
    providerId: string;
    technical: VerificationResult;
    reviewIssues: readonly Record<string, unknown>[];
    fixtureName: "a" | "b";
    originIdsByFindingId: Readonly<Record<string, readonly string[]>>;
    expectedHostLimitations: readonly string[];
  },
) {
  const normalizedActual = structuredClone(actual) as Record<string, any>;
  const normalizedExpected = structuredClone(expected) as Record<string, any>;
  const expectedProfile = {
    id: input.profile.receipt.profileId,
    version: input.profile.receipt.profileVersion,
  };
  const expectedEvaluator = {
    provider_id: input.providerId,
    provider_type: "agent",
    independent_of_authors: false,
    independence_evidence:
      "The host bound the configured evaluator identity, but no author-independence evidence was admitted.",
  };
  expect(normalizedActual.evaluation_id).toBe(`${input.runId}:${input.stepId}:1`);
  expect(normalizedActual.profile).toEqual(expectedProfile);
  expect(normalizedActual.model_version).toBe(input.profile.receipt.profileModel);
  expect(normalizedActual.evaluator).toEqual(expectedEvaluator);
  const evaluatedAt = Date.parse(normalizedActual.evaluated_at);
  expect(Number.isFinite(evaluatedAt)).toBe(true);
  expect(evaluatedAt).toBeGreaterThanOrEqual(Date.parse(input.startedAt));
  expect(evaluatedAt).toBeLessThanOrEqual(Date.parse(input.completedAt));
  const targetHostFields = {
    scope_type: input.profile.receipt.targetScope,
    paths: [...input.targetPaths],
    repository_revision: input.revision,
    documentation_revision: input.revision,
    approved_evidence_revision: input.revision,
    delivery_surface_locator: describeEvaluationTarget(input.profile.evaluationTarget),
  };
  for (const [key, value] of Object.entries(targetHostFields)) {
    expect(normalizedActual.target[key]).toEqual(value);
  }
  for (const finding of normalizedActual.findings as Array<Record<string, any>>) {
    expect(finding.owner).toBe("documentation-owner");
    expect(finding.status).toBe("open");
  }
  expect(normalizedActual.findings.map((finding: Record<string, unknown>) => finding.id)).toEqual(
    normalizedActual.findings.map((_: unknown, index: number) => `F-${index + 1}`),
  );

  // O7 additions are removed only after exact source-bound rendering and
  // originating-ID pairing checks. All model-authored evidence remains exact.
  const facts = input.technical.factInventory.dimensions.flatMap(({ facts }) => facts);
  const factsById = new Map(facts.map((fact) => [fact.id, fact]));
  const technicalIssues = input.technical.review.issues as Array<Record<string, unknown>>;
  const technicalIssuesById = new Map(technicalIssues.map((issue) => [String(issue.id), issue]));
  const reviewIssuesById = new Map(input.reviewIssues.map((issue) => [String(issue.id), issue]));
  for (const [index, actualFinding] of (
    normalizedActual.findings as Array<Record<string, any>>
  ).entries()) {
    const expectedFinding = normalizedExpected.findings[index] as Record<string, any>;
    const origins = input.originIdsByFindingId[String(actualFinding.id)] ?? [];
    // The independent apply_contract artifact intentionally omits host-only
    // linkage metadata. The durable input row is checked against the corpus
    // before this normalization; do not infer source IDs from the output.
    expect(actualFinding).not.toHaveProperty("originating_ids");
    const unknownOrigins = origins.filter(
      (id) => !factsById.has(id) && !technicalIssuesById.has(id) && !reviewIssuesById.has(id),
    );
    expect(unknownOrigins).toEqual([]);
    const modelEvidence = expectedFinding.evidence as Array<Record<string, unknown>>;
    const expectedFactRows = origins.flatMap((id) => {
      const fact = factsById.get(id);
      if (!fact || fact.documentationDisposition === "documented") return [];
      expect(fact.issueIds).toEqual([
        (HISTORICAL_FACT_ISSUES[input.fixtureName] as Record<string, string>)[fact.id],
      ]);
      return [renderAdmittedTechnicalFactEvidence(fact)];
    });
    const issueRow = (issue: Record<string, unknown>) => ({
      provider_id: "docsfab-host-issue-render",
      evidence_class: "grounded-judgment",
      strength: "derived",
      locator: String(issue.location),
      description: String(issue.finding),
    });
    const expectedIssueRows = [
      ...origins.flatMap((id) => {
        const issue = technicalIssuesById.get(id);
        return issue ? [issueRow(issue)] : [];
      }),
      ...origins.flatMap((id) => {
        const issue = reviewIssuesById.get(id);
        return issue ? [issueRow(issue)] : [];
      }),
    ];
    const expectedEvidence = [...modelEvidence, ...expectedFactRows, ...expectedIssueRows];
    const actualEvidence = actualFinding.evidence as Array<Record<string, unknown>>;
    const evidenceDiffFields = Array.from(
      { length: Math.max(actualEvidence.length, expectedEvidence.length) },
      (_, row) => {
        const actualRow: Record<string, unknown> | undefined = actualEvidence[row];
        const expectedRow: Record<string, unknown> | undefined = expectedEvidence[row];
        const fields = new Set([
          ...Object.keys(actualRow ?? {}),
          ...Object.keys(expectedRow ?? {}),
        ]);
        const changed = [...fields].filter(
          (field) => JSON.stringify(actualRow?.[field]) !== JSON.stringify(expectedRow?.[field]),
        );
        return changed.length ? { row, fields: changed } : undefined;
      },
    ).filter((entry): entry is { row: number; fields: string[] } => entry !== undefined);
    if (evidenceDiffFields.length > 0 || actualEvidence.length !== expectedEvidence.length) {
      throw new Error(
        `historical rendered evidence mismatch: ${JSON.stringify({
          findingId: actualFinding.id,
          actualCount: actualEvidence.length,
          expectedCount: expectedEvidence.length,
          actualDigest: createHash("sha256").update(JSON.stringify(actualEvidence)).digest("hex"),
          expectedDigest: createHash("sha256")
            .update(JSON.stringify(expectedEvidence))
            .digest("hex"),
          differingRows: evidenceDiffFields,
          modelEvidenceCount: modelEvidence.length,
          factEvidenceCount: expectedFactRows.length,
          issueEvidenceCount: expectedIssueRows.length,
        })}`,
      );
    }
    actualFinding.evidence = structuredClone(modelEvidence);
  }

  for (const target of [normalizedActual, normalizedExpected]) {
    target.evaluation_id = "<verified-host-run-step-attempt>";
    target.evaluated_at = "<verified-host-time>";
    target.profile = expectedProfile;
    target.model_version = input.profile.receipt.profileModel;
    target.evaluator = expectedEvaluator;
    for (const [key, value] of Object.entries(targetHostFields)) target.target[key] = value;
    for (const [index, finding] of (target.findings as Array<Record<string, unknown>>).entries()) {
      finding.id = `F-${index + 1}`;
      finding.owner = "documentation-owner";
      finding.status = "open";
    }
  }
  const expectedHostSet = new Set(input.expectedHostLimitations);
  const actualHostLimitations = (normalizedActual.limitations as string[]).filter(
    (limitation) => isHistoricalCorpusHostLimitation(limitation) || expectedHostSet.has(limitation),
  );
  expect(
    [...actualHostLimitations].sort(),
    JSON.stringify({
      fixture: input.fixtureName,
      assertion: "exact-host-limitations",
      actualHostLimitations,
      expectedHostLimitations: input.expectedHostLimitations,
    }),
  ).toEqual([...input.expectedHostLimitations].sort());
  const actualModelLimitations = (normalizedActual.limitations as string[]).filter(
    (limitation) =>
      !isHistoricalCorpusHostLimitation(limitation) && !expectedHostSet.has(limitation),
  );
  expect(
    actualModelLimitations,
    JSON.stringify({
      fixture: input.fixtureName,
      assertion: "retained-model-limitations",
      actualModelLimitations,
      expectedModelLimitations: normalizedExpected.limitations,
    }),
  ).toEqual(normalizedExpected.limitations);
  // Host-derived limitations have a separate exact assertion above; compare
  // model-owned order and content without making incidental host ordering an
  // oracle input.
  normalizedActual.limitations = [...actualModelLimitations, ...[...actualHostLimitations].sort()];
  normalizedExpected.limitations = [
    ...normalizedExpected.limitations,
    ...[...input.expectedHostLimitations].sort(),
  ];
  return { actual: normalizedActual, expected: normalizedExpected };
}

function historicalCorrectionCalls(
  name: "a" | "b",
  rawEvaluation: Record<string, any>,
  records: Array<{ type: string; key?: string; record: unknown }>,
  profile: Readonly<Record<string, unknown>>,
) {
  const required = requiredProfileDimensionIds(profile);
  const corrections: Array<{ type: string; key: string; record: Record<string, unknown> }> = [];
  const correctedLayerNotes = new Map<string, Record<string, unknown>>();
  for (const entry of records) {
    if (
      entry.type !== "dimension" ||
      !entry.key ||
      !required.has(entry.key) ||
      !entry.record ||
      typeof entry.record !== "object" ||
      Array.isArray(entry.record)
    )
      continue;
    const record = structuredClone(entry.record) as Record<string, any>;
    if (record.assessment !== "not-applicable") continue;
    record.assessment = "not-assessed";
    if (Array.isArray(record.evidence)) {
      for (const evidence of record.evidence) {
        if (evidence && typeof evidence === "object" && !Array.isArray(evidence)) {
          (evidence as Record<string, unknown>).strength = "none";
        }
      }
    }
    corrections.push({ type: "dimension", key: entry.key, record });
    const layer = Object.entries(rawEvaluation.layers as Record<string, any>).find(([, value]) =>
      value.dimensions.some(
        (dimension: Record<string, unknown>) => dimension.dimension_id === entry.key,
      ),
    )?.[0];
    if (!layer) throw new Error(`Required dimension ${entry.key} has no layer.`);
    let note = correctedLayerNotes.get(layer);
    if (!note) {
      const existing = records.find(
        (candidate) => candidate.type === "layer-note" && candidate.key === layer,
      );
      note = structuredClone(existing?.record ?? { limitations: [] }) as Record<string, unknown>;
    } else {
      note = structuredClone(note);
    }
    const limitation = `${entry.key} was not assessed from the available evidence.`;
    if (!Array.isArray(note.limitations)) note.limitations = [];
    if (!(note.limitations as string[]).includes(limitation)) {
      (note.limitations as string[]).push(limitation);
    }
    correctedLayerNotes.set(layer, note);
    corrections.push({ type: "layer-note", key: layer, record: note });
  }
  return corrections.map((entry, index) => ({
    id: `historical-${name}-correction-${index + 1}`,
    name: QUALITY_ANSWER_RECORD_TOOL_NAME,
    chunks: [JSON.stringify(entry)],
  }));
}

function historicalTechnicalVerification(
  name: "a" | "b",
  sourceSha256: string,
): VerificationResult {
  const base = structuredClone(technicalVerification());
  const techIds = ["TECH-001", "TECH-002", "TECH-003", "TECH-004"] as const;
  const issues = techIds.map((id) => ({
    id,
    severity: "major" as const,
    category: "completeness" as const,
    location: "docs/quickstart.md:1-22",
    finding: `Host-authored source-review fixture ${id} is bound to the checked-in Sprout implementation.`,
    evidence: { source_id: `sha256:${sourceSha256}`, locator: "src/sprout.mjs:1-27" },
    required_change: "Reconcile the reviewed quickstart against the bound source.",
  }));
  const factBasis = {
    "input-representations": {
      ids: name === "a" ? ["FACT-2", "FACT-13"] : ["FACT-13"],
      locators: ["src/sprout.mjs:4-5", "src/sprout.mjs:22-27"],
      statement:
        "The parser accepts text or JSON output, and JSON output serializes the message under the message property.",
    },
    "defaults-and-overrides": {
      ids: ["FACT-6", "FACT-9"],
      locators: ["src/sprout.mjs:12-13", "src/sprout.mjs:19-20"],
      statement:
        "The implementation initializes friend/text defaults and updates the selected name or format from command-line options.",
    },
    "mutable-state": {
      ids: name === "a" ? ["FACT-10"] : ["FACT-18", "FACT-19"],
      locators: ["src/sprout.mjs:14-20"],
      statement:
        "The option loop mutates name and format as it processes arguments, so later occurrences can replace earlier values.",
    },
    "destination-and-trust": {
      ids: name === "a" ? ["FACT-11", "FACT-15"] : ["FACT-15", "FACT-16"],
      locators: ["src/sprout.mjs:1", "src/sprout.mjs:5", "src/sprout.mjs:27"],
      statement:
        "The checked-in CLI declares a Node entry point, prints help text that says no network or configuration files are required, and writes the greeting to stdout.",
    },
    "error-status-retry": {
      ids:
        name === "a"
          ? ["FACT-12", "FACT-14"]
          : [
              "FACT-1",
              "FACT-3",
              "FACT-4",
              "FACT-5",
              "FACT-7",
              "FACT-8",
              "FACT-11",
              "FACT-14",
              "FACT-17",
              "FACT-20",
              "FACT-22",
              "FACT-23",
            ],
      locators: ["src/sprout.mjs:8-10", "src/sprout.mjs:14-17", "src/sprout.mjs:22-24"],
      statement:
        "Unknown commands, malformed options, missing option values, and unsupported formats write an error and exit with status 2.",
    },
    "environment-prerequisite": {
      ids: name === "a" ? ["FACT-16"] : ["FACT-21"],
      locators: ["src/sprout.mjs:1"],
      statement:
        "The source uses an env-based Node.js shebang; runtime availability was not independently executed or verified.",
    },
  } satisfies Record<
    (typeof TECHNICAL_FACT_DIMENSIONS)[number],
    { ids: string[]; locators: string[]; statement: string }
  >;
  const dimensions = TECHNICAL_FACT_DIMENSIONS.map((dimension) => {
    const basis = factBasis[dimension];
    const facts = basis.ids.map((id) => ({
      id,
      dimension,
      sourceLocators: basis.locators,
      statement: `${basis.statement} (synthetic host-authored fixture; source SHA-256 ${sourceSha256}).`,
      documentationDisposition: "omitted",
      uncertainty: "Source inspection only; no command was executed.",
      issueIds: [(HISTORICAL_FACT_ISSUES[name] as Record<string, string>)[id]!],
    }));
    return {
      dimension,
      status: "applicable" as const,
      reason: `The synthetic host fixture inspected source evidence for ${dimension}.`,
      sourceLocators: [],
      facts,
    };
  });
  return validateVerificationResult(
    {
      ...base,
      coverage: [
        {
          path: "docs/quickstart.md",
          status: "verified",
          evidence: ["src/sprout.mjs:1-27"],
          reason:
            "Explicit synthetic upstream source review bound to the complete checked-in Sprout implementation.",
        },
      ],
      review: { verdict: "human-review", issues },
      factInventory: {
        ...base.factInventory,
        limitations: [],
        dimensions,
      },
    },
    ["docs/quickstart.md"],
  );
}

async function historicalTechnicalPhaseFixture(
  input: Parameters<AgentHarness["runStep"]>[0],
  technical: VerificationResult,
): Promise<HarnessStepResult> {
  if (requiresSourceObligationLedger(input)) {
    const proposal = sourceObligationProposalFixture("src/sprout.mjs:1");
    return {
      summary: canonicalSourceObligationProposal(proposal),
      sourceObligationProposal: proposal,
    };
  }
  return await technicalPhaseFixture(input, technical);
}

const HISTORICAL_FACT_ISSUES = {
  a: {
    "FACT-2": "TECH-002",
    "FACT-6": "TECH-001",
    "FACT-9": "TECH-003",
    "FACT-10": "TECH-003",
    "FACT-11": "TECH-003",
    "FACT-12": "TECH-003",
    "FACT-13": "TECH-003",
    "FACT-14": "TECH-003",
    "FACT-15": "TECH-003",
    "FACT-16": "TECH-004",
  },
  b: {
    "FACT-1": "TECH-004",
    "FACT-3": "TECH-004",
    "FACT-4": "TECH-004",
    "FACT-5": "TECH-004",
    "FACT-6": "TECH-004",
    "FACT-7": "TECH-004",
    "FACT-8": "TECH-004",
    "FACT-9": "TECH-001",
    "FACT-11": "TECH-004",
    "FACT-13": "TECH-002",
    "FACT-14": "TECH-004",
    "FACT-15": "TECH-004",
    "FACT-16": "TECH-004",
    "FACT-17": "TECH-004",
    "FACT-18": "TECH-004",
    "FACT-19": "TECH-004",
    "FACT-20": "TECH-004",
    "FACT-21": "TECH-003",
    "FACT-22": "TECH-004",
    "FACT-23": "TECH-004",
  },
} as const;

function evaluation(
  profile: Readonly<Record<string, unknown>>,
  revision: string,
  findings: readonly Record<string, unknown>[] = [],
): Record<string, unknown> {
  const applicability = profile.applicability as {
    documentation_set: {
      required_dimensions_by_layer: Record<string, string[]>;
    };
  };
  const dimension = (dimensionId: string) => ({
    dimension_id: dimensionId,
    applicability: "required",
    assessment: "not-assessed",
    confidence: 0,
    evidence: [],
    measures: [],
    rationale: "No direct evidence is available for this deterministic fixture.",
  });
  const constraint = (dimensionId: string, optional = false) => ({
    dimension_id: dimensionId,
    applicability: optional ? "not-applicable" : "required",
    assessment: optional ? "not-applicable" : "not-assessed",
    confidence: 0,
    evidence: [],
    measures: [],
    rationale: optional
      ? "The fixture does not declare global readiness."
      : "No direct evidence is available for this deterministic fixture.",
  });
  return {
    evaluation_id: "quality-artifact-fixture",
    evaluation_version: "v0.1",
    evaluated_at: "2026-09-11T12:00:00Z",
    model_version: "documentation-quality-model-v0.2",
    profile: { id: "docsfab-documentation-quality", version: "v0.1" },
    evaluator: {
      provider_id: "fixture-evaluator",
      provider_type: "agent",
      independent_of_authors: true,
      independence_evidence: "The fixture evaluator is independent of the target author.",
    },
    target: {
      scope_type: "documentation-set",
      documentation_families: ["procedural"],
      documentation_family_evidence: [
        {
          family: "procedural",
          paths: ["docs/"],
          method: "path-convention",
          evidence_locator: "inventory:docs",
          rationale: "The tracked documentation path identifies a procedural family.",
        },
      ],
      repository_revision: revision,
      documentation_revision: revision,
      paths: ["README.md", "docs/"],
      product_reference_model: { id: "fixture-product", version: "v1" },
      approved_evidence_revision: "fixture-evidence-v1",
      product_version: "fixture-v1",
      environment: "deterministic-test",
      delivery_surface_locator: "fixture:docs",
      risk_boundary: "General information only.",
      risk_classes: ["general-information"],
      audiences: ["developer"],
      intended_outcomes: ["complete the documented task"],
      intended_outcome_classes: ["task-completion"],
    },
    layers: Object.fromEntries(
      Object.entries(applicability.documentation_set.required_dimensions_by_layer).map(
        ([layerId, dimensions]) => [
          layerId,
          {
            decision: "insufficient-evidence",
            confidence: 0,
            dimensions: dimensions.map(dimension),
            hard_gate_failures: [],
            limitations: ["Direct outcome evidence is unavailable."],
          },
        ],
      ),
    ),
    constraints: {
      accessibility_and_inclusion: constraint("accessibility-and-inclusion"),
      global_and_localization_readiness: constraint("global-and-localization-readiness", true),
      safety_security_privacy: constraint("safety-security-privacy"),
      legal_policy_support: constraint("legal-policy-support"),
      human_agent_representation_parity: constraint("human-agent-representation-parity"),
    },
    outcomes: { human: [], agent: [] },
    hard_gate_failures: [],
    overall_decision: "insufficient-evidence",
    conditions: [],
    confidence: 0,
    findings,
    limitations: ["Direct outcome evidence is unavailable."],
  };
}

function candidate(
  profile: Readonly<Record<string, unknown>>,
  revision: string,
  findings: readonly Record<string, unknown>[] = [],
): QualityArtifactCandidateV1 & {
  evaluation: Record<string, unknown>;
  qualityScore: Record<string, unknown> | null;
} {
  return {
    evaluation: evaluation(profile, revision, findings),
    qualityScore: null,
    reportMarkdown: [
      "# Documentation quality evaluation report",
      "",
      "## Evidence gaps and limitations",
      "",
      "- Limitation: Direct outcome evidence is unavailable.",
    ].join("\n"),
    selectionSha256: "",
  };
}

function requiredProfileDimensionIds(profile: Readonly<Record<string, unknown>>): Set<string> {
  const applicability = profile.applicability as {
    documentation_set: { required_dimensions_by_layer: Record<string, readonly string[]> };
  };
  return new Set(
    Object.values(applicability.documentation_set.required_dimensions_by_layer).flat(),
  );
}

/** Model reply fixture that omits host-owned and rule-derived evaluation members. */
function omitHostWrittenQualityFields(
  artifact: ReturnType<typeof candidate>,
  profile: Readonly<Record<string, unknown>>,
): ReturnType<typeof candidate> {
  const evaluation = artifact.evaluation;
  for (const field of [
    "evaluation_id",
    "evaluation_version",
    "evaluated_at",
    "model_version",
    "profile",
    "evaluator",
    "confidence",
    "overall_decision",
    "conditions",
    "outcomes",
  ])
    delete evaluation[field];
  const target = evaluation.target as Record<string, unknown>;
  for (const field of [
    "scope_type",
    "paths",
    "repository_revision",
    "documentation_revision",
    "approved_evidence_revision",
    "delivery_surface_locator",
  ])
    delete target[field];
  const requiredDimensions = requiredProfileDimensionIds(profile);
  for (const layer of Object.values(evaluation.layers as Record<string, Record<string, unknown>>)) {
    delete layer.confidence;
    for (const dimension of layer.dimensions as Array<Record<string, unknown>>) {
      if (requiredDimensions.has(String(dimension.dimension_id))) {
        delete dimension.applicability;
      }
      // Conditional dimension applicability remains model-authored.
    }
  }
  const requiredConstraints = new Set(
    ((profile.constraints as Record<string, unknown>).required as string[]).map((id) =>
      id.replaceAll("-", "_"),
    ),
  );
  for (const [key, constraint] of Object.entries(
    evaluation.constraints as Record<string, Record<string, unknown>>,
  )) {
    delete constraint.dimension_id;
    if (requiredConstraints.has(key)) delete constraint.applicability;
  }
  for (const finding of evaluation.findings as Array<Record<string, unknown>>) {
    delete finding.id;
    delete finding.owner;
    delete finding.status;
  }
  return artifact;
}

function technicalVerification(): VerificationResult {
  const issue = {
    id: "TECH-001",
    severity: "major",
    category: "completeness",
    location: "README.md: Consumer Guide",
    finding: "The guide omits a required input behavior.",
    evidence: { source_id: "fixture-source", locator: "src/cli.ts:85-91" },
    required_change: "Document the required input behavior.",
  };
  return {
    review: { verdict: "human-review", issues: [issue] },
    coverage: [
      {
        path: "README.md",
        status: "verified",
        evidence: ["src/cli.ts:85-91"],
        reason: "Compared the focused guide claim with the complete implementation body.",
      },
    ],
    factInventory: {
      completeness: "bounded-not-proven",
      dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) =>
        dimension === "input-representations"
          ? {
              dimension,
              status: "applicable",
              reason: "The focused source defines an input representation requirement.",
              sourceLocators: [],
              facts: [
                {
                  id: "FACT-TRACE-001",
                  dimension,
                  sourceLocators: ["src/cli.ts:85-91"],
                  statement: "The command accepts a required structured input.",
                  documentationDisposition: "omitted",
                  uncertainty:
                    "The complete implementation body is required to verify this behavior.",
                  issueIds: [issue.id],
                },
              ],
            }
          : dimension === "environment-prerequisite"
            ? {
                dimension,
                status: "unverified",
                reason: "The environment prerequisite source is unavailable.",
                sourceLocators: [],
                facts: [],
              }
            : {
                dimension,
                status: "not-applicable",
                reason: `The focused source defines no ${dimension} behavior.`,
                sourceLocators: ["src/cli.ts:85-91"],
                facts: [],
              },
      ),
      limitations: [
        "The focused source inventory does not prove repository-wide completeness.",
        "The environment prerequisite source is unavailable.",
      ],
    },
  };
}

function tracedFinding(locator = "src/cli.ts:85-91"): Record<string, unknown> {
  return {
    id: "DQ-TRACE-001",
    severity: "major",
    dimension_id: "scoped-sufficiency",
    description: "FACT-TRACE-001 consolidates the source gap linked to TECH-001.",
    evidence: [
      {
        evidence_class: "grounded-judgment",
        strength: "direct",
        provider_id: "fixture-evaluator",
        locator,
        description: "The complete implementation body is required to verify this behavior.",
      },
    ],
    owner: "documentation owner",
    acceptance_condition: "Resolve FACT-TRACE-001 and TECH-001 against the retained source range.",
    status: "open",
  };
}

function addTechnicalTrace(
  artifactCandidate: ReturnType<typeof candidate>,
  locator = "src/cli.ts:85-91",
): void {
  artifactCandidate.evaluation.findings = [tracedFinding(locator)];
  artifactCandidate.evaluation.limitations = [
    "Direct outcome evidence is unavailable.",
    "The focused source inventory does not prove repository-wide completeness.",
    "The environment prerequisite source is unavailable.",
    "environment-prerequisite: The environment prerequisite source is unavailable.",
  ];
}

async function technicalPhaseFixture(
  input: Parameters<AgentHarness["runStep"]>[0],
  technical: VerificationResult,
): Promise<HarnessStepResult> {
  if (input.step.skill !== "verify-technical-accuracy") {
    throw new Error("technical fixture called for a non-technical step");
  }
  if (requiresSourceObligationLedger(input)) {
    const result = await verificationFixture(input);
    if ("summary" in result && typeof result.summary === "string") {
      return result as HarnessStepResult;
    }
    throw new Error("Source-obligation fixture omitted its technical result.");
  }
  const summary = canonicalizeJsonEvidence(technical as unknown as JsonEvidenceValue).trimEnd();
  if (!requiresTechnicalCorrection(input)) return { summary, verificationResult: technical };
  const ledger = input.sourceObligationLedger!;
  const correction =
    ledger.schemaVersion === 2
      ? await bindHostOwnedTechnicalCorrectionProposalV3(
          {
            kind: TECHNICAL_CORRECTION_PROPOSAL_KIND,
            schemaVersion: 3,
            verdict: technical.review.verdict,
            coverage: technical.coverage,
            factInventory: technical.factInventory,
            issueJudgments: technical.review.issues.map((issueValue) => {
              const issue = issueValue as {
                id: string;
                severity: "critical" | "major" | "minor";
                category:
                  | "technical_accuracy"
                  | "source_grounding"
                  | "completeness"
                  | "task_success"
                  | "example_validity"
                  | "information_architecture"
                  | "style_compliance"
                  | "security_compliance";
                location: string;
              };
              return {
                id: issue.id,
                severity: issue.severity,
                category: issue.category,
                location: issue.location,
                factIds: technical.factInventory.dimensions
                  .flatMap((dimension) => dimension.facts)
                  .filter(
                    (fact) =>
                      fact.documentationDisposition !== "documented" &&
                      fact.issueIds.includes(issue.id),
                  )
                  .map((fact) => fact.id),
              };
            }),
            obligationAccounting: [],
          },
          ledger,
          input.originalSourceAuthorityAdmission!,
          input.runId!,
          technical.coverage.map(({ path }) => path),
        )
      : bindTechnicalCorrectionResponse(
          { verificationResult: technical, obligationAccounting: [] },
          ledger,
          (value) => value as VerificationResult,
        );
  return {
    summary:
      ledger.schemaVersion === 2
        ? canonicalizeJsonEvidence(
            correction.verificationResult as unknown as JsonEvidenceValue,
          ).trimEnd()
        : summary,
    verificationResult: correction.verificationResult,
    technicalCorrectionEvidence: correction.evidence,
  };
}

function completeTechnicalTraceEvaluation(): Record<string, unknown> {
  return {
    findings: [tracedFinding()],
    limitations: [
      "The focused source inventory does not prove repository-wide completeness.",
      "The environment prerequisite source is unavailable.",
      "environment-prerequisite: The environment prerequisite source is unavailable.",
    ],
  };
}

async function technicalTraceRunnerFixture() {
  const value = await fixture();
  const technical = technicalVerification();
  const artifactCandidate = candidate(value.selection.profile, value.revision);
  artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
  const harness: AgentHarness = {
    runStep: async (input) => {
      if (input.step.skill === "verify-technical-accuracy") {
        return {
          ...(await technicalPhaseFixture(input, technical)),
          skill: { id: input.step.skill, contentSha256: "a".repeat(64) },
        };
      }
      if (input.step.skill === "evaluate-document-quality") {
        return {
          summary: artifactCandidate.reportMarkdown,
          qualityArtifactCandidate: artifactCandidate,
          skill: { id: input.step.skill, contentSha256: "f".repeat(64) },
        };
      }
      return { summary: `${input.step.skill} completed` };
    },
  };
  return { value, harness };
}

function retainedEvaluationFindings(): Record<string, unknown>[] {
  const locations = [
    "README.md:28-75; package.json:2-3; src/index.ts:1-7",
    "README.md:50-58; .gitlab-ci.yml:18-21",
    "src/csrf/csrf.ts:7-91; README.md:1-75",
    "README.md:28-288; CHANGELOG.md:1-3",
    "README.md:39-75; src/csrf/csrf.ts:7-91",
    "Consumer Guide",
  ];
  const findings = locations.map((locator, index) => ({
    id: `DQ-${String(index + 1).padStart(3, "0")}`,
    severity: index < 3 ? "major" : index === 5 ? "minor" : "moderate",
    dimension_id: index === 5 ? "editorial-style" : "scoped-sufficiency",
    description: `Representative retained evaluation finding ${index + 1}.`,
    evidence: [
      {
        evidence_class: "grounded-judgment",
        strength: "direct",
        provider_id: "fixture-evaluator",
        locator,
        description: `Bound source evidence ${index + 1}.`,
      },
    ],
    owner: "documentation owner",
    acceptance_condition: `Resolve retained evaluation finding ${index + 1}.`,
    status: "open",
  }));
  findings.push(
    {
      ...findings[0]!,
      id: "DQ-007",
      description: "A zero line must not become a navigable finding.",
      evidence: [
        {
          evidence_class: "grounded-judgment",
          strength: "direct",
          provider_id: "fixture-evaluator",
          locator: "README.md:0",
          description: "The schema-valid locator has no positive source line.",
        },
      ],
    },
    {
      ...findings[0]!,
      id: "DQ-008",
      description: "A schema-valid disclosure points to https://example.invalid/private.",
    },
    {
      ...findings[0]!,
      id: "DQ-009",
      description: "An oversized line must not become a navigable finding.",
      evidence: [
        {
          evidence_class: "grounded-judgment",
          strength: "direct",
          provider_id: "fixture-evaluator",
          locator: "README.md:99999999999999999999",
          description: "The locator line is outside the safe integer range.",
        },
      ],
    },
  );
  return findings;
}

function qualityScore() {
  return {
    rubric: "task-guide-v0.1",
    scores: {
      technical_accuracy: 0,
      completeness: 0,
      task_success: 0,
      source_grounding: 0,
      clarity: 0,
      style_compliance: 0,
    },
    total: 0,
    hard_gates: {
      critical_factual_errors: 0,
      unsupported_critical_claims: 0,
      broken_required_examples: 0,
      missing_mandatory_content: 0,
      security_compliance_violations: 0,
      invalid_required_artifacts: 0,
    },
    decision: "human-review",
    confidence: 0,
    rationale: "The deterministic fixture has no direct outcome evidence.",
  };
}

const QUALITY_VALIDATOR_SUITE_TIMEOUT_MS = 60_000;

describe("quality artifact staging and validator host", {
  timeout: testTimeoutMs(QUALITY_VALIDATOR_SUITE_TIMEOUT_MS),
  hookTimeout: QUALITY_VALIDATOR_SUITE_TIMEOUT_MS,
}, () => {
  it("refuses quality validation after its saved run is deleted before staging receipts", {
    timeout: testTimeoutMs(15_000),
  }, async () => {
    const value = await fixture();
    const stateDirectory = join(value.root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    const runId = "deleted-quality-run";
    await writeRunTombstone(stateDirectory, runId);
    const host = new QualityValidatorHost({
      store: value.store,
      selection: value.selection,
      temporaryRoot: join(value.root, "validator-tmp"),
      stateDirectory,
    });
    await expect(
      host.validate(
        validationInput(value, runId, candidate(value.selection.profile, value.revision)),
      ),
    ).rejects.toMatchObject({ code: "tombstoned" });
    expect(
      await readdir(join(value.root, "artifacts", "objects", "sha256")).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        },
      ),
    ).toEqual([]);
  });

  it("does not stage quality objects when deletion crosses a waiting validator", {
    timeout: testTimeoutMs(15_000),
  }, async () => {
    const value = await fixture();
    const record = authoringReviewFindingsRecord();
    await new FileRunStore(value.stateDirectory).save(record);
    const preview = await previewRunDeletion(value.stateDirectory, record.id);
    let atUnlink!: () => void;
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      atUnlink = resolve;
    });
    const released = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const deleting = applyRunDeletion(value.stateDirectory, record.id, preview.confirmation, {
      afterRemove: async () => {
        atUnlink();
        await released;
      },
    });
    await paused;
    const validationOutcome = value.host
      .validate(
        validationInput(value, record.id, candidate(value.selection.profile, value.revision)),
      )
      .then(
        (result) => ({ status: "fulfilled" as const, result }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
    resume();
    expect((await deleting).complete).toBe(true);
    expect(await validationOutcome).toMatchObject({
      status: "rejected",
      error: { code: "tombstoned" },
    });
    expect(
      await readdir(join(value.root, "artifacts", "objects", "sha256")).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        },
      ),
    ).toEqual([]);
  });

  it("projects a digest-bound candidate result only from a read-only R report", {
    timeout: testTimeoutMs(15_000),
  }, async () => {
    const value = await fixture();
    const artifactCandidate = candidate(value.selection.profile, value.revision);
    artifactCandidate.evaluation.limitations = [];
    artifactCandidate.reportMarkdown =
      "# Documentation quality evaluation report\n\n## Evidence gaps and limitations\n";
    artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
    const validated = await value.host.validate(
      validationInput(value, "candidate-review-projection", artifactCandidate),
    );
    const record = validatedRunRecord(value, validated);
    const request = {
      packet: {
        candidateReview: {
          bindingSha256: "a".repeat(64),
          reviewCommitObjectId: value.revision,
          patchSha256: "b".repeat(64),
          targets: [{ path: "docs/guide.md" }],
        },
      },
    } as unknown as HostRuntimeRequestV1;
    const projected = projectCandidateReviewResult(request, record) as {
      reviewedHeadSha: string;
      targetSha256: string;
      qualityReport: {
        schemaVersion: number;
        patchSha256: string | null;
        retainedGapEvidence: readonly { reason: string }[];
        unclassifiedLimitations: readonly string[];
      };
    };
    expect(projected.reviewedHeadSha).toBe(value.revision);
    expect(projected.targetSha256).toBe("a".repeat(64));
    expect(projected.qualityReport.patchSha256).toBeNull();
    expect(projected.qualityReport.schemaVersion).toBe(2);
    expect(projected.qualityReport.retainedGapEvidence.map((entry) => entry.reason)).toEqual([
      "experimental-profile-ceiling",
      "audience-prerequisites-missing",
    ]);
    expect(projected.qualityReport.unclassifiedLimitations).toEqual([]);
    expect(JSON.stringify(projected)).not.toContain("authorSession");
    // The worker's workspace and the run's checkout both project repository-relative.
    const named = projectCandidateReviewResult(
      { ...request, workspacePath: value.workspacePath } as HostRuntimeRequestV1,
      {
        ...record,
        steps: record.steps.map((step, index) =>
          index === 0
            ? {
                ...step,
                title: `Review ${value.workspacePath}/docs/guide.md and ${value.sourcePath}/README.md`,
              }
            : step,
        ),
      },
    ) as { checks: readonly { name: string }[] };
    expect(named.checks[0]?.name).toBe("Review docs/guide.md and README.md");
    expect(JSON.stringify(named)).not.toContain(value.root);
    expect(() =>
      projectCandidateReviewResult(request, {
        ...record,
        changes: {
          files: [{ path: "docs/guide.md", status: "modified" }],
          patch: {
            sha256: "b".repeat(64),
            byteLength: 1,
            lineCount: 1,
            artifactPath: join(value.root, "reviewer.patch"),
            format: "git-diff",
          },
        },
      }),
    ).toThrow(/exact read-only quality report/u);
  });

  it("inspects every technical trace component with bounded content-free diagnostics", () => {
    const verification = technicalVerification();
    expect(inspectTechnicalFactTrace(completeTechnicalTraceEvaluation(), verification)).toEqual({
      status: "passed",
      violations: [],
      truncated: false,
    });

    const cases: Array<{
      code: string;
      evaluation: unknown;
    }> = [
      {
        code: "malformed-candidate",
        evaluation: { findings: "not-an-array", limitations: [] },
      },
      {
        code: "missing-fact-id",
        evaluation: JSON.parse(
          JSON.stringify(completeTechnicalTraceEvaluation()).replaceAll(
            "FACT-TRACE-001",
            "ANOTHER-FACT",
          ),
        ),
      },
      {
        code: "missing-issue-id",
        evaluation: JSON.parse(
          JSON.stringify(completeTechnicalTraceEvaluation()).replaceAll(
            "TECH-001",
            "ANOTHER-ISSUE",
          ),
        ),
      },
      {
        code: "missing-uncertainty",
        evaluation: JSON.parse(
          JSON.stringify(completeTechnicalTraceEvaluation()).replaceAll(
            "The complete implementation body is required to verify this behavior.",
            "The evaluator omitted the admitted uncertainty.",
          ),
        ),
      },
      {
        code: "missing-source-locator",
        evaluation: JSON.parse(
          JSON.stringify(completeTechnicalTraceEvaluation()).replaceAll(
            "src/cli.ts:85-91",
            "src/cli.ts:85-90",
          ),
        ),
      },
      {
        code: "missing-inventory-limitation",
        evaluation: {
          ...completeTechnicalTraceEvaluation(),
          limitations: [
            "The environment prerequisite source is unavailable.",
            "environment-prerequisite: The environment prerequisite source is unavailable.",
          ],
        },
      },
      {
        code: "missing-unverified-dimension-limitation",
        evaluation: {
          ...completeTechnicalTraceEvaluation(),
          limitations: [
            "The focused source inventory does not prove repository-wide completeness.",
            "The environment prerequisite source is unavailable.",
          ],
        },
      },
    ];

    for (const testCase of cases) {
      const result = inspectTechnicalFactTrace(testCase.evaluation, verification);
      expect(result).toMatchObject({
        status: "invalid",
        violations: [
          expect.objectContaining({
            code: testCase.code,
          }),
        ],
        truncated: false,
      });
      expect(JSON.stringify(result)).not.toContain("src/cli.ts");
      expect(JSON.stringify(result)).not.toContain(
        "The complete implementation body is required to verify this behavior.",
      );
      expect(JSON.stringify(result)).not.toContain("TECH-001");
    }
  });

  it("requires fact, issues, uncertainty, and exact locators within one finding", () => {
    const verification = technicalVerification();
    const split = completeTechnicalTraceEvaluation();
    split.findings = [
      {
        description: "FACT-TRACE-001 is linked to TECH-001.",
        evidence: [{ locator: "src/cli.ts:85-91", description: "Source location only." }],
      },
      {
        description: "The complete implementation body is required to verify this behavior.",
        evidence: [{ locator: "src/cli.ts:85-91", description: "Uncertainty only." }],
      },
    ];
    expect(inspectTechnicalFactTrace(split, verification)).toMatchObject({
      status: "invalid",
      violations: [{ code: "missing-uncertainty", factId: "FACT-TRACE-001" }],
    });

    for (const locator of ["src/cli.ts:86-91", "src/cli.ts:84-92", "src/cli.ts:85-90"]) {
      const evaluation = completeTechnicalTraceEvaluation();
      evaluation.findings = [tracedFinding(locator)];
      expect(inspectTechnicalFactTrace(evaluation, verification)).toMatchObject({
        status: "invalid",
        violations: [{ code: "missing-source-locator", factId: "FACT-TRACE-001" }],
      });
    }
  });

  it("bounds trace feedback and exposes only admitted fact identities", () => {
    const verification = technicalVerification();
    const dimension = verification.factInventory.dimensions.find(
      (candidateDimension) => candidateDimension.dimension === "input-representations",
    )!;
    const template = dimension.facts[0]!;
    dimension.facts = Array.from(
      { length: TECHNICAL_FACT_TRACE_MAX_VIOLATIONS + 5 },
      (_, index) => ({
        ...template,
        id: `FACT-BOUNDED-${String(index + 1).padStart(3, "0")}`,
        statement: "CANDIDATE-CONTENT-MUST-NOT-BE-ECHOED",
        uncertainty: "UNCERTAINTY-MUST-NOT-BE-ECHOED",
        sourceLocators: ["private/source-must-not-be-echoed.ts:1-2"],
      }),
    );
    const result = inspectTechnicalFactTrace(
      {
        findings: [],
        limitations: completeTechnicalTraceEvaluation().limitations,
      },
      verification,
    );
    expect(result).toMatchObject({
      status: "invalid",
      truncated: true,
    });
    expect(result.violations).toHaveLength(TECHNICAL_FACT_TRACE_MAX_VIOLATIONS);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("CANDIDATE-CONTENT");
    expect(serialized).not.toContain("UNCERTAINTY-MUST");
    expect(serialized).not.toContain("private/source");
    expect(serialized).not.toContain("TECH-001");
  });

  it("preserves historical and final assertion behavior", () => {
    expect(inspectTechnicalFactTrace(null, undefined)).toEqual({
      status: "passed",
      violations: [],
      truncated: false,
    });
    expect(() => assertTechnicalFactTrace(null, undefined)).not.toThrow();

    const malformedObjectError = (() => {
      try {
        assertTechnicalFactTrace(null, technicalVerification());
      } catch (error) {
        return error;
      }
    })();
    expect(malformedObjectError).toBeInstanceOf(QualityArtifactStagingError);
    expect((malformedObjectError as QualityArtifactStagingError).code).toBe("candidate-invalid");

    const traceError = (() => {
      try {
        assertTechnicalFactTrace({}, technicalVerification());
      } catch (error) {
        return error;
      }
    })();
    expect(traceError).toBeInstanceOf(QualityArtifactStagingError);
    expect((traceError as QualityArtifactStagingError).code).toBe("technical-trace-incomplete");
  });

  it("fails closed at the runner seal when a schema-valid final artifact drops technical trace", {
    timeout: testTimeoutMs(15_000),
  }, async () => {
    const { value, harness } = await technicalTraceRunnerFixture();
    const repositoryEvidence = await GitPatchEvidenceCollector.create(
      value.workspacePath,
      join(value.root, "patches"),
    );
    const runner = new WorkflowRunner({
      repositoryEvidence,
      harness: {
        runStep: async (input) => {
          const result = await harness.runStep(input);
          const profile = validModelConfig.profile;
          const governed = governProviderTurn({
            context: { messages: [{ role: "user", content: "Perform the fixture review step." }] },
            policy: {
              budget: {
                configuredContextWindow: profile.configuredLimits.contextWindow,
                effectiveContextWindow: profile.contextWindow,
                configuredMaxInputTokens: profile.configuredLimits.maxInputTokens,
                effectiveMaxInputTokens: profile.maxInputTokens,
                configuredMaxOutputTokens: profile.configuredLimits.maxOutputTokens,
                effectiveMaxOutputTokens: profile.maxOutputTokens,
                reservedTokens: validModelConfig.requestPolicy.reservedContextTokens,
                requiredMinimumOutputTokens: validModelConfig.requestPolicy.minimumOutputTokens,
              },
              aggregatePolicy: { kind: "absent" },
              minRecentToolTurns: limit("governance.minRecentToolTurns").value,
            },
            state: { providerTurns: 0, toolCalls: 0, toolResults: 0, compactions: 0 },
            evidenceIdentity: input.evidenceIdentity!,
            pinnedMessageCount: 0,
          });
          return {
            ...result,
            model: createModelEvidence(validModelConfig),
            skill: result.skill ?? { id: input.step.skill, contentSha256: "f".repeat(64) },
            usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, total: 3, turns: 1 },
            tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
            turns: [governed.evidence],
          };
        },
      },
      hostOperations: {
        runStep: async (input) => ({ summary: `${input.step.skill} completed` }),
      },
      store: new MemoryStore(),
      ...qualityRunnerOptions(value),
      contextPreflight: new LocalContextPreflightService({
        cacheRoot: join(value.root, "context-cache"),
        workspace: value.workspace,
      }),
      id: () => "quality-technical-trace-rejection",
    });

    let record: RunRecord;
    try {
      record = await runner.run(reviewRunRequest(value));
    } finally {
      await repositoryEvidence.dispose();
    }

    // A model-content refusal with no retry budget configured is already
    // the step's final attempt, so the host declines the artifact instead
    // of failing the review; the dropped technical trace is still refused
    // exactly as before (never silently admitted), and the rejection code
    // is still recorded.
    expect(record.status, safeRunFailureSummary(record)).toBe("succeeded");
    expect(record.qualityArtifactValidation).toBeUndefined();
    // The trace check's first violation, from the content-free inspection.
    expect(record.steps.at(-1)?.qualityValidationRejection).toEqual({
      validator: "technical-trace",
      code: "technical-trace-missing-inventory-limitation",
      location: "$.limitations",
      issueCount: 4,
    });
    const serialized = JSON.parse(JSON.stringify(record)) as RunRecord;
    const cold = decodeSuccessfulReviewRunRecord(serialized);
    expect(cold.steps.at(-1)?.qualityValidationRejection).toEqual(
      record.steps.at(-1)?.qualityValidationRejection,
    );
    expect(record.qualityProfileSelection).toBeDefined();
    expect(cold.qualityProfileSelection).toEqual(record.qualityProfileSelection);
    expect(cold.qualityArtifactValidation).toBeUndefined();

    const invalidRejections = [
      { ...record.steps.at(-1)!.qualityValidationRejection, validator: "unknown-validator" },
      { ...record.steps.at(-1)!.qualityValidationRejection, code: "unknown-rejection" },
      { ...record.steps.at(-1)!.qualityValidationRejection, unexpected: true },
    ];
    for (const rejection of invalidRejections) {
      const altered = structuredClone(serialized);
      Object.assign(altered.steps.at(-1)!, { qualityValidationRejection: rejection });
      expect(() => decodeSuccessfulReviewRunRecord(altered)).toThrow(
        expect.objectContaining({
          name: PublicationRunRecordDecodeError.name,
          code: "invalid-shape",
        }),
      );
    }
    const wrongStep = structuredClone(serialized);
    wrongStep.steps.find(
      (step) => step.id === "verify-technical-accuracy",
    )!.qualityValidationRejection = wrongStep.steps.at(-1)!.qualityValidationRejection;
    delete wrongStep.steps.at(-1)!.qualityValidationRejection;
    expect(() => decodeSuccessfulReviewRunRecord(wrongStep)).toThrow(
      expect.objectContaining({
        name: PublicationRunRecordDecodeError.name,
        code: "invalid-shape",
      }),
    );

    const projection = await projectReviewFindingsFromRetainedRun(cold, value.store);
    expect(projection.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "FACT-TRACE-001" })]),
    );
    // `loadVerifiedReviewEvaluationArtifact` (review/findings.ts) already
    // degrades the declined step's absent binding into one limitation line,
    // same as it already does for the unbound hosted path -- unrelated to
    // this MR, and unaffected by it.
    expect(projection.limitations).toContain(
      "review-findings-artifact-unavailable:evaluate-document-quality:no-binding",
    );
  });

  it("isolates corrupted saved snapshots while preserving the live technical summary", {
    timeout: testTimeoutMs(15_000),
  }, async () => {
    const { value, harness } = await technicalTraceRunnerFixture();
    const corruptedSnapshots: RunRecord[] = [];
    const corruptingStore: RunStore = {
      save: async (candidateRecord) => {
        // Mutate the exact object supplied by the runner's serializing store
        // boundary. Keeping this reference makes the test fail if that
        // production boundary stops cloning before calling the store.
        const technicalStep = candidateRecord.steps.find(
          (candidateStep) => candidateStep.id === "verify-technical-accuracy",
        );
        if (technicalStep?.status === "succeeded") {
          technicalStep.summary = "{}";
          corruptedSnapshots.push(candidateRecord);
        }
      },
    };
    const evaluatorInputs: HarnessStepInput[] = [];
    const recordingHarness: AgentHarness = {
      runStep: async (input) => {
        if (input.step.skill === "evaluate-document-quality") evaluatorInputs.push(input);
        return harness.runStep(input);
      },
    };
    const corrupted = await new WorkflowRunner({
      harness: recordingHarness,
      hostOperations: {
        runStep: async (input) => ({ summary: `${input.step.skill} completed` }),
      },
      store: corruptingStore,
      ...qualityRunnerOptions(value),
      id: () => "quality-technical-transport-rejection",
    }).run(reviewRunRequest(value));
    // The store may retain a corrupted copy, but it cannot mutate the live run
    // record that supplies the evaluator's admitted technical verification.
    expect(corrupted, safeRunFailureSummary(corrupted)).toMatchObject({ status: "succeeded" });
    expect(evaluatorInputs).toHaveLength(1);
    expect(
      evaluatorInputs[0]!.technicalVerification?.factInventory.dimensions
        .flatMap((dimension) => dimension.facts)
        .map((fact) => fact.id),
    ).toContain("FACT-TRACE-001");
    const liveSummary = corrupted.steps.find(
      (step) => step.id === "verify-technical-accuracy",
    )?.summary;
    expect(decodeAdmittedVerificationSummary(liveSummary)).toBeDefined();

    // The existing admission decoder refuses the deliberately corrupted
    // persisted technical verification summary.
    expect(corruptedSnapshots.length).toBeGreaterThan(0);
    const persistedSnapshot = corruptedSnapshots.at(-1)!;
    expect(persistedSnapshot).not.toBe(corrupted);
    expect(persistedSnapshot.steps).not.toBe(corrupted.steps);
    const persistedSummary = persistedSnapshot.steps.find(
      (step) => step.id === "verify-technical-accuracy",
    )?.summary;
    expect(persistedSummary).toBe("{}");
    expect(decodeAdmittedVerificationSummary(persistedSummary)).toBeUndefined();
    expect(corrupted.qualityArtifactValidation).toBeUndefined();
    // A separate model-owned trace omission declines the candidate; this test
    // deliberately does not depend on which trace component is omitted.
    expect(
      corrupted.steps.find((step) => step.skill === "evaluate-document-quality")
        ?.qualityValidationRejection,
    ).toMatchObject({ validator: "technical-trace" });
  });

  it("refuses a corrupted live technical summary before artifact validation", {
    timeout: testTimeoutMs(15_000),
  }, async () => {
    const { value, harness } = await technicalTraceRunnerFixture();
    const validateArtifact = vi.spyOn(value.host, "validate");
    const executeStep = runnerStepLoop.executeGovernedWorkflowStep;
    let corruptedProducerId: string | undefined;
    const stepSpy = vi
      .spyOn(runnerStepLoop, "executeGovernedWorkflowStep")
      .mockImplementation(async (input) => {
        if (input.step.id === "evaluate-document-quality") {
          const technicalProducers = (input.step.consumes ?? [])
            .map((id) => input.record.steps.find((candidate) => candidate.id === id))
            .filter((candidate) => candidate?.skill === "verify-technical-accuracy");
          expect(technicalProducers).toHaveLength(1);
          const technicalProducer = technicalProducers[0]!;
          expect(technicalProducer.status).toBe("succeeded");
          expect(technicalProducer.summary).toBeDefined();
          expect(decodeAdmittedVerificationSummary(technicalProducer.summary)).toBeDefined();
          technicalProducer.summary = "{}";
          corruptedProducerId = technicalProducer.id;
        }
        return executeStep(input);
      });
    let corrupted: RunRecord;
    try {
      corrupted = await new WorkflowRunner({
        harness,
        hostOperations: {
          runStep: async (input) => ({ summary: `${input.step.skill} completed` }),
        },
        store: new MemoryStore(),
        ...qualityRunnerOptions(value),
        id: () => "quality-technical-transport-rejection",
      }).run(reviewRunRequest(value));
    } finally {
      stepSpy.mockRestore();
    }
    expect(corruptedProducerId).toBe("verify-technical-accuracy");
    expect(corrupted, safeRunFailureSummary(corrupted)).toMatchObject({
      status: "failed",
      error: "The final evaluator requires the admitted current technical verification result.",
    });
    expect(validateArtifact).not.toHaveBeenCalled();
    expect(corrupted.qualityArtifactValidation).toBeUndefined();
    expect(
      corrupted.steps.find((step) => step.skill === "evaluate-document-quality")
        ?.qualityValidationRejection,
    ).toEqual({
      validator: "candidate-admission",
      code: "quality-technical-verification-unadmitted",
      location: "$",
      issueCount: 1,
    });
  });

  it("admits a raw chunked tool-call submission and its report, which the locked validators pass (#1707)", async () => {
    const value = await fixture();
    const technical = technicalVerification();
    const artifactCandidate = candidate(value.selection.profile, value.revision);
    artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
    addTechnicalTrace(artifactCandidate);
    const judgedDimensions = new Map<string, Record<string, unknown>>();
    for (const layer of Object.values(artifactCandidate.evaluation.layers as Record<string, any>)) {
      for (const dimension of layer.dimensions as Array<Record<string, unknown>>) {
        judgedDimensions.set(dimension.dimension_id as string, structuredClone(dimension));
      }
      layer.dimensions.reverse();
    }
    omitHostWrittenQualityFields(artifactCandidate, value.selection.profile);
    expect(HOST_WRITTEN_EVALUATION_FIELDS).not.toContain("layers.*.dimensions[].dimension_id");
    const submission = JSON.stringify({
      evaluation: artifactCandidate.evaluation,
      qualityScore: artifactCandidate.qualityScore,
    });
    // The report template's sections, with quotes, braces, and a fenced
    // block before the limitations the binding validator reads.
    const report = [
      "# Documentation quality evaluation report",
      "",
      'A "quoted" {braced} note, and a fenced sample:',
      "",
      "```text",
      '{"note": "fenced", "path": "C:\\\\docs"}',
      "```",
      "",
      "## Evidence gaps and limitations",
      "",
      "- Limitation: Direct outcome evidence is unavailable.",
    ].join("\n");
    const workflow = getWorkflow("review-documentation");
    const input = {
      runId: "quality-tool-call-acceptance",
      repositoryPath: value.workspacePath,
      workflow,
      step: workflow.steps.find((step) => step.skill === "evaluate-document-quality")!,
      evidenceIdentity: {
        repositoryRevision: value.revision,
        technicalVerificationSha256: canonicalDigest(technical),
      },
      technicalVerification: technical,
      qualityProfileSelection: value.selection.receipt,
      qualityEvaluationTarget: value.selection.evaluationTarget,
      answerSubmission: { path: "tool-call", reason: "recorded-route" },
    } as Parameters<AgentHarness["runStep"]>[0];
    recordingProvider([
      rawToolCallTurn([submissionCall("submit-1", submission, 11)]),
      textTurn(report),
    ]);
    let result: Awaited<ReturnType<AgentHarness["runStep"]>>;
    try {
      result = await toolPathHarness().runStep(input);
    } finally {
      vi.unstubAllGlobals();
    }

    const admitted = result.qualityArtifactCandidate!;
    // The structured answer has the same judged members as the text route and
    // carries an internal route tag for host derivation.
    expect(admitted.answerPath).toBe("tool-call");
    expect(admitted.evaluation).toEqual(artifactCandidate.evaluation);
    expect(admitted.reportMarkdown).toBe(report);
    const validated = await value.host.validate({
      ...validationInput(value, "quality-tool-call-acceptance", admitted),
      technicalVerification: technical,
    });
    expect(validated.binding).toMatchObject({ status: "passed", failureCode: null });
    const stagedEvaluation = await loadStagedQualityArtifact(
      value.store,
      validated.binding.artifacts.evaluation!.recordSha256,
    );
    const staged = stagedEvaluation.payload as Record<string, any>;
    expect(staged).toMatchObject({
      evaluation_id: "quality-tool-call-acceptance:evaluate-document-quality:1",
      evaluation_version: "1.0",
      evaluated_at: "2026-10-09T12:00:00.000Z",
      model_version: value.selection.receipt.profileModel,
      profile: {
        id: value.selection.receipt.profileId,
        version: value.selection.receipt.profileVersion,
      },
      evaluator: {
        provider_id: "fixture-provider",
        provider_type: "agent",
        independent_of_authors: false,
      },
      outcomes: { human: [], agent: [] },
    });
    for (const layer of Object.values(staged.layers as Record<string, any>)) {
      for (const dimension of layer.dimensions as Array<Record<string, unknown>>) {
        expect(dimension).toEqual(judgedDimensions.get(dimension.dimension_id as string));
      }
    }
  });

  /**
   * Submit `submission` through a real tool-path harness, then the report;
   * the members come back as the harness admitted them.
   */
  async function admitThroughToolCall(
    value: QualityFixture,
    technical: ReturnType<typeof technicalVerification>,
    runId: string,
    submission: string,
  ) {
    const workflow = getWorkflow("review-documentation");
    const input = {
      runId,
      repositoryPath: value.workspacePath,
      workflow,
      step: workflow.steps.find((step) => step.skill === "evaluate-document-quality")!,
      evidenceIdentity: {
        repositoryRevision: value.revision,
        technicalVerificationSha256: canonicalDigest(technical),
      },
      technicalVerification: technical,
      qualityProfileSelection: value.selection.receipt,
      qualityEvaluationTarget: value.selection.evaluationTarget,
      answerSubmission: { path: "tool-call", reason: "recorded-route" },
    } as Parameters<AgentHarness["runStep"]>[0];
    const report = [
      "# Documentation quality evaluation report",
      "",
      "## Evidence gaps and limitations",
      "",
      "- Limitation: Direct outcome evidence is unavailable.",
    ].join("\n");
    recordingProvider([
      rawToolCallTurn([submissionCall("submit-1", submission, 9)]),
      textTurn(report),
    ]);
    try {
      return await toolPathHarness().runStep(input);
    } finally {
      vi.unstubAllGlobals();
    }
  }

  async function admitThroughText(
    value: QualityFixture,
    technical: ReturnType<typeof technicalVerification>,
    runId: string,
    reply: string,
  ) {
    const workflow = getWorkflow("review-documentation");
    const input = {
      runId,
      repositoryPath: value.workspacePath,
      workflow,
      step: workflow.steps.find((step) => step.skill === "evaluate-document-quality")!,
      evidenceIdentity: {
        repositoryRevision: value.revision,
        technicalVerificationSha256: canonicalDigest(technical),
      },
      technicalVerification: technical,
      qualityProfileSelection: value.selection.receipt,
      qualityEvaluationTarget: value.selection.evaluationTarget,
      answerSubmission: { path: "text-final", reason: "operator-override" },
    } as Parameters<AgentHarness["runStep"]>[0];
    recordingProvider([textTurn(reply)]);
    try {
      return await toolPathHarness({ capability: null }).runStep(input);
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("derives a text-path artifact when every host-written member is omitted", async () => {
    const value = await fixture();
    const technical = technicalVerification();
    const artifactCandidate = candidate(value.selection.profile, value.revision);
    artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
    addTechnicalTrace(artifactCandidate);
    const judged = new Map<string, Record<string, unknown>>();
    for (const layer of Object.values(artifactCandidate.evaluation.layers as Record<string, any>)) {
      for (const dimension of layer.dimensions as Array<Record<string, unknown>>) {
        judged.set(dimension.dimension_id as string, structuredClone(dimension));
      }
    }
    omitHostWrittenQualityFields(artifactCandidate, value.selection.profile);
    const submission = JSON.stringify({
      evaluation: artifactCandidate.evaluation,
      qualityScore: artifactCandidate.qualityScore,
    });
    const admitted = await admitThroughText(
      value,
      technical,
      "quality-text-omitted-host-fields",
      `${submission}\n\n${artifactCandidate.reportMarkdown}`,
    );
    const validation = await value.host.validate({
      ...validationInput(
        value,
        "quality-text-omitted-host-fields",
        admitted.qualityArtifactCandidate!,
      ),
      technicalVerification: technical,
    });
    expect(validation.binding).toMatchObject({ status: "passed", failureCode: null });
    expect(validation.reportMarkdown).toMatch(
      /The host supplied or replaced \d+ host-owned metadata fields and derived \d+ rule-derived fields; counts only\./u,
    );
    const staged = await loadStagedQualityArtifact(
      value.store,
      validation.binding.artifacts.evaluation!.recordSha256,
    );
    const evaluation = staged.payload as Record<string, any>;
    expect(evaluation.evaluation_id).toBe(
      "quality-text-omitted-host-fields:evaluate-document-quality:1",
    );
    expect(evaluation.evaluator).toMatchObject({
      provider_id: "fixture-provider",
      independent_of_authors: false,
    });
    expect(evaluation.outcomes).toEqual({ human: [], agent: [] });
    for (const layer of Object.values(evaluation.layers as Record<string, any>)) {
      for (const dimension of layer.dimensions as Array<Record<string, unknown>>) {
        expect(dimension).toMatchObject(judged.get(dimension.dimension_id as string)!);
      }
    }
  });

  it.each(["text", "tool-call"] as const)(
    "preserves the F9 gate-backed verdict and deduplicates host notes on the %s adapter",
    async (path) => {
      for (const name of ["a", "b"] as const) {
        const value = await fixture();
        const technical = structuredClone(technicalVerification());
        technical.factInventory.limitations = [];
        for (const dimension of technical.factInventory.dimensions) {
          if (dimension.dimension === "environment-prerequisite") {
            dimension.status = "applicable";
          }
        }
        const fixturePath = join(
          runtimeRoot,
          "..",
          "quality",
          "tests",
          "fixtures",
          "documentation-quality-evaluation",
          `review-live-main-f05a81f1-${name}.json`,
        );
        const evaluation = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, any>;
        const expectedLayers = Object.fromEntries(
          Object.entries(evaluation.layers).map(([id, layer]) => [
            id,
            { decision: layer.decision, hard_gate_failures: [...layer.hard_gate_failures] },
          ]),
        );
        const expectedOverall = evaluation.overall_decision;
        const expectedGates = [...evaluation.hard_gate_failures];
        const modelLimitations = [...evaluation.limitations];
        const expectedModelLimitations = evaluation.limitations.filter(
          (limitation: string) => limitation !== AUDIENCE_PREREQUISITES_LIMITATION,
        );
        for (const layer of Object.values(evaluation.layers) as Array<Record<string, any>>) {
          for (const dimension of layer.dimensions as Array<Record<string, any>>) {
            if (dimension.assessment !== "not-applicable") continue;
            dimension.assessment = "not-assessed";
            for (const evidence of dimension.evidence as Array<Record<string, unknown>>) {
              evidence.strength = "none";
            }
            layer.limitations.push(
              `${dimension.dimension_id} was not assessed from the available evidence.`,
            );
          }
        }
        const target = evaluation.target as Record<string, any>;
        target.documentation_family_evidence = target.documentation_family_evidence.map(
          (entry: Record<string, unknown>) => ({ ...entry, paths: ["docs/guide.md"] }),
        );
        const artifactCandidate = {
          evaluation,
          qualityScore: null,
          reportMarkdown: candidate(value.selection.profile, value.revision).reportMarkdown,
          selectionSha256: value.selection.receipt.selectionSha256,
          answerPath: path,
        } as ReturnType<typeof candidate>;
        expect(artifactCandidate.reportMarkdown).not.toContain("## Validated result summary");
        addTechnicalTrace(artifactCandidate);
        artifactCandidate.evaluation.limitations = [...modelLimitations];
        omitHostWrittenQualityFields(artifactCandidate, value.selection.profile);
        const validated = await value.host.validate({
          ...validationInput(value, `quality-f9-${name}-${path}`, artifactCandidate),
          technicalVerification: technical,
        });
        expect(validated.binding.status).toBe("passed");
        expect(validatedSummary(validated.reportMarkdown)).toMatchObject({
          report_contract: "docsfab-quality-report-v0.2",
          validation: {
            evaluation: "passed",
            quality_score: "unavailable",
            report_binding: "passed",
          },
        });
        expect(validated.binding.hostDerivationCounts).toMatchObject({
          schemaVersion: 1,
          kind: "docsfab-quality-host-derivation-counts",
          duplicateLimitationsRemoved: 1,
          coherenceLabelsCount: 0,
        });
        expect(validated.binding.hostDerivationCounts?.hostMetadataFieldsChanged).toEqual(
          expect.any(Number),
        );
        expect(validated.binding.hostDerivationCounts?.ruleDerivedFieldsChanged).toEqual(
          expect.any(Number),
        );
        const staged = await loadStagedQualityArtifact(
          value.store,
          validated.binding.artifacts.evaluation!.recordSha256,
        );
        const actual = staged.payload as Record<string, any>;
        expect(actual.overall_decision).toBe(expectedOverall);
        expect(actual.hard_gate_failures).toEqual(expectedGates);
        expect(
          Object.fromEntries(
            Object.entries(actual.layers).map(([id, layer]) => [
              id,
              { decision: layer.decision, hard_gate_failures: layer.hard_gate_failures },
            ]),
          ),
        ).toEqual(expectedLayers);
        expect(actual.limitations).toEqual([
          ...expectedModelLimitations,
          AUDIENCE_PREREQUISITES_LIMITATION,
        ]);
        expect(new Set(actual.limitations).size).toBe(actual.limitations.length);
        expect(validated.reportMarkdown).toContain(
          "The host removed 1 byte-identical duplicate quality-profile limitation note.",
        );
      }
    },
  );

  it.each(["text", "tool-call"] as const)(
    "seals zero derivation counts and rule-module identity, rejects tampering, and decodes older bindings on %s",
    async (path) => {
      const value = await fixture();
      const artifactCandidate = candidate(value.selection.profile, value.revision);
      artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
      addTechnicalTrace(artifactCandidate);
      artifactCandidate.answerPath = path;
      omitHostWrittenQualityFields(artifactCandidate, value.selection.profile);
      const validated = await value.host.validate({
        ...validationInput(value, "quality-derivation-counts-codec", artifactCandidate),
        technicalVerification: technicalVerification(),
      });
      const counts = validated.binding.hostDerivationCounts;
      expect(validated.binding.validatorAssets.qualityRuleModuleSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(counts).toMatchObject({
        duplicateLimitationsRemoved: 0,
        coherenceLabelsCount: 0,
      });
      expect(decodeQualityValidationBinding(validated.binding).hostDerivationCounts).toEqual(
        counts,
      );

      const tampered = structuredClone(validated.binding);
      tampered.hostDerivationCounts!.coherenceLabelsCount += 1;
      expect(() => decodeQualityValidationBinding(tampered)).toThrow();

      const { bindingSha256: _bindingSha256, ...currentBody } = validated.binding;
      const { hostDerivationCounts: _hostDerivationCounts, ...legacyBody } = currentBody;
      const { qualityRuleModuleSha256: _qualityRuleModuleSha256, ...legacyValidatorAssets } =
        currentBody.validatorAssets;
      const legacy = sealQualityValidationBinding({
        ...legacyBody,
        validatorAssets: legacyValidatorAssets,
      });
      const decodedLegacy = decodeQualityValidationBinding(legacy);
      expect(decodedLegacy.hostDerivationCounts).toBeUndefined();
      expect(decodedLegacy.validatorAssets.qualityRuleModuleSha256).toBeUndefined();

      for (const invalidCount of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
        const malformed = sealQualityValidationBinding({
          ...currentBody,
          hostDerivationCounts: {
            ...counts!,
            duplicateLimitationsRemoved: invalidCount,
          },
        });
        expect(() => decodeQualityValidationBinding(malformed)).toThrow();
      }

      const malformedPresent = sealQualityValidationBinding({
        ...currentBody,
        hostDerivationCounts: null as unknown as NonNullable<typeof counts>,
      });
      expect(() => decodeQualityValidationBinding(malformedPresent)).toThrow();
      const unknownField = sealQualityValidationBinding({
        ...currentBody,
        hostDerivationCounts: {
          ...counts!,
          unexpected: true,
        } as NonNullable<typeof counts>,
      });
      expect(() => decodeQualityValidationBinding(unknownField)).toThrow();

      const malformedRuleModule = sealQualityValidationBinding({
        ...currentBody,
        validatorAssets: {
          ...currentBody.validatorAssets,
          qualityRuleModuleSha256: "not-a-sha256",
        },
      });
      expect(() => decodeQualityValidationBinding(malformedRuleModule)).toThrow();
    },
  );

  it("omits derivation counts when the full-artifact candidate takes the record pass-through path", async () => {
    const value = await fixture();
    const artifactCandidate = candidate(value.selection.profile, value.revision);
    artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
    addTechnicalTrace(artifactCandidate);
    expect(artifactCandidate.answerPath).toBeUndefined();
    const validated = await value.host.validate({
      ...validationInput(value, "quality-derivation-counts-passthrough", artifactCandidate),
      technicalVerification: technicalVerification(),
    });
    expect(validated.binding.status).toBe("passed");
    expect(validated.binding.hostDerivationCounts).toBeUndefined();
  });

  it.each(["text", "tool-call"] as const)(
    "returns the catalogued correctable D3 residual code through the %s adapter",
    async (path) => {
      const residualRule = JSON.parse(
        await readFile(
          join(
            runtimeRoot,
            "test/fixtures/model-output/quality-envelope/layer-residual-invalid.json",
          ),
          "utf8",
        ),
      ) as {
        code: string;
        location: string;
        reply: string;
      };
      const fixtureEnvelope = JSON.parse(residualRule.reply.split("\n\n#", 1)[0]!) as {
        evaluation: {
          layers: Record<string, { decision: string }>;
        };
      };
      const [fixtureLayerId, fixtureLayer] = Object.entries(fixtureEnvelope.evaluation.layers)[0]!;
      const ruleDeclaration = outputRuleFor(residualRule.code);
      expect(ruleDeclaration?.locations).toContain(residualRule.location);
      expect(ruleDeclaration?.retry).toBe("model-correctable");
      const value = await fixture();
      const technical = technicalVerification();
      const artifactCandidate = candidate(value.selection.profile, value.revision);
      artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
      addTechnicalTrace(artifactCandidate);
      artifactCandidate.answerPath = path;
      const targetLayer = (
        artifactCandidate.evaluation.layers as Record<string, Record<string, unknown>>
      )[fixtureLayerId]!;
      targetLayer.decision = fixtureLayer.decision;
      for (const dimension of targetLayer.dimensions as Array<Record<string, unknown>>) {
        dimension.assessment = "not-met";
      }
      const error = await value.host
        .validate({
          ...validationInput(value, `quality-d3-invalid-${path}`, artifactCandidate),
          technicalVerification: technical,
        })
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: "evaluation-invalid",
        rejection: {
          validator: "candidate-staging",
          code: residualRule.code,
          location: residualRule.location,
        },
      });
    },
  );

  it.each([
    ["text", "hard-gates"],
    ["tool-call", "hard-gates"],
    ["text", "limitations"],
    ["tool-call", "limitations"],
    ["text", "scalar-constraint"],
    ["tool-call", "scalar-constraint"],
  ] as const)(
    "preserves malformed model-owned %s %s for the locked validator",
    async (path, field) => {
      const value = await fixture();
      const technical = technicalVerification();
      const artifactCandidate = candidate(value.selection.profile, value.revision);
      artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
      addTechnicalTrace(artifactCandidate);
      if (field === "hard-gates") {
        delete artifactCandidate.evaluation.hard_gate_failures;
      } else if (field === "limitations") {
        artifactCandidate.evaluation.limitations = ["valid limitation", 3] as unknown as string[];
      } else {
        const constraints = artifactCandidate.evaluation.constraints as Record<string, unknown>;
        constraints.accessibility_and_inclusion = 3;
      }
      let admitted: QualityArtifactCandidateV1 | undefined;
      if (path === "text") {
        const reply = `${JSON.stringify({
          evaluation: artifactCandidate.evaluation,
          qualityScore: artifactCandidate.qualityScore,
        })}\n\n${artifactCandidate.reportMarkdown}`;
        admitted = (await admitThroughText(value, technical, `malformed-${field}-text`, reply))
          .qualityArtifactCandidate;
      } else {
        const submission = JSON.stringify({
          evaluation: artifactCandidate.evaluation,
          qualityScore: artifactCandidate.qualityScore,
        });
        admitted = (
          await admitThroughToolCall(value, technical, `malformed-${field}-tool`, submission)
        ).qualityArtifactCandidate;
      }
      expect(admitted?.answerPath).toBe(path === "text" ? "text" : "tool-call");
      const error = await value.host
        .validate({
          ...validationInput(value, `malformed-${field}-${path}`, admitted!),
          technicalVerification: technical,
        })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(QualityArtifactValidationError);
      expect((error as QualityArtifactValidationError).code).toBe("evaluation-invalid");
      expect((error as QualityArtifactValidationError).rejection?.code).toMatch(
        /evaluation-schema-|evaluation-profile-semantics/u,
      );
    },
  );

  it.each([
    { path: "text", defect: "layers", expectedLocation: "$.layers" },
    {
      path: "tool-call",
      defect: "constraints",
      expectedLocation: "$.constraints.accessibility_and_inclusion",
    },
    {
      path: "text",
      defect: "dimensions",
      expectedLocation: "$.layers.trustworthy_information.dimensions",
    },
    { path: "tool-call", defect: "gates", expectedLocation: "$.hard_gate_failures" },
  ] as const)(
    "retains independently host-owned fields before rejecting an early model-owned $defect defect on the $path admission path",
    async ({ path, defect, expectedLocation }) => {
      const value = await fixture();
      const technical = technicalVerification();
      const artifactCandidate = candidate(value.selection.profile, value.revision);
      artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
      addTechnicalTrace(artifactCandidate);

      // Keep the model's complete judgments and rule-derived values, but omit
      // the metadata the host owns. A malformed gate makes semantic derivation
      // take its early pass-through path; the locked schema should then report
      // that authored gate defect instead of failing on an omitted host field.
      const evaluation = artifactCandidate.evaluation;
      for (const field of [
        "evaluation_id",
        "evaluation_version",
        "evaluated_at",
        "model_version",
        "profile",
        "evaluator",
        "outcomes",
      ])
        delete evaluation[field];
      const target = evaluation.target as Record<string, unknown>;
      for (const field of [
        "scope_type",
        "paths",
        "repository_revision",
        "documentation_revision",
        "approved_evidence_revision",
        "delivery_surface_locator",
      ])
        delete target[field];
      // Dimension applicability is a model-authored derivation input and is
      // deliberately retained here.
      const requiredConstraints = new Set(
        ((value.selection.profile.constraints as Record<string, unknown>).required as string[]).map(
          (id) => id.replaceAll("-", "_"),
        ),
      );
      for (const [key, constraint] of Object.entries(
        evaluation.constraints as Record<string, Record<string, unknown>>,
      )) {
        delete constraint.dimension_id;
        if (requiredConstraints.has(key)) delete constraint.applicability;
      }
      for (const finding of evaluation.findings as Array<Record<string, unknown>>) {
        delete finding.id;
        delete finding.owner;
        delete finding.status;
      }
      if (defect === "layers") {
        evaluation.layers = "authored layers must be an object" as unknown as Record<
          string,
          unknown
        >;
      } else if (defect === "constraints") {
        delete (evaluation.constraints as Record<string, unknown>).accessibility_and_inclusion;
      } else if (defect === "dimensions") {
        const firstLayer = Object.values(
          evaluation.layers as Record<string, Record<string, unknown>>,
        )[0]!;
        firstLayer.dimensions = "authored dimensions must be an array" as unknown as unknown[];
      } else {
        evaluation.hard_gate_failures = "authored gate must be an array" as unknown as string[];
      }

      const submission = JSON.stringify({
        evaluation: artifactCandidate.evaluation,
        qualityScore: artifactCandidate.qualityScore,
      });
      const admitted =
        path === "text"
          ? await admitThroughText(
              value,
              technical,
              `early-host-fill-${defect}-${path}`,
              `${submission}\n\n${artifactCandidate.reportMarkdown}`,
            )
          : await admitThroughToolCall(
              value,
              technical,
              `early-host-fill-${defect}-${path}`,
              submission,
            );
      expect(admitted.qualityArtifactCandidate?.answerPath).toBe(path);

      const error = await value.host
        .validate({
          ...validationInput(
            value,
            `early-host-fill-${defect}-${path}`,
            admitted.qualityArtifactCandidate!,
          ),
          technicalVerification: technical,
        })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(QualityArtifactValidationError);
      expect((error as QualityArtifactValidationError).code).toBe("evaluation-invalid");
      expect((error as QualityArtifactValidationError).rejection.location).toBe(expectedLocation);
      expect(
        (error as QualityArtifactValidationError).binding.hostDerivationCounts,
      ).toBeUndefined();
    },
  );

  it.each(
    (["text", "tool-call"] as const).flatMap((path) =>
      [
        { field: "constraints", malformed: "missing", location: "$.constraints" },
        { field: "constraints", malformed: "scalar", location: "$.constraints" },
        { field: "constraints", malformed: "array", location: "$.constraints" },
        {
          field: "layer-entry",
          malformed: "scalar",
          location: "$.layers.trustworthy_information",
        },
        {
          field: "layer-entry",
          malformed: "null",
          location: "$.layers.trustworthy_information",
        },
      ].map((shape) => ({ path, ...shape })),
    ),
  )(
    "routes malformed $field $malformed from $path admission to model validation after host metadata fill",
    async ({ path, field, malformed, location }) => {
      const value = await fixture();
      const technical = technicalVerification();
      const artifactCandidate = candidate(value.selection.profile, value.revision);
      artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
      addTechnicalTrace(artifactCandidate);

      // Remove only independently host-owned metadata. Keep model judgments,
      // dimension applicability, and gate inputs unchanged.
      const evaluation = artifactCandidate.evaluation;
      for (const key of [
        "evaluation_id",
        "evaluation_version",
        "evaluated_at",
        "model_version",
        "profile",
        "evaluator",
        "outcomes",
      ])
        delete evaluation[key];
      const target = evaluation.target as Record<string, unknown>;
      for (const key of [
        "scope_type",
        "paths",
        "repository_revision",
        "documentation_revision",
        "approved_evidence_revision",
        "delivery_surface_locator",
      ])
        delete target[key];
      if (field === "constraints") {
        if (malformed === "missing") delete evaluation.constraints;
        else if (malformed === "scalar") evaluation.constraints = "authored constraints";
        else evaluation.constraints = ["authored constraints"];
      } else {
        const layers = evaluation.layers as Record<string, unknown>;
        const layerId = Object.keys(layers)[0]!;
        layers[layerId] = malformed === "null" ? null : "authored layer";
      }

      const submission = JSON.stringify({
        evaluation,
        qualityScore: artifactCandidate.qualityScore,
      });
      const admitted =
        path === "text"
          ? await admitThroughText(
              value,
              technical,
              `malformed-shape-${field}-${malformed}-${path}`,
              `${submission}\n\n${artifactCandidate.reportMarkdown}`,
            )
          : await admitThroughToolCall(
              value,
              technical,
              `malformed-shape-${field}-${malformed}-${path}`,
              submission,
            );
      expect(admitted.qualityArtifactCandidate?.answerPath).toBe(path);

      const error = await value.host
        .validate({
          ...validationInput(
            value,
            `malformed-shape-${field}-${malformed}-${path}`,
            admitted.qualityArtifactCandidate!,
          ),
          technicalVerification: technical,
        })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(QualityArtifactValidationError);
      expect((error as QualityArtifactValidationError).code).toBe("evaluation-invalid");
      expect((error as QualityArtifactValidationError).rejection.validator).toBe("evaluation");
      expect((error as QualityArtifactValidationError).rejection.location).toBe(location);
      expect(
        (error as QualityArtifactValidationError).binding.hostDerivationCounts,
      ).toBeUndefined();
      expect((error as QualityArtifactValidationError).binding.artifacts.evaluation).not.toBeNull();

      const staged = await loadStagedQualityArtifact(
        value.store,
        (error as QualityArtifactValidationError).binding.artifacts.evaluation!.recordSha256,
      );
      expect(staged.payload).toMatchObject({
        evaluation_id: `malformed-shape-${field}-${malformed}-${path}:evaluate-document-quality:1`,
        evaluation_version: "1.0",
        model_version: value.selection.receipt.profileModel,
        profile: {
          id: value.selection.receipt.profileId,
          version: value.selection.receipt.profileVersion,
        },
        evaluator: {
          provider_id: "fixture-provider",
          provider_type: "agent",
        },
        outcomes: { human: [], agent: [] },
      });
      expect((staged.payload as Record<string, unknown>).target).toMatchObject({
        scope_type: "documentation-set",
        repository_revision: value.revision,
      });
    },
  );

  it.each([
    {
      kind: "known host check",
      error: () => hostCheckError("report-artifact-not-object"),
      expectedCode: "report-artifact-not-object",
    },
    {
      kind: "unexpected host exception",
      error: () => new Error("DO-NOT-RETAIN-HOST-EXCEPTION-MESSAGE"),
      expectedCode: "candidate-staging-integrity-failed",
    },
  ])(
    "retains closed provenance for a $kind without serializing its message",
    async ({ error: createError, expectedCode }) => {
      const value = await fixture();
      const artifactCandidate = candidate(value.selection.profile, value.revision);
      artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
      artifactCandidate.answerPath = "text";
      const internals = value.host as unknown as {
        deriveFullArtifactCandidate: (...args: never[]) => Promise<unknown>;
      };
      vi.spyOn(internals, "deriveFullArtifactCandidate").mockRejectedValue(createError());

      const error = await value.host
        .validate(validationInput(value, `stage-provenance-${expectedCode}`, artifactCandidate))
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(QualityArtifactValidationError);
      expect((error as QualityArtifactValidationError).code).toBe("artifact-integrity-invalid");
      expect((error as QualityArtifactValidationError).rejection).toMatchObject({
        validator: "candidate-staging",
        code: expectedCode,
        location: "$",
      });
      expect(JSON.stringify((error as QualityArtifactValidationError).binding)).not.toContain(
        "DO-NOT-RETAIN-HOST-EXCEPTION-MESSAGE",
      );
      expect((error as Error).message).not.toContain("DO-NOT-RETAIN-HOST-EXCEPTION-MESSAGE");
    },
  );

  it("rethrows the locked deriver's coded terminal failure without creating a validation binding", async () => {
    const value = await fixture();
    const artifactCandidate = candidate(value.selection.profile, value.revision);
    artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
    artifactCandidate.answerPath = "text";
    const derivationFailure = new QualityDerivationError("deriver-exit");
    vi.spyOn(value.host, "derive").mockRejectedValue(derivationFailure);

    const error = await value.host
      .validate(validationInput(value, "deriver-terminal-failure", artifactCandidate))
      .catch((caught: unknown) => caught);
    expect(error).toBe(derivationFailure);
    expect(error).toMatchObject({
      code: "quality-derivation-failed",
      failureClass: "infrastructure",
      retryable: false,
      reason: "deriver-exit",
    });
  });

  it("T-S1: admits members sent as JSON strings into the same candidate, which the locked validators pass (#1707 v9)", async () => {
    const value = await fixture();
    const technical = technicalVerification();
    const artifactCandidate = candidate(value.selection.profile, value.revision);
    artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
    addTechnicalTrace(artifactCandidate);
    (artifactCandidate.evaluation.evaluator as Record<string, unknown>).independence_evidence =
      'The "fixture" evaluator is {independent} of the target author \\ and ```authors```.';
    const evaluationText = JSON.stringify(artifactCandidate.evaluation);
    const scoreText = JSON.stringify(artifactCandidate.qualityScore);
    // The raw arguments a stringifying serving stack forwards: each member is
    // one JSON string holding its JSON.
    const stringified = `{"evaluation":${JSON.stringify(evaluationText)},"qualityScore":${JSON.stringify(scoreText)}}`;
    const objectForm = `{"evaluation":${evaluationText},"qualityScore":${scoreText}}`;

    const fromString = await admitThroughToolCall(
      value,
      technical,
      "quality-tool-call-string",
      stringified,
    );
    const fromObject = await admitThroughToolCall(
      value,
      technical,
      "quality-tool-call-object",
      objectForm,
    );

    expect(JSON.stringify(fromString.qualityArtifactCandidate)).toBe(
      JSON.stringify(fromObject.qualityArtifactCandidate),
    );
    expect(fromString.answerSubmission).toMatchObject({
      submission: "admitted",
      memberEncoding: { evaluation: "string", qualityScore: "string" },
    });
    const validated = await value.host.validate({
      ...validationInput(value, "quality-tool-call-string", fromString.qualityArtifactCandidate!),
      technicalVerification: technical,
    });
    expect(validated.binding).toMatchObject({ status: "passed", failureCode: null });
  });

  it("T-S10: refuses in staging a credential that inner escapes hid from every raw screen (#1707 v9)", async () => {
    const value = await fixture();
    const technical = technicalVerification();
    const artifactCandidate = candidate(value.selection.profile, value.revision);
    artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
    addTechnicalTrace(artifactCandidate);
    const credential = `glpat-${"x".repeat(24)}`;
    (artifactCandidate.evaluation.evaluator as Record<string, unknown>).independence_evidence =
      `Evaluator note ${credential}.`;
    // The member string escapes the credential's hyphen, so the raw arguments,
    // and Pi's one-level parse of them, read `glpat\\u002d…`.
    const evaluationText = JSON.stringify(artifactCandidate.evaluation).replace(
      "glpat-",
      "glpat\\u002d",
    );
    const submission = `{"evaluation":${JSON.stringify(evaluationText)},"qualityScore":null}`;
    expect(submission).not.toContain("glpat-");
    expect((JSON.parse(submission) as { evaluation: string }).evaluation).not.toContain("glpat-");

    const result = await admitThroughToolCall(
      value,
      technical,
      "quality-tool-call-hidden",
      submission,
    );
    const admitted = result.qualityArtifactCandidate!;
    expect(JSON.stringify(admitted.evaluation)).toContain(credential);

    const error = await value.host
      .validate({
        ...validationInput(value, "quality-tool-call-hidden", admitted),
        technicalVerification: technical,
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(QualityArtifactValidationError);
    expect((error as QualityArtifactValidationError).code).toBe("candidate-invalid");
    expect((error as QualityArtifactValidationError).rejection).toMatchObject({
      validator: "candidate-staging",
      code: "candidate-credential-material",
    });
  });

  describe("the runner's resolved answer path", () => {
    const workflow = getWorkflow("review-documentation");
    const evaluatorStep = workflow.steps.find(
      (step) => step.skill === "evaluate-document-quality",
    )!;
    /** The evaluate-step tool policy the runner records for the evaluator under a path. */
    const toolPolicyFor = (path: HarnessStepInput["answerSubmission"]) => {
      const grantedTools = grantedToolsForStep(
        workflow,
        evaluatorStep,
        true,
        false,
        false,
        false,
        false,
        undefined,
        path,
      );
      return {
        grantedTools,
        digest: canonicalDigest({
          mode: evaluatorStep.mode,
          grantedTools: [...grantedTools].sort(),
        }),
      };
    };

    /** A review run whose evaluator step goes to `evaluator`; every other step is a fixture. */
    async function answerPathRun(
      value: QualityFixture,
      answerSubmission: NonNullable<
        ConstructorParameters<typeof WorkflowRunner>[0]["answerSubmission"]
      >,
      evaluator: AgentHarness["runStep"],
      toolCeiling?: readonly string[],
    ) {
      const evaluatorInputs: HarnessStepInput[] = [];
      const harness: AgentHarness = {
        runStep: async (input) => {
          if (input.step.skill !== "evaluate-document-quality") {
            return {
              summary: `${input.step.skill} completed`,
              ...(await verificationFixture(input)),
            };
          }
          evaluatorInputs.push(input);
          return evaluator(input);
        },
      };
      const record = await new WorkflowRunner({
        harness,
        hostOperations: { runStep: (input) => harness.runStep(input) },
        store: new MemoryStore(),
        ...qualityRunnerOptions(value),
        answerSubmission,
        ...(toolCeiling ? { toolCeiling } : {}),
        id: () => "quality-answer-path-runner",
      }).run(reviewRunRequest(value));
      return { record, evaluatorInputs };
    }

    it("reaches the evaluator's input, the runner's grant, and the real harness on a recorded route", async () => {
      const value = await fixture();
      const artifactCandidate = candidate(value.selection.profile, value.revision);
      artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
      const submission = JSON.stringify({
        evaluation: artifactCandidate.evaluation,
        qualityScore: artifactCandidate.qualityScore,
      });
      const bodies = recordingProvider([
        rawToolCallTurn([submissionCall("submit-1", submission, 5)]),
        textTurn(artifactCandidate.reportMarkdown),
      ]);
      const real = toolPathHarness();
      let run: Awaited<ReturnType<typeof answerPathRun>>;
      try {
        // Nothing here sets the step input's answer path: the runner resolves it.
        run = await answerPathRun(
          value,
          { option: "recorded", capability: RECORDED_CAPABILITY },
          (input) => real.runStep(input),
        );
      } finally {
        vi.unstubAllGlobals();
      }
      const { record, evaluatorInputs } = run;

      expect(evaluatorInputs.map((input) => input.answerSubmission)).toEqual([
        { path: "tool-call", reason: "recorded-route" },
      ]);
      // The real harness granted the tool and asked for the report in a tool-free turn.
      const toolNames = (body: Record<string, unknown>) =>
        ((body.tools ?? []) as Array<{ function: { name: string } }>).map(
          (tool) => tool.function.name,
        );
      expect(bodies).toHaveLength(2);
      expect(toolNames(bodies[0]!)).toContain(SUBMIT);
      expect(bodies[1]!.tool_choice).toBe("none");
      expect(record.status).toBe("succeeded");
      expect(record.qualityArtifactValidation?.status).toBe("passed");
      const step = record.steps.find((entry) => entry.id === evaluatorStep.id)!;
      expect(step.inference?.attempts.at(-1)?.answerSubmission).toMatchObject({
        path: "tool-call",
        reason: "recorded-route",
        submission: "admitted",
      });
      // The runner's own grant, recorded in the evaluate-step evidence, holds the tool.
      const toolCall = toolPolicyFor({ path: "tool-call", reason: "recorded-route" });
      expect(toolCall.grantedTools).toContain(SUBMIT);
      expect(step.evaluateEvidence?.toolPolicySha256).toBe(toolCall.digest);
      expect(toolCall.digest).not.toBe(toolPolicyFor(undefined).digest);
    });

    it("resolves operator-override under the text-final option on the same route", async () => {
      const value = await fixture();
      const artifactCandidate = candidate(value.selection.profile, value.revision);
      artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
      const { record, evaluatorInputs } = await answerPathRun(
        value,
        { option: "text-final", capability: RECORDED_CAPABILITY },
        async (input) => ({
          summary: artifactCandidate.reportMarkdown,
          qualityArtifactCandidate: artifactCandidate,
          skill: { id: input.step.skill, contentSha256: "f".repeat(64) },
        }),
      );

      expect(evaluatorInputs.map((input) => input.answerSubmission)).toEqual([
        { path: "text-final", reason: "operator-override" },
      ]);
      expect(record.status).toBe("succeeded");
      const step = record.steps.find((entry) => entry.id === evaluatorStep.id)!;
      const textFinal = toolPolicyFor({ path: "text-final", reason: "operator-override" });
      expect(textFinal.grantedTools).not.toContain(SUBMIT);
      expect(step.evaluateEvidence?.toolPolicySha256).toBe(textFinal.digest);
    });

    it("resolves tool-not-granted on a recorded route when the host tool ceiling excludes the submit tool", async () => {
      const value = await fixture();
      const artifactCandidate = candidate(value.selection.profile, value.revision);
      artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
      // Every tool any step of the workflow is granted on the text path; the
      // submit tool is not among them.
      const toolCeiling = [
        ...new Set(
          workflow.steps.flatMap((step) =>
            grantedToolsForStep(workflow, step, true, false, false, false, false, undefined, {
              path: "text-final",
              reason: "operator-override",
            }),
          ),
        ),
      ].sort();
      expect(toolCeiling).not.toContain(SUBMIT);
      const { record, evaluatorInputs } = await answerPathRun(
        value,
        { option: "recorded", capability: RECORDED_CAPABILITY },
        async (input) => ({
          summary: artifactCandidate.reportMarkdown,
          qualityArtifactCandidate: artifactCandidate,
          skill: { id: input.step.skill, contentSha256: "f".repeat(64) },
        }),
        toolCeiling,
      );

      // The runner, not a test, resolves the reason from its own tool ceiling.
      expect(evaluatorInputs.map((input) => input.answerSubmission)).toEqual([
        { path: "text-final", reason: "tool-not-granted" },
      ]);
      expect(record.status).toBe("succeeded");
      const step = record.steps.find((entry) => entry.id === evaluatorStep.id)!;
      expect(step.evaluateEvidence?.toolPolicySha256).toBe(
        toolPolicyFor({ path: "text-final", reason: "tool-not-granted" }).digest,
      );
    });
  });

  it("seals a consolidated final finding only when its full technical trace is present", async () => {
    const value = await fixture();
    const technical = technicalVerification();
    const artifactCandidate = candidate(value.selection.profile, value.revision);
    artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
    addTechnicalTrace(artifactCandidate);

    const validated = await value.host.validate({
      ...validationInput(value, "quality-technical-trace-pass", artifactCandidate),
      technicalVerification: technical,
    });

    expect(validated.binding).toMatchObject({ status: "passed", failureCode: null });
  });

  it("revalidates the final candidate after an advisory tool pass and rejects drift", async () => {
    const value = await fixture();
    const technical = technicalVerification();
    const artifactCandidate = candidate(value.selection.profile, value.revision);
    artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
    addTechnicalTrace(artifactCandidate);
    const draft = JSON.stringify({
      evaluation: artifactCandidate.evaluation,
      qualityScore: artifactCandidate.qualityScore,
      reportMarkdown: artifactCandidate.reportMarkdown,
    });
    const tool = createQualityCandidateValidationTool({
      selection: value.selection.receipt,
      technicalVerification: technical,
    });
    const advisory = await tool.execute(
      "candidate-pass",
      { candidateJson: draft },
      undefined,
      undefined,
      undefined as never,
    );
    expect(JSON.parse((advisory.content[0] as { text: string }).text)).toMatchObject({
      status: "passed",
      violations: [],
    });

    // The drift drops the admitted uncertainty, which only the evaluator can supply.
    artifactCandidate.answerPath = "text";
    (artifactCandidate.evaluation.findings as Array<Record<string, unknown>>)[0]!.evidence = [
      {
        evidence_class: "grounded-judgment",
        strength: "direct",
        provider_id: "fixture-evaluator",
        locator: "src/cli.ts:85-91",
        description: "A drifted description without the admitted uncertainty.",
      },
    ];
    const error = await value.host
      .validate({
        ...validationInput(value, "quality-final-drift", artifactCandidate),
        technicalVerification: technical,
      })
      .catch((candidateError: unknown) => candidateError);
    expect(error).toBeInstanceOf(QualityArtifactValidationError);
    expect((error as QualityArtifactValidationError).code).toBe("technical-trace-incomplete");
    expect((error as QualityArtifactValidationError).binding.hostDerivationCounts).toBeDefined();
  });

  // A linked finding whose locator is not the admitted one does not fail: the
  // host carries the exact admitted locator beside the evaluator's own, which
  // it keeps verbatim. The inspection tests above still show that such a
  // locator alone never satisfies the trace check.
  it.each([
    ["truncated range", "src/cli.ts:85-90"],
    ["covering range", "src/cli.ts:84-92"],
    ["unsafe URI", "file:///tmp/src/cli.ts:85-91"],
  ])(
    "carries the exact admitted locator beside a %s locator the evaluator cited",
    async (_name, locator) => {
      const value = await fixture();
      const artifactCandidate = candidate(value.selection.profile, value.revision);
      artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
      addTechnicalTrace(artifactCandidate, locator);
      const cited = structuredClone(
        (artifactCandidate.evaluation.findings as Array<Record<string, unknown>>)[0]!.evidence,
      );

      const validated = await value.host.validate({
        ...validationInput(
          value,
          `quality-technical-trace-${_name.replaceAll(" ", "-")}`,
          artifactCandidate,
        ),
        technicalVerification: technicalVerification(),
      });

      expect(validated.binding).toMatchObject({ status: "passed", failureCode: null });
      const staged = await loadStagedQualityArtifact(
        value.store,
        validated.binding.artifacts.evaluation!.recordSha256,
      );
      const stagedFinding = (staged.payload as { findings: Array<Record<string, unknown>> })
        .findings[0]!;
      expect(stagedFinding.evidence).toEqual([
        ...(cited as unknown[]),
        {
          ...HOST_CARRIED_LOCATOR_EVIDENCE,
          locator: "src/cli.ts:85-91",
          description: hostCarriedLocatorDescription("FACT-TRACE-001"),
        },
      ]);
    },
  );

  it.each([false, true])(
    "validates the complete workflow with focused=%s and retains discovery gaps",
    async (focused) => {
      const value = await fixture(true, focused);
      const observedPrompts: string[] = [];
      const observedSelections: Array<string | undefined> = [];
      const observedTechnicalDigests: string[] = [];
      const harness: AgentHarness = {
        runStep: async (input) => {
          expect(input.reviewScope).toEqual(value.reviewScope);
          observedSelections.push(input.qualityProfileSelection?.selectionSha256);
          observedPrompts.push(input.step.prompt);
          if (input.step.skill !== "evaluate-document-quality") {
            return {
              summary: `${input.step.skill} completed`,
              ...(await verificationFixture(input)),
            };
          }
          expect(input.technicalVerification).toBeDefined();
          expect(input.evidenceIdentity?.technicalVerificationSha256).toMatch(/^[0-9a-f]{64}$/u);
          observedTechnicalDigests.push(input.evidenceIdentity!.technicalVerificationSha256!);
          const artifactCandidate = candidate(value.selection.profile, value.revision);
          if (focused) {
            (artifactCandidate.evaluation.target as { paths: string[] }).paths = ["docs/guide.md"];
          }
          artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
          return {
            summary: artifactCandidate.reportMarkdown,
            qualityArtifactCandidate: artifactCandidate,
            skill: { id: input.step.skill, contentSha256: "f".repeat(64) },
          };
        },
      };
      const store = new MemoryStore();
      const runner = new WorkflowRunner({
        harness,
        hostOperations: { runStep: (input) => harness.runStep(input) },
        store,
        ...qualityRunnerOptions(value),
        id: () => "quality-runner-seam",
      });
      const record = await runner.run({
        ...reviewRunRequest(value),
        ...(value.reviewScope ? { reviewScope: value.reviewScope } : {}),
      });

      expect(record.status).toBe("succeeded");
      expect(record.qualityProfileSelection?.documentCount).toBe(focused ? 1 : 2);
      expect(record.qualityProfileSelection).toEqual(value.selection.receipt);
      expect(record.qualityArtifactValidation?.status).toBe("passed");
      expect(store.records[0]?.status).toBe("queued");
      expect(store.records[0]?.qualityProfileSelection).toEqual(value.selection.receipt);
      expect(observedSelections).toHaveLength(8);
      expect(observedTechnicalDigests).toHaveLength(1);
      expect(
        record.steps.at(-1)?.inference?.attempts[0]?.identity?.technicalVerificationSha256,
      ).toBe(observedTechnicalDigests[0]);
      expect(record.evidenceWarnings).toEqual(value.selection.discoveryLimitations);
      expect(
        observedPrompts.every((prompt) => prompt.includes("Repository discovery is incomplete")),
      ).toBe(true);
      expect(projectQualityReportFromRun(record)?.limitations).toEqual(
        expect.arrayContaining([...value.selection.discoveryLimitations!]),
      );
      expect(
        observedSelections.every((digest) => digest === value.selection.receipt.selectionSha256),
      ).toBe(true);
    },
  );

  it("rejects technical verification mutation before final host validation", async () => {
    const value = await fixture();
    const validate = vi.spyOn(value.host, "validate");
    const harness: AgentHarness = {
      runStep: async (input) => {
        if (input.step.skill !== "evaluate-document-quality") {
          return {
            summary: `${input.step.skill} completed`,
            ...(await verificationFixture(input)),
          };
        }
        const mutableVerification = input.technicalVerification as unknown as {
          factInventory: { dimensions: Array<{ facts: Array<{ statement: string }> }> };
        };
        const fact = mutableVerification.factInventory.dimensions.flatMap(
          (dimension) => dimension.facts,
        )[0]!;
        fact.statement = `${fact.statement} Mutated after admission.`;
        input.evidenceIdentity!.technicalVerificationSha256 = canonicalDigest(
          input.technicalVerification,
        );
        const artifactCandidate = candidate(value.selection.profile, value.revision);
        artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
        return {
          summary: artifactCandidate.reportMarkdown,
          qualityArtifactCandidate: artifactCandidate,
          skill: { id: input.step.skill, contentSha256: "f".repeat(64) },
        };
      },
    };
    const record = await new WorkflowRunner({
      harness,
      hostOperations: { runStep: (input) => harness.runStep(input) },
      store: new MemoryStore(),
      ...qualityRunnerOptions(value),
      id: () => "quality-technical-mutation-rejection",
    }).run(reviewRunRequest(value));

    expect(record).toMatchObject({
      status: "failed",
      error: "The admitted technical verification changed during final evaluation.",
    });
    expect(record.qualityArtifactValidation).toBeUndefined();
    expect(record.steps.at(-1)?.qualityValidationRejection).toEqual({
      validator: "candidate-admission",
      code: "quality-technical-verification-changed",
      location: "$",
      issueCount: 1,
    });
    expect(validate).not.toHaveBeenCalled();
  });

  it("keeps the evaluator report accessible when formal validation fails", async () => {
    const value = await fixture();
    const harness: AgentHarness = {
      runStep: async (input) => {
        if (input.step.skill !== "evaluate-document-quality") {
          return {
            summary: `${input.step.skill} completed`,
            ...(await verificationFixture(input)),
          };
        }
        const artifactCandidate = candidate(value.selection.profile, value.revision);
        artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
        artifactCandidate.evaluation.overall_decision = "pass";
        return {
          summary: artifactCandidate.reportMarkdown,
          qualityArtifactCandidate: artifactCandidate,
          skill: { id: input.step.skill, contentSha256: "f".repeat(64) },
        };
      },
    };
    const store = new MemoryStore();
    const runner = new WorkflowRunner({
      harness,
      hostOperations: { runStep: (input) => harness.runStep(input) },
      store,
      ...qualityRunnerOptions(value),
      id: () => "quality-runner-failure-seam",
    });

    const record = await runner.run(reviewRunRequest(value));

    // Formal validation still refuses the candidate exactly as before (a
    // model-content refusal with no retry budget configured is already the
    // step's final attempt); the one thing that changes is the review no
    // longer fails outright over it -- the evaluator's own already-safe
    // report text stays accessible either way.
    expect(record.status).toBe("succeeded");
    expect(record.qualityArtifactValidation).toBeUndefined();
    expect(record.steps.at(-1)).toMatchObject({
      status: "succeeded",
      summary: expect.stringContaining("# Documentation quality evaluation report"),
    });
    expect(record.steps.at(-1)?.summary).toContain(QUALITY_REPORT_DECLINE_STEM);
    // A decline is a disclosed, known absence: the projector recognizes the
    // host's own stem and returns `null` directly, the same as a workflow
    // that never ran this step at all -- not the unexplained-gap exception
    // `missing-report`/`invalid-report` name for a step that ran and left
    // no trace of why.
    expect(projectQualityReportFromRun(record)).toBeNull();
  });

  it("refuses JSON residue after the answer object before the validators publish it as the report", async () => {
    const value = await fixture();
    const artifact = candidate(value.selection.profile, value.revision);
    const head = JSON.stringify({
      evaluation: artifact.evaluation,
      qualityScore: null,
    });
    const report = artifact.reportMarkdown;
    // Restarted answer heads whose free text holds inline code.
    const evaluationWithCode = {
      ...artifact.evaluation,
      evaluator: {
        ...(artifact.evaluation.evaluator as Record<string, unknown>),
        independence_evidence: "The fixture evaluator does not edit `README.md`.",
      },
    };
    const restartedQualityScoreFirst = JSON.stringify({
      qualityScore: null,
      evaluation: evaluationWithCode,
    });
    const restartedEvaluationFirst = JSON.stringify({
      evaluation: evaluationWithCode,
      qualityScore: { rationale: "Scored from the `docs/` pages." },
    });
    // The final admission's decoder, then the real validators and locked report template.
    const admitThenValidate = async (runId: string, reply: string) => {
      let decoded: QualityArtifactCandidateV1;
      try {
        decoded = decodeQualityArtifactResponse(reply, {
          selectionSha256: value.selection.receipt.selectionSha256,
        } as Parameters<typeof decodeQualityArtifactResponse>[1]);
      } catch (error) {
        if (error instanceof QualityArtifactEnvelopeError) return { refused: error.rejection };
        throw error;
      }
      const validated = await value.host.validate(validationInput(value, runId, decoded));
      return {
        status: validated.binding.status,
        opening: validated.reportMarkdown.split("\n", 1)[0],
      };
    };
    // Positive control: a report with a fenced JSON example and braces in prose.
    const withJsonContent = [
      report,
      "",
      "## Separate evidence views",
      "",
      'The guide passes `{"retries": 3}` and a map like {a: 1}.',
      "",
      "```json",
      '{"evaluation": {"decision": "fail"}, "qualityScore": null}',
      "```",
    ].join("\n");
    expect(await admitThenValidate("answer-form-control", `${head}\n\n${withJsonContent}`)).toEqual(
      {
        status: "passed",
        opening: "# Documentation quality evaluation report",
      },
    );
    // The real Nemotron Super shape: a lone fence line ends the report after a
    // balanced JSON block. It hides nothing, so the report is admitted without it.
    expect(
      await admitThenValidate("answer-form-stray-fence", `${head}\n\n${withJsonContent}\n\`\`\`\n`),
    ).toEqual({
      status: "passed",
      opening: "# Documentation quality evaluation report",
    });
    const residue: ReadonlyArray<readonly [string, string, { code: string; location: string }]> = [
      [
        "early-close-raw",
        `${head}, "reportMarkdown": "${report}"}`,
        { code: "quality-envelope-json-after-object", location: "$" },
      ],
      [
        "early-close-escaped",
        `${head}, "reportMarkdown": ${JSON.stringify(report)}}`,
        { code: "quality-envelope-json-after-object", location: "$" },
      ],
      [
        "json-after-report",
        `${head}\n\n${report}\n{"qualityScore": null}`,
        { code: "quality-envelope-report-member", location: "$.reportMarkdown" },
      ],
      [
        "restarted-answer",
        `${head}\n\n# Documentation quality evaluation report\n\n## Evid${head}\n\n${report}`,
        { code: "quality-envelope-report-member", location: "$.reportMarkdown" },
      ],
      // A cut inside an inline code span, then a restart on the same line: the
      // open backtick pairs with one in the restarted head, so a span covers
      // its member names. The object opening is refused all the same.
      [
        "restarted-answer-in-inline-code-quality-score-first",
        `${head}\n\n# Documentation quality evaluation report\n\nRun \`docsfab ru${restartedQualityScoreFirst}\n\n${report}`,
        { code: "quality-envelope-report-member", location: "$.reportMarkdown" },
      ],
      [
        "restarted-answer-in-inline-code-evaluation-first",
        `${head}\n\n# Documentation quality evaluation report\n\nRun \`docsfab ru${restartedEvaluationFirst}\n\n${report}`,
        { code: "quality-envelope-report-member", location: "$.reportMarkdown" },
      ],
    ];
    for (const [runId, reply, rejection] of residue) {
      expect(await admitThenValidate(runId, reply), runId).toEqual({
        refused: rejection,
      });
    }
  });

  it("runs the exact validators, seals locators, and projects validated insufficient evidence", async () => {
    const value = await fixture();
    const target = join(value.root, "target.md");
    await writeFile(target, "target remains unchanged\n", "utf8");
    const before = sha256(await readFile(target));
    const artifactCandidate = candidate(value.selection.profile, value.revision);
    artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;

    const validated = await value.host.validate(
      validationInput(value, "quality-run", artifactCandidate),
    );

    expect(validated.binding.status).toBe("passed");
    expect(validated.binding.artifacts.qualityScore).toBeNull();
    expect(validated.binding.validators.evaluation?.receiptSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(validated.binding.validators.qualityScore).toBeNull();
    expect(validated.binding.validators.reportBinding?.receiptSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(sha256(await readFile(target))).toBe(before);

    const record = validatedRunRecord(value, validated);
    const projection = projectQualityReportFromRun(record);
    expect(projection).toMatchObject({
      schemaVersion: 2,
      decision: "insufficient-evidence",
      rubric: { status: "unavailable" },
      repositoryRevision: value.revision,
    });
    expect(projection?.schemaVersion === 2 && projection.retainedGapEvidence).toMatchObject([
      { reason: "experimental-profile-ceiling" },
      { reason: "audience-prerequisites-missing" },
    ]);
    expect(projection?.schemaVersion === 2 && projection.unclassifiedLimitations).toEqual([
      "Direct outcome evidence is unavailable.",
    ]);
    const review = await projectReviewFindingsFromRetainedRun(record, value.store);
    expect(review).toMatchObject({
      availability: "partial",
      findings: [],
      limitations: [
        "review-findings-fact-inventory-unavailable:verify-technical-accuracy:missing-transport",
      ],
    });
  });

  it("lists an evaluator restatement of a review issue once, on the originating finding", async () => {
    // Shape of a live rc.14 review: the evaluator retained each editorial
    // REV-* issue as its own F-* finding that names the originating ID.
    const value = await fixture();
    const artifactCandidate = candidate(
      value.selection.profile,
      value.revision,
      restatingEvaluationFindings(),
    );
    artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
    const validated = await value.host.validate(
      validationInput(value, "quality-findings-restatement", artifactCandidate),
    );
    const record = validatedRunRecord(value, validated);
    record.steps.unshift({
      ...retainedUnsupportedStep("review-documentation"),
      summary: canonicalizeJsonEvidence(
        restatedEditorialReview() as unknown as JsonEvidenceValue,
      ).trim(),
    });

    const expected = [
      expect.objectContaining({
        id: "F-4",
        code: "F-4",
        summary: "The Usage page has no next step.",
      }),
      expect.objectContaining({
        id: "finding:review-documentation:REV-001:1",
        code: "REV-001",
        severity: "warning",
        path: "README.md",
        line: 3,
        summary: expect.stringMatching(/^The Install section contains only `widget --help`\./u),
        recommendation: expect.stringMatching(/^Provide an installation path/u),
        evidence:
          "README.md: README.md:3-5; evaluate-document-quality F-1: README.md:3-5: Install label and help command, as reported by independent editorial review.",
      }),
      expect.objectContaining({
        id: "finding:review-documentation:REV-002:2",
        code: "REV-002",
        path: "docs/usage.md",
        evidence: expect.stringContaining("; evaluate-document-quality F-2: docs/usage.md:1"),
      }),
      expect.objectContaining({
        id: "finding:review-documentation:REV-003:3",
        code: "REV-003",
        // The evaluator's stronger severity wins over the originating minor.
        severity: "warning",
        path: "docs/usage.md",
        evidence: expect.stringContaining("; evaluate-document-quality F-3: docs/usage.md:1"),
      }),
    ];

    const retained = await projectReviewFindingsFromRetainedRun(record, value.store);
    expect(retained.findings).toEqual(expected);
    expect(
      retained.limitations.filter((item) => item.startsWith("review-findings-duplicate")),
    ).toEqual([]);

    const live = structuredClone(record);
    live.steps.find((step) => step.id === "evaluate-document-quality")!.summary =
      canonicalizeJsonEvidence(artifactCandidate.evaluation as unknown as JsonEvidenceValue).trim();
    expect(projectReviewFindingsFromRun(live).findings).toEqual(expected);
    // Folding is safe to repeat: a second copy of the same evaluator result
    // (for example a re-run evaluator step) appends each trace once.
    const repeated = structuredClone(live);
    repeated.steps.push(
      structuredClone(repeated.steps.find((step) => step.id === "evaluate-document-quality")!),
    );
    const twice = projectReviewFindingsFromRun(repeated);
    expect(twice.findings).toEqual(expected);
    for (const finding of twice.findings) {
      expect(finding.evidence?.match(/evaluate-document-quality F-/gu)?.length ?? 0).toBeLessThan(
        2,
      );
    }
  });

  it("keeps an evaluator finding separate unless its named issues share one producer and path", async () => {
    const value = await fixture();
    const artifactCandidate = candidate(value.selection.profile, value.revision, [
      ...restatingEvaluationFindings().slice(0, 1),
      restatingEvaluationFinding(
        "F-5",
        "REV-001 and REV-002: neither page gives a usable task.",
        "README.md:3-5",
      ),
      restatingEvaluationFinding(
        "F-6",
        "REV-002 and TECH-001: the usage task and its command are both unverified.",
        "docs/usage.md:1",
      ),
    ]);
    artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
    const validated = await value.host.validate(
      validationInput(value, "quality-findings-restatement-scope", artifactCandidate),
    );
    const record = validatedRunRecord(value, validated);
    const canonical = (root: Record<string, unknown>) =>
      canonicalizeJsonEvidence(root as unknown as JsonEvidenceValue).trim();
    record.steps.unshift(
      {
        ...retainedUnsupportedStep("verify-technical-accuracy"),
        summary: canonical({
          verdict: "needs-revision",
          issues: [
            {
              id: "TECH-001",
              severity: "major",
              category: "technical_accuracy",
              location: "docs/usage.md:1",
              finding: "The usage page names no verified command.",
              evidence: { source_id: "docs/usage.md", locator: "docs/usage.md:1" },
              required_change: "Name a command confirmed by an approved source.",
            },
          ],
        }),
      },
      {
        ...retainedUnsupportedStep("review-documentation"),
        summary: canonical(restatedEditorialReview({ fullEvidence: true })),
      },
    );

    const projection = await projectReviewFindingsFromRetainedRun(record, value.store);
    const byId = new Map(projection.findings.map((finding) => [finding.id, finding]));
    // Both adjacent shapes stay listed: F-5 spans two files, F-6 two producers.
    expect(byId.get("F-5")).toMatchObject({ code: "F-5", path: "README.md" });
    expect(byId.get("F-6")).toMatchObject({ code: "F-6", path: "docs/usage.md" });
    expect(byId.get("finding:verify-technical-accuracy:TECH-001:1")).toMatchObject({
      code: "TECH-001",
    });
    expect(byId.get("finding:review-documentation:REV-002:2")?.evidence).toBe(
      "docs/usage.md: docs/usage.md:1",
    );
    // F-1 still folds when the originating evidence is nearly full: the
    // evaluator ID survives, and its evidence stays in the retained artifact.
    expect(byId.has("F-1")).toBe(false);
    const folded = byId.get("finding:review-documentation:REV-001:1")!.evidence!;
    expect(folded).toMatch(
      /; evaluate-document-quality F-1: evidence retained in the evaluation artifact$/u,
    );
    expect(folded.length).toBeLessThanOrEqual(512);
  });

  it("rejects schema-valid candidates that violate profile gate and confidence semantics", async () => {
    const value = await fixture();
    const gate = (value.selection.profile.hard_gates as readonly string[])[0]!;
    const layerId = Object.keys(
      (
        value.selection.profile.applicability as {
          documentation_set: { required_dimensions_by_layer: Record<string, string[]> };
        }
      ).documentation_set.required_dimensions_by_layer,
    )[0]!;

    const invalidCandidates = [
      () => {
        const artifact = candidate(value.selection.profile, value.revision);
        artifact.selectionSha256 = value.selection.receipt.selectionSha256;
        artifact.evaluation.overall_decision = "fail";
        artifact.evaluation.hard_gate_failures = [`${gate}: explanation`];
        return artifact;
      },
      () => {
        const artifact = candidate(value.selection.profile, value.revision);
        artifact.selectionSha256 = value.selection.receipt.selectionSha256;
        artifact.evaluation.overall_decision = "fail";
        const layer = (artifact.evaluation.layers as Record<string, Record<string, unknown>>)[
          layerId
        ];
        layer.decision = "fail";
        layer.hard_gate_failures = [gate];
        return artifact;
      },
      () => {
        const artifact = candidate(value.selection.profile, value.revision);
        artifact.selectionSha256 = value.selection.receipt.selectionSha256;
        const layer = (artifact.evaluation.layers as Record<string, Record<string, unknown>>)[
          layerId
        ];
        layer.confidence = 0.25;
        return artifact;
      },
    ];

    for (const makeCandidate of invalidCandidates) {
      const error = await value.host
        .validate(validationInput(value, "quality-semantic-rejection", makeCandidate()))
        .catch((candidateError: unknown) => candidateError);
      expect(error).toBeInstanceOf(QualityArtifactValidationError);
      expect((error as QualityArtifactValidationError).code).toBe("evaluation-invalid");
    }

    const wellFormed = candidate(value.selection.profile, value.revision);
    wellFormed.selectionSha256 = value.selection.receipt.selectionSha256;
    await expect(
      value.host.validate(validationInput(value, "quality-semantic-acceptance", wellFormed)),
    ).resolves.toMatchObject({ binding: { status: "passed" } });
  });

  it("recovers all retained evaluation findings for matching initial and replay results", async () => {
    const value = await fixture();
    const artifactCandidate = candidate(
      value.selection.profile,
      value.revision,
      retainedEvaluationFindings(),
    );
    artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
    const validated = await value.host.validate(
      validationInput(value, "quality-findings-recovery", artifactCandidate),
    );
    const record = validatedRunRecord(value, validated);
    record.steps.unshift(
      retainedUnsupportedStep("lint-documentation"),
      retainedUnsupportedStep("verify-technical-accuracy"),
      retainedUnsupportedStep("review-documentation"),
    );
    for (const step of record.steps) {
      step.tools = {
        totalCalls: 1,
        failedCalls: 0,
        byTool: [{ name: "read", calls: 1, failures: 0 }],
        presented: ["find", "grep", "ls", "read"],
      };
    }

    const projection = await projectReviewFindingsFromRetainedRun(record, value.store);
    expect(projection.findings.map((finding) => finding.id)).toEqual([
      "DQ-001",
      "DQ-002",
      "DQ-003",
      "DQ-004",
      "DQ-005",
      "DQ-006",
    ]);
    expect(projection.findings.some((finding) => finding.code === "TECH-999")).toBe(false);
    expect(projection.findings[0]).toMatchObject({
      code: "DQ-001",
      path: "README.md",
      line: 28,
      evidence: expect.stringContaining("README.md:28-75; package.json:2-3; src/index.ts:1-7"),
    });
    expect(projection.findings[5]).toMatchObject({
      code: "DQ-006",
      path: null,
      evidence: expect.stringContaining("Consumer Guide"),
    });
    expect(projection).toMatchObject({
      availability: "partial",
      projector: "docsfab-review-findings-v2",
      artifactLocator: `record:sha256:${validated.binding.artifacts.evaluation!.recordSha256}`,
    });
    expect(projection.limitations).toEqual(
      expect.arrayContaining([
        "review-findings-unparsed:lint-documentation",
        "review-findings-unparsed:verify-technical-accuracy",
        "review-findings-unparsed:review-documentation",
        "review-finding-location-partial:DQ-001",
        "review-finding-location-unavailable:DQ-006",
      ]),
    );
    expect(projection.limitations).not.toContain(
      "review-findings-unparsed:evaluate-document-quality",
    );
    expect(projection.limitations).toContain("review-findings-invalid:evaluate-document-quality:3");
    const trusted = await loadVerifiedReviewEvaluationArtifact(record, value.store);
    expect(trusted).toMatchObject({
      runId: record.id,
      repositoryRevision: record.repository.revision,
      profile: { id: "docsfab-documentation-quality", version: "v0.1" },
    });
    const trustedIds = (trusted.payload.findings as Array<{ id: string }>).map(
      (finding) => finding.id,
    );
    expect(trustedIds).toHaveLength(9);
    expect(trustedIds.slice(0, 6)).toEqual(projection.findings.map((finding) => finding.id));
    const presentation = await loadReviewPresentation(record, value.store);
    expect(presentation.evidence).toEqual({
      reviewMethod: "static-read-only",
      packageChecks: "not-executed",
      artifactValidators: "passed",
      audience: { human: "unavailable", agent: "unavailable" },
    });
    const withoutTechnicalTransport = structuredClone(record);
    withoutTechnicalTransport.steps = withoutTechnicalTransport.steps.filter(
      (step) => step.id !== "verify-technical-accuracy",
    );
    const missingTransport = await projectReviewFindingsFromRetainedRun(
      withoutTechnicalTransport,
      value.store,
    );
    expect(missingTransport.availability).toBe("partial");
    expect(missingTransport.limitations).toContain(
      "review-findings-fact-inventory-unavailable:verify-technical-accuracy:missing-transport",
    );
    const noncanonicalCurrent = structuredClone(record);
    noncanonicalCurrent.steps.find((step) => step.id === "verify-technical-accuracy")!.summary =
      JSON.stringify(technicalVerification(), null, 2);
    expect(
      (await projectReviewFindingsFromRetainedRun(noncanonicalCurrent, value.store)).limitations,
    ).toContain(
      "review-findings-artifact-invalid:evaluate-document-quality:technical-trace-incomplete",
    );
    const malformedCurrent = structuredClone(record);
    const incomplete = technicalVerification();
    incomplete.factInventory.dimensions.pop();
    malformedCurrent.steps.find((step) => step.id === "verify-technical-accuracy")!.summary =
      canonicalizeJsonEvidence(incomplete as unknown as JsonEvidenceValue).trimEnd();
    expect(
      (await projectReviewFindingsFromRetainedRun(malformedCurrent, value.store)).limitations,
    ).toContain(
      "review-findings-artifact-invalid:evaluate-document-quality:technical-trace-incomplete",
    );
    const unavailableCurrent = structuredClone(record);
    unavailableCurrent.steps.find((step) => step.id === "verify-technical-accuracy")!.summary =
      canonicalizeJsonEvidence(technicalVerification() as unknown as JsonEvidenceValue).trimEnd();
    stagedSchemaState.reviewUnavailable = true;
    const schemaUnavailable = await projectReviewFindingsFromRetainedRun(
      unavailableCurrent,
      value.store,
    );
    stagedSchemaState.reviewUnavailable = false;
    expect(schemaUnavailable.availability).toBe("unavailable");
    expect(schemaUnavailable.limitations).toContain(
      "review-findings-artifact-unavailable:evaluate-document-quality:schema-unavailable",
    );
    const failedWriteStage = structuredClone(record);
    failedWriteStage.steps.push({
      id: "review-documentation",
      title: "Failed write-capable review",
      kind: "evaluate",
      skill: "review-documentation",
      mode: "write",
      status: "failed",
      tools: {
        totalCalls: 1,
        failedCalls: 1,
        byTool: [{ name: "write", calls: 1, failures: 1 }],
        presented: ["write"],
      },
    });
    expect((await loadReviewPresentation(failedWriteStage, value.store)).evidence).toMatchObject({
      reviewMethod: "not-established",
      packageChecks: "not-established",
    });
    const falseCanonTool = structuredClone(record);
    falseCanonTool.steps[0]!.tools = {
      totalCalls: 1,
      failedCalls: 0,
      byTool: [{ name: "canon_publish", calls: 1, failures: 0 }],
      presented: ["canon_publish"],
    };
    expect((await loadReviewPresentation(falseCanonTool, value.store)).evidence).toMatchObject({
      reviewMethod: "not-established",
      packageChecks: "not-established",
    });
    for (const nativeStatus of ["passed", "failed", "unavailable"] as const) {
      const nativeLint = structuredClone(record);
      nativeLint.steps[0] = {
        ...nativeLint.steps[0]!,
        id: "lint-documentation",
        title: "Run deterministic documentation checks",
        skill: "lint-documentation",
        kind: "host-operation",
        summary: JSON.stringify({ status: nativeStatus, checks: [] }),
        tools: { totalCalls: 0, failedCalls: 0, byTool: [], failureCategories: [] },
      };
      expect((await loadReviewPresentation(nativeLint, value.store)).evidence).toMatchObject({
        reviewMethod: "not-established",
        packageChecks: "not-established",
      });
      expect(nativeLint.steps[0]!.summary).toBe(
        JSON.stringify({ status: nativeStatus, checks: [] }),
      );
    }

    const stateDirectory = join(value.root, "runs");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(stateDirectory, `${record.id}.json`), `${JSON.stringify(record)}\n`, {
      mode: 0o600,
    });
    const initialOutput: string[] = [];
    await deliverCliRunResult(
      {
        request: {
          workflow: "review-documentation",
          repositoryPath: record.repository.sourcePath,
          revision: record.repository.revision,
          allowWrite: false,
          releaseGate: false,
          verbose: false,
        },
        config: { stateDirectory },
        options: { json: true },
        output: {
          log: (line: string) => initialOutput.push(line),
          error: (line: string) => initialOutput.push(line),
        },
      } as unknown as Parameters<typeof deliverCliRunResult>[0],
      {} as never,
      {} as never,
      { record, exitCode: 0 },
    );
    const initial = decodeRunResultV1(parseJsonEvidence(initialOutput.at(-1)!));
    const replayOutput: string[] = [];
    const consoleLog = vi.spyOn(console, "log").mockImplementation((line) => {
      replayOutput.push(String(line));
    });
    try {
      await handleRunsCommand(["show", record.id, "--json", "--state-dir", stateDirectory]);
    } finally {
      consoleLog.mockRestore();
    }
    const replay = decodeRunResultV1(parseJsonEvidence(replayOutput.at(-1)!));
    expect(replay.resultSha256).toBe(initial.resultSha256);
    expect(replay.reviewFindings).toEqual(initial.reviewFindings);
    expect(replay.reviewFindingsProjection).toEqual(initial.reviewFindingsProjection);
    expect(replay.nextSteps).toEqual(initial.nextSteps);
    expect(replay.product.limitations).toEqual(
      expect.arrayContaining([
        "review-method-static-read-only",
        "package-command-checks-not-executed",
        "human-audience-evidence-unavailable",
        "agent-audience-evidence-unavailable",
      ]),
    );
    expect(replay.nextSteps.join(" ")).toContain("separate write grant");
  });

  it("retains admitted human-review and unverified coverage through artifact recovery", async () => {
    const value = await fixture();
    const artifactCandidate = candidate(value.selection.profile, value.revision);
    artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
    const validated = await value.host.validate(
      validationInput(value, "quality-findings-human-review", artifactCandidate),
    );
    const record = validatedRunRecord(value, validated);
    record.reviewScope = {
      scope: "focused-set",
      reason: "operator-named",
      targetPaths: ["docs/guide.md"],
      deferredPaths: [],
      scopeSha256: "f".repeat(64),
      corpusFileCount: 1,
    };
    record.steps.unshift(
      {
        id: "verify-technical-accuracy",
        title: "Verify technical accuracy",
        kind: "evaluate",
        skill: "verify-technical-accuracy",
        mode: "read-only",
        status: "succeeded",
        summary: canonicalizeJsonEvidence({
          coverage: [
            {
              evidence: [],
              path: "docs/guide.md",
              reason: "The required implementation source was unavailable.",
              status: "unverified",
            },
          ],
          review: { issues: [], verdict: "human-review" },
        }),
      },
      {
        id: "review-documentation",
        title: "Review documentation",
        kind: "evaluate",
        skill: "review-documentation",
        mode: "read-only",
        status: "succeeded",
        summary: canonicalizeJsonEvidence({ issues: [], verdict: "human-review" }),
      },
    );

    const projection = await projectReviewFindingsFromRetainedRun(record, value.store);
    expect(projection).toMatchObject({ availability: "partial", findings: [] });
    expect(projection.limitations).toEqual(
      expect.arrayContaining([
        "review-findings-human-review:verify-technical-accuracy",
        "review-findings-coverage-unverified:verify-technical-accuracy:docs/guide.md",
        "review-findings-human-review:review-documentation",
      ]),
    );
    const nextSteps = collectRunResultNextSteps({
      record,
      recordPath: "/private/state/quality-findings-human-review.json",
      exitCode: 0,
      repositoryPath: value.sourcePath,
      reviewFindingsProjection: projection,
    }).join(" ");
    expect(nextSteps).toContain("empty count does not establish zero defects");
    expect(nextSteps).not.toContain("supported findings projection is empty");
  });

  it("keeps schema-valid audience success claims distinct from admitted audience evidence", async () => {
    const value = await fixture();
    const artifactCandidate = candidate(value.selection.profile, value.revision);
    const claimedOutcome = {
      population_id: "fixture-developers",
      task_or_scenario_id: "fixture-task",
      attempt_id: "attempt-1",
      outcome: "success",
      verified: true,
      evidence: [
        {
          evidence_class: "outcome-evaluation",
          strength: "direct",
          population: "human",
          provider_id: "model-claimed-provider",
          task_or_scenario_id: "fixture-task",
          locator: "fixture:claimed-outcome",
          description: "The evaluator claims an outcome without a separate host receipt.",
        },
      ],
      measures: [],
      limitations: [],
    };
    artifactCandidate.evaluation.outcomes = {
      human: [claimedOutcome],
      agent: [
        {
          ...claimedOutcome,
          population_id: "fixture-agents",
          attempt_id: "attempt-2",
          evidence: [{ ...claimedOutcome.evidence[0], population: "agent" }],
        },
      ],
    };
    artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
    const validated = await value.host.validate(
      validationInput(value, "quality-findings-audience-claims", artifactCandidate),
    );
    const record = validatedRunRecord(value, validated);

    const presentation = await loadReviewPresentation(record, value.store);
    expect(presentation.evidence?.audience).toEqual({
      human: "model-claimed-only",
      agent: "model-claimed-only",
    });
  });

  it("does not turn schema-valid unsafe findings into a complete zero", async () => {
    const value = await fixture();
    const artifactCandidate = candidate(
      value.selection.profile,
      value.revision,
      retainedEvaluationFindings().slice(-3),
    );
    artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
    const validated = await value.host.validate(
      validationInput(value, "quality-findings-unsafe", artifactCandidate),
    );
    const record = validatedRunRecord(value, validated);

    const projection = await projectReviewFindingsFromRetainedRun(record, value.store);
    expect(projection).toMatchObject({
      availability: "invalid",
      findings: [],
      limitations: [
        "review-findings-fact-inventory-unavailable:verify-technical-accuracy:missing-transport",
        "review-findings-invalid:evaluate-document-quality:3",
      ],
    });
  });

  it("rejects absent, stale, wrong-run, wrong-profile, and tampered retained evaluation artifacts", async () => {
    const value = await fixture();
    const artifactCandidate = candidate(
      value.selection.profile,
      value.revision,
      retainedEvaluationFindings(),
    );
    artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
    const validated = await value.host.validate(
      validationInput(value, "quality-findings-negative", artifactCandidate),
    );
    const record = validatedRunRecord(value, validated);
    const missingRoot = join(value.root, "missing-artifacts");
    const absent = await projectReviewFindingsFromRetainedRun(
      record,
      new DurableArtifactStore(missingRoot),
    );
    expect(absent).toMatchObject({ availability: "unavailable", findings: [] });
    await expect(lstat(missingRoot)).rejects.toMatchObject({ code: "ENOENT" });

    const missingBinding = structuredClone(record);
    delete missingBinding.qualityArtifactValidation;
    expect(await projectReviewFindingsFromRetainedRun(missingBinding, value.store)).toMatchObject({
      availability: "unavailable",
      findings: [],
      limitations: ["review-findings-artifact-unavailable:evaluate-document-quality:no-binding"],
    });
    const malformedBinding = structuredClone(record);
    malformedBinding.qualityArtifactValidation = {
      ...malformedBinding.qualityArtifactValidation!,
      bindingSha256: "0".repeat(64),
    };
    expect(await projectReviewFindingsFromRetainedRun(malformedBinding, value.store)).toMatchObject(
      {
        availability: "invalid",
        findings: [],
        limitations: ["review-findings-artifact-invalid:evaluate-document-quality:binding"],
      },
    );

    for (const mutate of [
      (copy: RunRecord) => {
        copy.id = "wrong-run";
      },
      (copy: RunRecord) => {
        copy.repository.revision = "f".repeat(40);
      },
      (copy: RunRecord) => {
        copy.qualityProfileSelection = {
          ...copy.qualityProfileSelection!,
          profileVersion: "v0.2" as "v0.1",
        };
      },
    ]) {
      const copy = structuredClone(record);
      mutate(copy);
      const rejected = await projectReviewFindingsFromRetainedRun(copy, value.store);
      expect(rejected).toMatchObject({ availability: "invalid", findings: [] });
      expect(rejected.limitations).toContain(
        "review-findings-artifact-invalid:evaluate-document-quality:binding",
      );
    }

    const evaluationDigest = validated.binding.artifacts.evaluation!.recordSha256;
    await writeFile(
      join(value.store.root, "objects", "sha256", `${evaluationDigest}.json`),
      '{"tampered":true}\n',
      { mode: 0o600 },
    );
    const tampered = await projectReviewFindingsFromRetainedRun(record, value.store);
    expect(tampered).toMatchObject({ availability: "invalid", findings: [] });
    expect(tampered.limitations).toContain(
      "review-findings-artifact-invalid:evaluate-document-quality:binding",
    );
    expect(record.steps.at(-1)?.summary).toBe(validated.reportMarkdown);
  });

  it("retains evaluator Markdown and failed receipts after semantic validation failure", async () => {
    const value = await fixture();
    const artifactCandidate = candidate(value.selection.profile, value.revision);
    artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
    artifactCandidate.evaluation.overall_decision = "pass";

    const error = await value.host
      .validate(validationInput(value, "quality-failure", artifactCandidate))
      .catch((candidateError: unknown) => candidateError);
    expect(error).toBeInstanceOf(QualityArtifactValidationError);
    expect((error as QualityArtifactValidationError).code).toBe("evaluation-invalid");
    // The locked validator's first issue as a closed code and location, with
    // the issue count; no validator or evaluator text.
    expect((error as QualityArtifactValidationError).rejection).toEqual({
      validator: "evaluation",
      code: "experimental-profile-not-release-gate",
      location: "$.overall_decision",
      issueCount: 8,
    });
    expect((error as QualityArtifactValidationError).binding.status).toBe("failed");
    expect((error as QualityArtifactValidationError).reportMarkdown).toBe(
      artifactCandidate.reportMarkdown,
    );
  });

  it("keeps the evaluator's single statement of a host limitation (#1239)", async () => {
    // The evaluator decided `fail` and listed both profile limitations word for
    // word. On `fail` the host owns only the audience-baseline row, and
    // appending it a second time would be refused at finalization as
    // report-limitation-duplicate.
    const value = await fixture();
    const artifactCandidate = candidate(value.selection.profile, value.revision);
    artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
    artifactCandidate.evaluation.overall_decision = "fail";
    artifactCandidate.evaluation.hard_gate_failures = ["unsupported-critical-claim"];
    const layers = artifactCandidate.evaluation.layers as Record<string, Record<string, unknown>>;
    const firstLayer = Object.values(layers)[0]!;
    firstLayer.decision = "fail";
    firstLayer.hard_gate_failures = ["unsupported-critical-claim"];
    artifactCandidate.reportMarkdown += [
      "",
      `- Limitation: ${PROFILE_CEILING_LIMITATION}`,
      `- Limitation: ${AUDIENCE_PREREQUISITES_LIMITATION}`,
    ].join("\n");

    const validated = await value.host.validate(
      validationInput(value, "quality-report-host-limitation", artifactCandidate),
    );
    expect(validated.binding.status).toBe("passed");
    expect(validated.binding.validators.reportBinding).toMatchObject({ outcome: "passed" });
    const summary = validatedSummary(validated.reportMarkdown);
    // The evaluator's statements are kept once; the host adds nothing it already lists.
    expect(summary.limitations).toEqual([
      "Direct outcome evidence is unavailable.",
      PROFILE_CEILING_LIMITATION,
      AUDIENCE_PREREQUISITES_LIMITATION,
    ]);
    expect(summary.retained_gap_evidence.map((entry) => entry.limitation)).toEqual([
      AUDIENCE_PREREQUISITES_LIMITATION,
    ]);

    const harness: AgentHarness = {
      runStep: async (input) =>
        input.step.skill === "evaluate-document-quality"
          ? {
              summary: artifactCandidate.reportMarkdown,
              qualityArtifactCandidate: artifactCandidate,
              skill: { id: input.step.skill, contentSha256: "f".repeat(64) },
            }
          : {
              summary: `${input.step.skill} completed`,
              ...(await verificationFixture(input)),
            },
    };
    const record = await new WorkflowRunner({
      harness,
      hostOperations: { runStep: (input) => harness.runStep(input) },
      store: new MemoryStore(),
      ...qualityRunnerOptions(value),
      id: () => "quality-report-host-limitation-runner",
    }).run(reviewRunRequest(value));
    expect(record.status).toBe("succeeded");
    expect(record.qualityArtifactValidation?.status).toBe("passed");
    expect(record.steps.at(-1)?.qualityValidationRejection).toBeUndefined();
  });

  it("appends a host limitation the evaluator did not state verbatim (#1239)", async () => {
    const value = await fixture(true);
    const [discoveryLimitation] = value.selection.discoveryLimitations!;
    expect(discoveryLimitation).toBeDefined();
    const nearMiss = PROFILE_CEILING_LIMITATION.slice(0, -1);
    const artifactCandidate = candidate(value.selection.profile, value.revision);
    artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
    // The same audience limitation under another accepted row prefix is one
    // limitation; a near miss of the ceiling limitation is not.
    artifactCandidate.reportMarkdown += [
      "",
      `- Limitation: ${nearMiss}`,
      `- **Evidence gap:** ${AUDIENCE_PREREQUISITES_LIMITATION}`,
    ].join("\n");

    const validated = await value.host.validate(
      validationInput(value, "quality-report-distinct-host-limitation", artifactCandidate),
    );
    expect(validated.binding.status).toBe("passed");
    expect(validatedSummary(validated.reportMarkdown).limitations).toEqual([
      discoveryLimitation,
      PROFILE_CEILING_LIMITATION,
      "Direct outcome evidence is unavailable.",
      nearMiss,
      AUDIENCE_PREREQUISITES_LIMITATION,
    ]);
  });

  it("appends a host limitation the evaluator mentions only outside the section (#1239)", async () => {
    const value = await fixture(true);
    const [discoveryLimitation] = value.selection.discoveryLimitations!;
    const artifactCandidate = candidate(value.selection.profile, value.revision);
    artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
    // Prose elsewhere in the report is not a limitation row.
    artifactCandidate.reportMarkdown = artifactCandidate.reportMarkdown.replace(
      "## Evidence gaps and limitations",
      `## Scope\n\n${discoveryLimitation}\n\n## Evidence gaps and limitations`,
    );

    const validated = await value.host.validate(
      validationInput(value, "quality-report-prose-host-limitation", artifactCandidate),
    );
    expect(validated.binding.status).toBe("passed");
    expect(validatedSummary(validated.reportMarkdown).limitations).toEqual([
      discoveryLimitation,
      PROFILE_CEILING_LIMITATION,
      AUDIENCE_PREREQUISITES_LIMITATION,
      "Direct outcome evidence is unavailable.",
    ]);
  });

  it("keeps the evaluator's restatement of the discovery limitation once (#1239)", async () => {
    // The host passes the discovery limitation to the evaluator verbatim in its
    // prompt, so it is the likeliest restatement.
    const value = await fixture(true);
    const [discoveryLimitation] = value.selection.discoveryLimitations!;
    const artifactCandidate = candidate(value.selection.profile, value.revision);
    artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
    artifactCandidate.reportMarkdown += `\n- Evidence gap: ${discoveryLimitation}`;

    const validated = await value.host.validate(
      validationInput(value, "quality-report-restated-discovery", artifactCandidate),
    );
    expect(validated.binding.status).toBe("passed");
    expect(validatedSummary(validated.reportMarkdown).limitations).toEqual([
      PROFILE_CEILING_LIMITATION,
      AUDIENCE_PREREQUISITES_LIMITATION,
      "Direct outcome evidence is unavailable.",
      discoveryLimitation,
    ]);
  });

  it("codes an evaluator report that repeats its own limitation (#1237)", async () => {
    // The final report validator's uniqueness rule still applies to the
    // evaluator's own rows; only host-owned rows are deduplicated.
    const value = await fixture();
    const artifactCandidate = candidate(value.selection.profile, value.revision);
    artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
    artifactCandidate.reportMarkdown += "\n- Evidence gap: Direct outcome evidence is unavailable.";
    const expected = {
      validator: "report-finalization",
      code: "report-limitation-duplicate",
      location: "$.limitations",
      issueCount: 1,
    };

    const error = await value.host
      .validate(validationInput(value, "quality-report-finalization", artifactCandidate))
      .catch((candidateError: unknown) => candidateError);
    expect(error).toBeInstanceOf(QualityArtifactValidationError);
    expect((error as QualityArtifactValidationError).code).toBe("report-binding-invalid");
    expect((error as QualityArtifactValidationError).rejection).toEqual(expected);
    // The evaluation validator passed and the report validator never ran.
    expect((error as QualityArtifactValidationError).binding.validators).toMatchObject({
      evaluation: { outcome: "passed" },
      reportBinding: null,
    });

    const harness: AgentHarness = {
      runStep: async (input) =>
        input.step.skill === "evaluate-document-quality"
          ? {
              summary: artifactCandidate.reportMarkdown,
              qualityArtifactCandidate: artifactCandidate,
              skill: { id: input.step.skill, contentSha256: "f".repeat(64) },
            }
          : {
              summary: `${input.step.skill} completed`,
              ...(await verificationFixture(input)),
            },
    };
    const record = await new WorkflowRunner({
      harness,
      hostOperations: { runStep: (input) => harness.runStep(input) },
      store: new MemoryStore(),
      ...qualityRunnerOptions(value),
      id: () => "quality-report-finalization-runner",
    }).run(reviewRunRequest(value));
    const step = record.steps.at(-1)!;
    // A model-content refusal with no retry budget configured is already the
    // step's final attempt, so the host declines the artifact instead of
    // failing the review; the rejection code is still recorded and still
    // reads the same through every existing consumer below.
    expect(record.error).toBeUndefined();
    expect(step).toMatchObject({
      status: "succeeded",
      qualityValidationRejection: expected,
    });
    expect(formatStepRejectionSentence(step)).toBe(
      "Rejected by report-limitation-duplicate at $.limitations (1 quality validator issue).",
    );
    // The run index carries the code on the step row.
    const projection = projectRunIndexRows(record, {
      origin: "import",
      snapshotId: "snapshot-1237",
      indexedAt: "2026-09-23T12:00:00.000Z",
      recordSha256: "a".repeat(64),
      fieldMaxChars: 512,
    });
    // The code is model-correctable and no retry budget is configured here,
    // so the step declines on its first attempt. The declining attempt's own
    // retained evidence honestly says `outcome: "succeeded"` with no
    // rejection fields (see "declines the artifact..." above), so the
    // `rejectionSource !== null` filter below drops its attempt-level row;
    // only the step-level row projects, carrying the same code (named scope
    // debt in the MR body).
    expect(projection.ok && projection.rows.filter((row) => row.rejectionSource !== null)).toEqual([
      expect.objectContaining({
        stepId: step.id,
        rowKind: "step",
        rejectionSource: "quality-validation",
        rejectionCode: "report-limitation-duplicate",
        rejectionLocation: "$.limitations",
      }),
    ]);
    expect(QUALITY_CHECK_REJECTION_CODES).toContain(expected.code);
  });

  it("records a precise failed binding when candidate selection is substituted", async () => {
    const value = await fixture();
    const artifactCandidate = candidate(value.selection.profile, value.revision);
    artifactCandidate.selectionSha256 = "9".repeat(64);

    const error = await value.host
      .validate(validationInput(value, "quality-candidate-substitution", artifactCandidate))
      .catch((candidateError: unknown) => candidateError);

    expect(error).toBeInstanceOf(QualityArtifactValidationError);
    expect((error as QualityArtifactValidationError).code).toBe("candidate-invalid");
    expect((error as QualityArtifactValidationError).rejection).toEqual({
      validator: "candidate-staging",
      code: "candidate-selection-mismatch",
      location: "$.selectionSha256",
      issueCount: 1,
    });
    expect((error as QualityArtifactValidationError).binding).toMatchObject({
      status: "failed",
      artifacts: {
        evaluation: null,
        qualityScore: null,
        candidateReport: null,
        finalReport: null,
      },
    });
    expect((error as QualityArtifactValidationError).reportMarkdown).toBe(
      artifactCandidate.reportMarkdown,
    );
  });

  it("rejects credential-bearing candidates before persistence or runner retention", async () => {
    const value = await fixture();
    const credential = `glpat-${"x".repeat(24)}`;
    const artifactCandidate = candidate(value.selection.profile, value.revision);
    artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
    artifactCandidate.reportMarkdown += `\n\n${credential}`;

    const directError = await value.host
      .validate(validationInput(value, "quality-credential-rejection", artifactCandidate))
      .catch((candidateError: unknown) => candidateError);
    expect(directError).toBeInstanceOf(QualityArtifactValidationError);
    expect((directError as QualityArtifactValidationError).code).toBe("candidate-invalid");
    expect((directError as QualityArtifactValidationError).rejection).toMatchObject({
      validator: "candidate-staging",
      code: "candidate-credential-material",
    });
    expect((directError as QualityArtifactValidationError).reportMarkdown).toBe("");
    expect((directError as QualityArtifactValidationError).binding).toMatchObject({
      status: "failed",
      failureCode: "candidate-invalid",
      artifacts: {
        evaluation: null,
        qualityScore: null,
        candidateReport: null,
        finalReport: null,
      },
      validators: {
        evaluation: null,
        qualityScore: null,
        reportBinding: null,
      },
    });
    expect(await retainedArtifactText(join(value.root, "artifacts"))).not.toContain(credential);

    const failedStorePath = join(value.root, "artifact-store-is-a-file");
    await writeFile(failedStorePath, "store initialization must fail\n");
    const failedStoreHost = new QualityValidatorHost({
      store: new DurableArtifactStore(failedStorePath),
      selection: value.selection,
      temporaryRoot: join(value.root, "failed-store-validator-tmp"),
      stateDirectory: value.stateDirectory,
    });
    const harness: AgentHarness = {
      runStep: async (input) => {
        if (input.step.skill === "evaluate-document-quality") {
          input.onText?.(artifactCandidate.reportMarkdown);
          return {
            summary: artifactCandidate.reportMarkdown,
            qualityArtifactCandidate: artifactCandidate,
            skill: { id: input.step.skill, contentSha256: "f".repeat(64) },
          };
        }
        return { summary: `${input.step.skill} completed`, ...(await verificationFixture(input)) };
      },
    };
    const runStore = new MemoryStore();
    const streamed: string[] = [];
    const runner = new WorkflowRunner({
      harness,
      hostOperations: { runStep: (input) => harness.runStep(input) },
      store: runStore,
      ...qualityRunnerOptions(value, failedStoreHost),
      id: () => "quality-credential-runner-rejection",
      onProgress: (event) => {
        if (event.type === "text") streamed.push(event.text);
      },
    });
    const record = await runner.run(reviewRunRequest(value));
    expect(record).toMatchObject({
      status: "failed",
      qualityArtifactValidation: {
        status: "failed",
        failureCode: "artifact-integrity-invalid",
        artifacts: {
          evaluation: null,
          qualityScore: null,
          candidateReport: null,
          finalReport: null,
        },
        validators: {
          evaluation: null,
          qualityScore: null,
          reportBinding: null,
        },
      },
      steps: expect.arrayContaining([
        expect.objectContaining({
          skill: "evaluate-document-quality",
          status: "failed",
        }),
      ]),
    });
    expect(JSON.stringify(record)).not.toContain(credential);
    expect(JSON.stringify(runStore.records)).not.toContain(credential);
    expect(streamed.join("\n")).not.toContain(credential);
  });

  it("retains safe Markdown when failed-binding persistence is unavailable", async () => {
    const value = await fixture();
    const artifactCandidate = candidate(value.selection.profile, value.revision);
    artifactCandidate.selectionSha256 = "9".repeat(64);
    const failedStorePath = join(value.root, "safe-artifact-store-is-a-file");
    await writeFile(failedStorePath, "store initialization must fail\n");
    const failedStoreHost = new QualityValidatorHost({
      store: new DurableArtifactStore(failedStorePath),
      selection: value.selection,
      temporaryRoot: join(value.root, "safe-failed-store-validator-tmp"),
      stateDirectory: value.stateDirectory,
    });

    const directError = await failedStoreHost
      .validate(validationInput(value, "quality-safe-failed-store", artifactCandidate))
      .catch((candidateError: unknown) => candidateError);
    expect(directError).toBeInstanceOf(QualityArtifactValidationError);
    expect((directError as QualityArtifactValidationError).code).toBe("artifact-integrity-invalid");
    // The candidate was refused, but the binding naming why could not be stored.
    expect((directError as QualityArtifactValidationError).rejection).toEqual({
      validator: "binding-storage",
      code: "validation-binding-unstored",
      location: "$",
      issueCount: 1,
    });
    expect((directError as QualityArtifactValidationError).reportMarkdown).toBe(
      artifactCandidate.reportMarkdown,
    );
    expect((directError as QualityArtifactValidationError).binding).toMatchObject({
      status: "failed",
      failureCode: "artifact-integrity-invalid",
      artifacts: {
        evaluation: null,
        qualityScore: null,
        candidateReport: null,
        finalReport: null,
      },
      validators: {
        evaluation: null,
        qualityScore: null,
        reportBinding: null,
      },
    });

    const harness: AgentHarness = {
      runStep: async (input) => {
        if (input.step.skill === "evaluate-document-quality") {
          input.onText?.(artifactCandidate.reportMarkdown);
          return {
            summary: artifactCandidate.reportMarkdown,
            qualityArtifactCandidate: artifactCandidate,
            skill: { id: input.step.skill, contentSha256: "f".repeat(64) },
          };
        }
        return { summary: `${input.step.skill} completed`, ...(await verificationFixture(input)) };
      },
    };
    const runStore = new MemoryStore();
    const streamed: string[] = [];
    const runner = new WorkflowRunner({
      harness,
      hostOperations: { runStep: (input) => harness.runStep(input) },
      store: runStore,
      ...qualityRunnerOptions(value, failedStoreHost),
      id: () => "quality-safe-failed-store-runner",
      onProgress: (event) => {
        if (event.type === "text") streamed.push(event.text);
      },
    });
    const record = await runner.run(reviewRunRequest(value));

    expect(record).toMatchObject({
      status: "failed",
      qualityArtifactValidation: {
        status: "failed",
        failureCode: "artifact-integrity-invalid",
        artifacts: {
          evaluation: null,
          qualityScore: null,
          candidateReport: null,
          finalReport: null,
        },
        validators: {
          evaluation: null,
          qualityScore: null,
          reportBinding: null,
        },
      },
      steps: expect.arrayContaining([
        expect.objectContaining({
          skill: "evaluate-document-quality",
          status: "failed",
          summary: artifactCandidate.reportMarkdown,
        }),
      ]),
    });
    expect(runStore.records.at(-1)?.steps.at(-1)?.summary).toBe(artifactCandidate.reportMarkdown);
    expect(streamed).toContain(artifactCandidate.reportMarkdown);
  });

  it("validates and projects an explicitly selected scored artifact", async () => {
    const value = await fixture();
    const artifactCandidate = candidate(value.selection.profile, value.revision);
    artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
    artifactCandidate.qualityScore = qualityScore();

    const validated = await value.host.validate(
      validationInput(value, "quality-scored", artifactCandidate),
    );

    expect(validated.binding.validators.qualityScore?.receiptSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      projectQualityReportFromRun(
        runRecord(
          value.selection.receipt,
          validated.binding,
          validated.reportMarkdown,
          value.sourcePath,
        ),
      ),
    ).toMatchObject({
      rubric: {
        status: "available",
        id: "task-guide-v0.1",
        total: 0,
        threshold: 90,
      },
    });
  });

  it("preserves a validated hard-gate failure as fail without a score", async () => {
    const value = await fixture();
    const artifactCandidate = candidate(value.selection.profile, value.revision);
    artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
    artifactCandidate.evaluation.overall_decision = "fail";
    artifactCandidate.evaluation.hard_gate_failures = ["unsupported-critical-claim"];
    const layers = artifactCandidate.evaluation.layers as Record<string, Record<string, unknown>>;
    const firstLayer = Object.values(layers)[0]!;
    firstLayer.decision = "fail";
    firstLayer.hard_gate_failures = ["unsupported-critical-claim"];

    const validated = await value.host.validate(
      validationInput(value, "quality-hard-gate", artifactCandidate),
    );

    expect(
      projectQualityReportFromRun(
        runRecord(
          value.selection.receipt,
          validated.binding,
          validated.reportMarkdown,
          value.sourcePath,
        ),
      ),
    ).toMatchObject({
      decision: "fail",
      hardGateFailures: ["unsupported-critical-claim"],
      rubric: { status: "unavailable" },
    });
  });

  it("retains evaluator Markdown when the selected score fails exact validation", async () => {
    const value = await fixture();
    const artifactCandidate = candidate(value.selection.profile, value.revision);
    artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
    artifactCandidate.qualityScore = { ...qualityScore(), total: 1 };

    const error = await value.host
      .validate(validationInput(value, "quality-score-failure", artifactCandidate))
      .catch((candidateError: unknown) => candidateError);

    expect(error).toBeInstanceOf(QualityArtifactValidationError);
    expect((error as QualityArtifactValidationError).code).toBe("quality-score-invalid");
    expect((error as QualityArtifactValidationError).rejection).toEqual({
      validator: "quality-score",
      code: "score-total-sum-mismatch",
      location: "$.total",
      issueCount: 1,
    });
    expect((error as QualityArtifactValidationError).binding.status).toBe("failed");
    expect((error as QualityArtifactValidationError).reportMarkdown).toBe(
      artifactCandidate.reportMarkdown,
    );
  });

  it("replays the same candidate without changing its immutable artifact bindings", async () => {
    const value = await fixture();
    const artifactCandidate = candidate(value.selection.profile, value.revision);
    artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
    const input = validationInput(value, "quality-replay", artifactCandidate);

    const first = await value.host.validate(input);
    const replay = await value.host.validate(input);

    expect(replay.reportMarkdown).toBe(first.reportMarkdown);
    expect(replay.binding.artifacts).toEqual(first.binding.artifacts);
    expect(replay.binding.selectionSha256).toBe(first.binding.selectionSha256);
    expect(replay.binding.repositoryRevision).toBe(first.binding.repositoryRevision);
    expect(replay.binding.validators.evaluation?.receiptSha256).not.toBe(
      first.binding.validators.evaluation?.receiptSha256,
    );
  });

  it("records a real report-validator failure with the earlier validator receipt", async () => {
    const value = await fixture();
    const executable = join(value.root, "selective-python3");
    await writeFile(
      executable,
      [
        "#!/usr/bin/env python3",
        "import os",
        "import sys",
        'if sys.argv[1].endswith("validate_quality_report.py"):',
        '    print("error: report target paths does not match evaluation.json", file=sys.stderr)',
        "    raise SystemExit(1)",
        'os.execvp("python3", ["python3", *sys.argv[1:]])',
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    const host = new QualityValidatorHost({
      store: value.store,
      selection: value.selection,
      temporaryRoot: join(value.root, "report-validator-failure-tmp"),
      stateDirectory: value.stateDirectory,
      executable,
    });
    const artifactCandidate = candidate(value.selection.profile, value.revision);
    artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;

    const error = await host
      .validate(validationInput(value, "quality-report-failure", artifactCandidate))
      .catch((candidateError: unknown) => candidateError);

    expect(error).toBeInstanceOf(QualityArtifactValidationError);
    expect((error as QualityArtifactValidationError).code).toBe("report-binding-invalid");
    expect((error as QualityArtifactValidationError).rejection).toEqual({
      validator: "report-binding",
      code: "report-target-mismatch",
      location: "$.target",
      issueCount: 1,
    });
    expect((error as QualityArtifactValidationError).binding.validators).toMatchObject({
      evaluation: { receiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      qualityScore: null,
      reportBinding: {
        receiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    expect((error as QualityArtifactValidationError).reportMarkdown).toBe(
      artifactCandidate.reportMarkdown,
    );
  });

  it("verifies the locked rule module before a validator that imports it runs (§1.2)", async () => {
    const value = await fixture();
    const artifactCandidate = candidate(value.selection.profile, value.revision);
    artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
    const tampered = {
      ...value.selection,
      pack: {
        ...value.selection.pack,
        qualityLock: {
          ...value.selection.pack.qualityLock,
          files: value.selection.pack.qualityLock.files.map((file) =>
            file.path === "checks/quality_decision_policy.py"
              ? { ...file, sha256: "0".repeat(64) }
              : file,
          ),
        },
      },
    };
    const host = new QualityValidatorHost({
      store: value.store,
      selection: tampered,
      temporaryRoot: join(value.root, "tampered-module-tmp"),
      stateDirectory: value.stateDirectory,
    });
    const error = await host
      .validate(validationInput(value, "quality-rule-module-tampered", artifactCandidate))
      .catch((candidateError: unknown) => candidateError);
    expect(error).toBeInstanceOf(QualityArtifactValidationError);
    expect((error as QualityArtifactValidationError).rejection).toMatchObject({
      validator: "evaluation",
      code: "validator-input-digest-changed",
    });
    // The receipt records the validator's own inputs; the lock binds the module.
    expect((error as QualityArtifactValidationError).binding.validators.evaluation).toBeNull();
  });

  it("records an absent interpreter as incomplete without exposing child output", async () => {
    const value = await fixture();
    const artifactCandidate = candidate(value.selection.profile, value.revision);
    artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
    const host = new QualityValidatorHost({
      store: value.store,
      selection: value.selection,
      temporaryRoot: join(value.root, "missing-runtime-tmp"),
      stateDirectory: value.stateDirectory,
      executable: join(value.root, "missing-python3"),
    });
    const error = await host
      .validate(validationInput(value, "quality-no-runtime", artifactCandidate))
      .catch((candidateError: unknown) => candidateError);
    expect(error).toBeInstanceOf(QualityArtifactValidationError);
    expect((error as QualityArtifactValidationError).code).toBe("validator-unavailable");
    expect((error as QualityArtifactValidationError).rejection).toEqual({
      validator: "evaluation",
      code: "evaluation-validator-unavailable",
      location: "$",
      issueCount: 1,
    });
    expect((error as QualityArtifactValidationError).binding.status).toBe("incomplete");
  });

  it(
    "keeps the records tool off the default real runner/Pi route",
    async () => {
      const value = await fixture();
      const artifactCandidate = candidate(value.selection.profile, value.revision);
      artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
      const technical = technicalVerification();
      const piHarness = toolPathHarness();
      const bodies = recordingProvider([
        textTurn(
          `${JSON.stringify({
            evaluation: artifactCandidate.evaluation,
            qualityScore: artifactCandidate.qualityScore,
            reportMarkdown: artifactCandidate.reportMarkdown,
          })}`,
        ),
      ]);
      const harness: AgentHarness = {
        runStep: async (input) => {
          if (input.step.skill === "evaluate-document-quality")
            return await piHarness.runStep(input);
          if (input.step.skill === "verify-technical-accuracy") {
            return await technicalPhaseFixture(input, technical);
          }
          if (input.step.skill === "review-documentation") {
            return { summary: JSON.stringify({ verdict: "pass", issues: [] }) };
          }
          return { summary: `${input.step.skill} completed` };
        },
      };
      const runner = new WorkflowRunner({
        harness,
        hostOperations: {
          runStep: async (input) => ({ summary: `${input.step.skill} completed` }),
        },
        store: new MemoryStore(),
        ...qualityRunnerOptions(value),
        id: () => "quality-records-runner-integration",
      });

      const record = await runner.run(reviewRunRequest(value));

      expect(
        record.status,
        `closed failure code: ${record.steps.at(-1)?.failure?.code ?? "none"}`,
      ).toBe("succeeded");
      expect(bodies.length).toBeGreaterThan(0);
      const presentedTools = (bodies[0]!.tools as Array<{ function: { name: string } }>).map(
        (tool) => tool.function.name,
      );
      expect(presentedTools).not.toContain(QUALITY_ANSWER_RECORD_TOOL_NAME);
    },
    testTimeoutMs(30_000),
  );

  it("charges and screens records arguments against the provider response bound before preflight", async () => {
    const value = await fixture();
    const baseInput = await qualityStepInput(value.workspacePath);
    const { answerSubmission: _legacyAnswerSubmission, ...stepInput } = baseInput;
    const prepareBatch = vi.fn(async () => undefined);
    const receipt = vi.fn(() => ({
      status: "refused" as const,
      type: null,
      key: null,
      code: "answer-record-json" as const,
      location: "$",
      retry: "model-correctable" as const,
      remaining: [],
      complete: false,
    }));
    const settle = vi.fn(async () => undefined);
    const raw = JSON.stringify({ type: "target-judgment", record: { rationale: "x".repeat(512) } });
    const bodies = recordingProvider([
      rawToolCallTurn([
        {
          id: "oversized-record",
          name: QUALITY_ANSWER_RECORD_TOOL_NAME,
          chunks: [raw],
        },
      ]),
    ]);

    const error = await toolPathHarness({ maxResponseBytes: 64 })
      .runStep({
        ...stepInput,
        qualityAnswerRecords: {
          answerNowProgress: () => ({
            requiredKeys: [],
            remainingKeys: [],
            completedKeys: [],
            openSets: [],
            complete: false,
          }),
          prepareBatch,
          receipt,
          settle,
        },
        qualityAnswerRecordCallCeiling: qualityProfileRecordCallCeiling(value.selection.profile),
        qualityAnswerRecordGuidance: "fixture guidance",
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(InferenceStepError);
    const inferenceError = error as InferenceStepError;
    const cause = (inferenceError as Error & { cause?: unknown }).cause;
    const safeFailure = {
      name: inferenceError.name,
      category: inferenceError.category,
      code: Reflect.get(inferenceError, "code"),
      causeName: cause instanceof Error ? cause.name : typeof cause,
      causeCode: cause && typeof cause === "object" ? Reflect.get(cause, "code") : undefined,
    };
    expect(safeFailure, JSON.stringify(safeFailure)).toMatchObject({
      category: "provider-transient",
      causeName: "ProviderResponseLimitError",
      causeCode: "provider-response-too-large",
    });
    expect(bodies).toHaveLength(1);
    expect(prepareBatch).not.toHaveBeenCalled();
    expect(receipt).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it(
    "admits, reloads, assembles, and validates real Pi record calls under explicit test injection",
    async () => {
      const value = await fixture(false, false, false, true);
      const artifactCandidate = candidate(value.selection.profile, value.revision, [
        {
          severity: "major",
          dimension_id: "factual-accuracy",
          description: "The quickstart omits a required input behavior.",
          evidence: [
            {
              description: "The host verification fixture identifies the source obligation.",
              evidence_class: "grounded-judgment",
              locator: "src/cli.ts:85-91",
              strength: "direct",
            },
          ],
          acceptance_condition: "Document the input behavior stated by the source.",
          originating_ids: ["FACT-TRACE-001", "TECH-001"],
        },
      ]);
      artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
      const createAnswerRecordSession = value.host.createAnswerRecordSession.bind(value.host);
      let sessionConstruction = "not-called";
      let prepareFailure = "none";
      let preFinishRows = "not-captured";
      let rawArgumentCallCount = 0;
      let rawArgumentPresentCount = 0;
      let rawArgumentByteCount = 0;
      const receiptByCall = new Map<
        string,
        {
          status: string;
          type: string;
          key: string;
          code: string;
          location: string;
          remaining: number;
        }
      >();
      const settlementBatches: Array<{
        calls: number;
        authorized: number;
        successful: number;
        receipts: Array<{
          status: string;
          type: string;
          key: string;
          code: string;
          location: string;
          remaining: number;
        }>;
      }> = [];
      value.host.createAnswerRecordSession = async (input) => {
        try {
          const session = await createAnswerRecordSession(input);
          sessionConstruction = "created";
          const finish = session.finish.bind(session);
          const prepareBatch = session.capability.prepareBatch.bind(session.capability);
          const receipt = session.capability.receipt.bind(session.capability);
          const settle = session.capability.settle.bind(session.capability);
          return {
            ...session,
            capability: {
              ...session.capability,
              receipt: (toolCallId) => {
                const result = receipt(toolCallId);
                receiptByCall.set(toolCallId, {
                  status: result.status,
                  type: result.type ?? "none",
                  key: result.key ?? "singleton",
                  code: result.code ?? "none",
                  location: result.location ?? "none",
                  remaining: result.remaining.length,
                });
                return result;
              },
              prepareBatch: async (batch) => {
                rawArgumentCallCount += batch.toolCalls.length;
                for (const call of batch.toolCalls) {
                  if (call.rawArguments === undefined) continue;
                  rawArgumentPresentCount += 1;
                  rawArgumentByteCount += Buffer.byteLength(call.rawArguments, "utf8");
                }
                try {
                  return await prepareBatch(batch);
                } catch (error) {
                  prepareFailure = closedHostFailureSummary(error);
                  throw error;
                }
              },
              settle: async (settlement) => {
                settlementBatches.push({
                  calls: settlement.toolCallIds.length,
                  authorized: settlement.authorizedToolCallIds.length,
                  successful: settlement.successfulToolCallIds.length,
                  receipts: settlement.toolCallIds.flatMap((id) => {
                    const safe = receiptByCall.get(id);
                    return safe ? [safe] : [];
                  }),
                });
                return await settle(settlement);
              },
            },
            finish: async (reportMarkdown: string) => {
              try {
                const snapshot = await session.snapshotIndex();
                const rowCounts = new Map<string, number>();
                for (const row of snapshot?.rows ?? []) {
                  const identity = `${row.type}:${row.state}`;
                  rowCounts.set(identity, (rowCounts.get(identity) ?? 0) + 1);
                }
                preFinishRows = JSON.stringify(Object.fromEntries([...rowCounts].sort()));
                return await finish(reportMarkdown);
              } catch (error) {
                sessionConstruction = `finish:${closedHostFailureSummary(error)}`;
                throw error;
              }
            },
          };
        } catch (error) {
          sessionConstruction = closedHostFailureSummary(error);
          throw error;
        }
      };
      const calls = qualityAnswerRecordCalls(artifactCandidate, value.selection.profile);
      const canonicalLeaseShape = resolveLeaseShapeForTurns(
        EXECUTION_LEASE_DEFAULTS,
        EXECUTION_LEASE_DEFAULTS.maxProviderTurns,
      );
      // This synthetic provider has a deliberately small turn budget by
      // default, which shrinks the lease-derived call ceiling to eight. The
      // records journey exercises the canonical supported per-step ceiling;
      // it does not raise or bypass that production limit.
      expect(calls.length).toBeLessThanOrEqual(EXECUTION_LEASE_DEFAULTS.hardToolCallCeiling);
      expect(canonicalLeaseShape.hardToolCallCeiling).toBe(
        EXECUTION_LEASE_DEFAULTS.hardToolCallCeiling,
      );
      const callBatches = Array.from({ length: Math.ceil(calls.length / 8) }, (_, index) =>
        calls.slice(index * 8, (index + 1) * 8),
      );
      const technical = technicalVerification();
      const piHarness = toolPathHarness({
        maxProviderTurns: EXECUTION_LEASE_DEFAULTS.maxProviderTurns,
      });
      const bodies = recordingProvider([
        ...callBatches.map((batch) => rawToolCallTurn(batch)),
        textTurn(artifactCandidate.reportMarkdown),
      ]);
      const harness: AgentHarness = {
        qualityAnswerRecordRouteBindingSha256: () => "f".repeat(64),
        qualityAnswerRecordProviderId: () => piHarness.qualityAnswerRecordProviderId(),
        runStep: async (input) => {
          if (input.step.skill === "evaluate-document-quality")
            return await piHarness.runStep(input);
          if (input.step.skill === "verify-technical-accuracy") {
            return await technicalPhaseFixture(input, technical);
          }
          if (input.step.skill === "review-documentation") {
            return { summary: JSON.stringify({ verdict: "pass", issues: [] }) };
          }
          return { summary: `${input.step.skill} completed` };
        },
      };
      const record = await new WorkflowRunner({
        harness,
        hostOperations: {
          runStep: async (input) => ({ summary: `${input.step.skill} completed` }),
        },
        store: new MemoryStore(),
        ...qualityRunnerOptions(value),
        id: () => "quality-records-runner-integration",
      }).run(reviewRunRequest(value));

      const step = record.steps.find((item) => item.skill === "evaluate-document-quality");
      const ledgerIndex = step
        ? (Reflect.get(step, "answerRecordLedger") as
            | {
                rows?: readonly unknown[];
              }
            | undefined)
        : undefined;
      const toolResponseCount = bodies
        .flatMap((body) => {
          const messages = body.messages as Array<{ role?: string }> | undefined;
          return messages ?? [];
        })
        .filter((message) => message.role === "tool").length;
      const receipts = answerRecordReceiptSummary(bodies);
      const settlementCounts = settlementBatches.map(
        ({ calls: batchCalls, authorized, successful }) => ({
          calls: batchCalls,
          authorized,
          successful,
        }),
      );
      const lastBatchReceipts = settlementBatches.at(-1)?.receipts ?? [];
      expect(
        record.status,
        `closed failure=${record.steps.at(-1)?.failure?.code ?? "none"}; session=${sessionConstruction}; prepare=${prepareFailure}; raw=${rawArgumentPresentCount}/${rawArgumentCallCount} calls,${rawArgumentByteCount} bytes; rows=${preFinishRows}; planned=${calls.length}/${canonicalLeaseShape.hardToolCallCeiling}; batches=${JSON.stringify(settlementCounts)}; last receipts=${JSON.stringify(lastBatchReceipts)}; provider turns=${bodies.length}; tool responses=${toolResponseCount}; index rows=${ledgerIndex?.rows?.length ?? 0}`,
      ).toBe("succeeded");
      expect(rawArgumentCallCount).toBe(calls.length);
      expect(rawArgumentPresentCount).toBe(calls.length);
      expect(rawArgumentByteCount).toBeGreaterThan(0);
      expect(bodies.length).toBeGreaterThan(0);
      const presentedTools = (bodies[0]!.tools as Array<{ function: { name: string } }>).map(
        (tool) => tool.function.name,
      );
      expect(presentedTools).toContain(QUALITY_ANSWER_RECORD_TOOL_NAME);
      expect(presentedTools).not.toContain(SUBMIT);
      expect(presentedTools).not.toContain("validate_quality_candidate");
      const finalMessages = bodies.at(-1)?.messages as
        | Array<{ role?: string; content?: unknown }>
        | undefined;
      const finalToolMessages = (finalMessages ?? []).filter((message) => message.role === "tool");
      const finalReceiptTexts = finalToolMessages.flatMap((message) => {
        if (typeof message.content === "string") return [message.content];
        if (!Array.isArray(message.content)) return [];
        return message.content.flatMap((item) =>
          item && typeof item === "object" && "text" in item && typeof item.text === "string"
            ? [item.text]
            : [],
        );
      });
      expect(
        finalReceiptTexts.some((text) => {
          try {
            return (JSON.parse(text) as { complete?: unknown }).complete === true;
          } catch {
            return false;
          }
        }),
      ).toBe(true);
      const completedStep = step!;
      const completedIndex = ledgerIndex as {
        rows: Array<{
          type: string;
          key: string;
          recordSha256: string;
          state: string;
          attempt: number;
        }>;
      };
      expect(completedIndex).toEqual(
        expect.objectContaining({
          contractId: "quality-evaluation",
          bindingsSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          rows: expect.any(Array),
        }),
      );
      expect(completedIndex.rows.length).toBeGreaterThan(1);
      expect(
        completedIndex.rows.every((row) => row.state === "admitted" && row.attempt === 1),
      ).toBe(true);
      for (const row of completedIndex.rows) {
        const stored = await value.store.getRecord(row.recordSha256);
        expect(stored).toEqual(
          expect.objectContaining({
            contractId: "quality-evaluation",
            runId: record.id,
            stepId: completedStep.id,
            attempt: 1,
            type: row.type,
            key: row.key,
            state: "admitted",
          }),
        );
      }
    },
    testTimeoutMs(60_000),
  );

  it.each([
    {
      name: "a" as const,
      minimalO4: false,
      order: "forward" as const,
      discovery: false,
      expectedLayers: {
        effective_experience: "insufficient-evidence",
        transferable_understanding: "insufficient-evidence",
        trustworthy_information: "fail",
      },
    },
    {
      name: "b" as const,
      minimalO4: false,
      order: "forward" as const,
      discovery: false,
      expectedLayers: {
        effective_experience: "fail",
        transferable_understanding: "fail",
        trustworthy_information: "fail",
      },
    },
    {
      name: "a" as const,
      minimalO4: false,
      order: "scrambled" as const,
      discovery: false,
      expectedLayers: {
        effective_experience: "insufficient-evidence",
        transferable_understanding: "insufficient-evidence",
        trustworthy_information: "fail",
      },
    },
    {
      name: "b" as const,
      minimalO4: false,
      order: "scrambled" as const,
      discovery: false,
      expectedLayers: {
        effective_experience: "fail",
        transferable_understanding: "fail",
        trustworthy_information: "fail",
      },
    },
    {
      name: "b" as const,
      minimalO4: true,
      order: "scrambled" as const,
      discovery: false,
      expectedLayers: {
        effective_experience: "insufficient-evidence",
        transferable_understanding: "fail",
        trustworthy_information: "insufficient-evidence",
      },
    },
    {
      name: "a" as const,
      minimalO4: false,
      order: "forward" as const,
      discovery: true,
      expectedLayers: {
        effective_experience: "insufficient-evidence",
        transferable_understanding: "insufficient-evidence",
        trustworthy_information: "fail",
      },
    },
  ])(
    "replays fixture $name ($order, minimalO4=$minimalO4, discovery=$discovery), corrects refused required judgments, and retains the oracle verdict",
    async ({ name, minimalO4, order, discovery, expectedLayers }) => {
      const value = await fixture(false, true, false, !discovery, true, discovery);
      expect(value.host.answerRecordsTestInjectionEnabled).toBe(!discovery);
      expect(value.host.answerRecordsExperimentalDiscoveryEnabled).toBe(discovery);
      const artifactStoreObservation = observeQualityArtifactStore(value.store);
      const sourceBytes = await readFile(join(value.workspacePath, "src/sprout.mjs"));
      const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
      const technical = historicalTechnicalVerification(name, sourceSha256);
      expect(() =>
        validateVerificationResult(
          technical,
          value.selection.evaluationTarget.map((entry) => entry.path),
        ),
      ).not.toThrow();
      const { rawEvaluation, records, calls } = await historicalQualityRecordFixture(
        name,
        value.selection.profile,
        minimalO4,
      );
      expect(canonicalDigest(records)).toBe(
        name === "a"
          ? "476279ce29f99d19988a87cb7409254b9eafe950f121668e5c110e728c48416c"
          : "3f9d71f342542d166ca9990a06745b6f96f0f9d0c150739e5add35ca64730e50",
      );
      const admittedFactIds = new Set(
        technical.factInventory.dimensions.flatMap((dimension) =>
          dimension.facts.map((fact) => fact.id),
        ),
      );
      const unresolvedFactIds = new Set(
        records.flatMap((entry) => {
          if (!entry.record || typeof entry.record !== "object" || Array.isArray(entry.record)) {
            return [];
          }
          const origins = (entry.record as Record<string, unknown>).originating_ids;
          return Array.isArray(origins)
            ? origins.filter(
                (origin): origin is string =>
                  typeof origin === "string" &&
                  origin.startsWith("FACT-") &&
                  !admittedFactIds.has(origin),
              )
            : [];
        }),
      );
      expect([...unresolvedFactIds].sort()).toEqual([]);
      const corrections = historicalCorrectionCalls(
        name,
        rawEvaluation,
        records,
        value.selection.profile,
      );
      expect(corrections.length).toBeGreaterThan(0);
      const contractOracle = historicalApplyContract(rawEvaluation, value.selection.profile);
      // Frozen external Python apply_contract digests: A 0fa6460c...; B
      // 301c67e5... . This parsed-value digest independently cross-checks the
      // TypeScript expected helper against the Python-produced JSON. The B
      // Python byte digest differs only because Python emits 0.0 while
      // JSON.stringify emits 0; both parsed values are equal numbers.
      expect(canonicalDigest(contractOracle)).toBe(
        name === "a"
          ? "0fa6460c668c132f75f874c6f29bbf1534959b9cd900e72c5ce5c6099eab3ecb"
          : "bc2b4ea902f4ef534abc02fb7a4a43bf19f4d419eff7acc4f710be033f7c6da7",
      );
      const corpusEvaluation = historicalCorpusEvaluation(rawEvaluation);
      const oracleArtifact = minimalO4
        ? historicalMinimalO4Oracle(corpusEvaluation, value.selection.profile)
        : historicalApplyContract(corpusEvaluation, value.selection.profile);
      for (const correction of historicalCorrectionCalls(
        name,
        rawEvaluation,
        records,
        value.selection.profile,
      )) {
        const proposal = JSON.parse(correction.chunks[0]!) as {
          type?: string;
          key?: string;
          record?: Record<string, unknown>;
        };
        if (proposal.type === "layer-note" && proposal.key && proposal.record) {
          oracleArtifact.layers[proposal.key].limitations = structuredClone(
            proposal.record.limitations,
          );
        }
      }
      for (const entry of records) {
        if (
          entry.type !== "dimension" ||
          !entry.key ||
          !requiredProfileDimensionIds(value.selection.profile).has(entry.key) ||
          !entry.record ||
          typeof entry.record !== "object" ||
          Array.isArray(entry.record) ||
          (entry.record as Record<string, unknown>).assessment !== "not-applicable"
        ) {
          continue;
        }
        const layer = Object.entries(oracleArtifact.layers as Record<string, any>).find(
          ([, value]) =>
            value.dimensions.some(
              (dimension: Record<string, unknown>) => dimension.dimension_id === entry.key,
            ),
        )?.[1];
        expect(layer?.limitations).toContain(
          `${entry.key} was not assessed from the available evidence.`,
        );
      }
      const expectedHostLimitations = historicalHostLimitations(
        rawEvaluation,
        value.selection.profile,
        name,
      );
      expect(oracleArtifact.overall_decision).toBe("fail");
      expect(oracleArtifact.outcomes).toEqual({ human: [], agent: [] });
      expect(oracleArtifact.confidence).toBe(name === "a" ? 0.25 : 0);
      expect(
        Object.fromEntries(
          Object.entries(oracleArtifact.layers as Record<string, { confidence: number }>).map(
            ([id, layer]) => [id, layer.confidence],
          ),
        ),
      ).toEqual(
        name === "a"
          ? {
              effective_experience: 0.25,
              transferable_understanding: 0.25,
              trustworthy_information: 0.25,
            }
          : {
              effective_experience: 0,
              transferable_understanding: 0,
              trustworthy_information: 0.25,
            },
      );
      const ordered = order === "scrambled" ? scrambleHistoricalRecordCalls(calls) : calls;
      const batches = Array.from({ length: Math.ceil(ordered.length / 8) }, (_, index) =>
        ordered.slice(index * 8, (index + 1) * 8),
      );
      const reportMarkdown = candidate(value.selection.profile, value.revision).reportMarkdown;
      const editorialIssues = ["REV-001", "REV-002"].map((id) => ({
        id,
        severity: "major" as const,
        category: "completeness" as const,
        location: "docs/quickstart.md:1-22",
        finding: `Host-authored editorial fixture ${id} is bound to the checked-in quickstart.`,
        evidence: { source_id: "docs/quickstart.md", locator: "docs/quickstart.md:1-22" },
        required_change: "Reconcile the reviewed quickstart against admitted evidence.",
      }));
      const piHarness = toolPathHarness({
        maxProviderTurns: EXECUTION_LEASE_DEFAULTS.maxProviderTurns,
      });
      const recordCallCeilings: number[] = [];
      let createdRecordSession:
        | {
            readonly recordCallCeiling: number;
            readonly referenceIds: Readonly<Record<string, readonly string[]>>;
            readonly referenceSourceSha256s: Readonly<Record<string, string>>;
          }
        | undefined;
      const createRecordSession = value.host.createAnswerRecordSession.bind(value.host);
      vi.spyOn(value.host, "createAnswerRecordSession").mockImplementation(async (input) => {
        const session = await createRecordSession(input);
        createdRecordSession = {
          recordCallCeiling: session.recordCallCeiling,
          referenceIds: input.referenceIds,
          referenceSourceSha256s: input.referenceSourceSha256s,
        };
        return session;
      });
      const bodies = recordingProvider(
        [
          ...batches.map((batch) => rawToolCallTurn(batch)),
          rawToolCallTurn(corrections),
          textTurn(reportMarkdown),
        ],
        batches.length,
      );
      const historicalTrace: string[] = [];
      let admittedTechnical: VerificationResult | undefined;
      const sourceObserver = historicalSourceObligationObserver(value, historicalTrace);
      const harness: AgentHarness = {
        qualityAnswerRecordRouteBindingSha256: () => "f".repeat(64),
        qualityAnswerRecordProviderId: () => piHarness.qualityAnswerRecordProviderId(),
        runStep: async (input) => {
          if (input.step.skill === "evaluate-document-quality") {
            if (input.qualityAnswerRecordCallCeiling !== undefined) {
              recordCallCeilings.push(input.qualityAnswerRecordCallCeiling);
            }
            return await piHarness.runStep(input);
          }
          if (input.step.skill === "verify-technical-accuracy") {
            historicalTrace.push("technical-harness:start");
            try {
              const result = await historicalTechnicalPhaseFixture(input, technical);
              if (result.verificationResult) {
                admittedTechnical = result.verificationResult as VerificationResult;
              }
              historicalTrace.push(
                `technical-harness:return:${result.sourceObligationProposal ? "proposal" : "verification"}`,
              );
              return result;
            } catch (error) {
              historicalTrace.push(
                `technical-harness:error:${error instanceof Error ? error.name : typeof error}`,
              );
              throw error;
            }
          }
          if (input.step.skill === "review-documentation") {
            return {
              summary: canonicalizeJsonEvidence({
                verdict: "human-review",
                issues: editorialIssues,
              }),
            };
          }
          return { summary: `${input.step.skill} completed` };
        },
      };
      const record = await new WorkflowRunner({
        harness,
        hostOperations: {
          runStep: async (input) => ({ summary: `${input.step.skill} completed` }),
        },
        store: new MemoryStore(),
        ...qualityRunnerOptions(value),
        sourceObligationObserver: sourceObserver,
        id: () => `quality-records-historical-${name}-${minimalO4 ? "minimal-o4" : "full"}`,
      }).run({ ...reviewRunRequest(value), reviewScope: value.reviewScope });

      const step = record.steps.find((item) => item.skill === "evaluate-document-quality");
      const receiptSummary = answerRecordReceiptSummary(bodies);
      expect(
        record.status,
        JSON.stringify({
          runStatus: record.status,
          steps: record.steps.map((item) => [
            item.skill,
            item.status,
            item.failure?.code ?? "none",
            item.error?.split(/\r?\n/u)[0]?.slice(0, 240) ?? "none",
          ]),
          recordErrorFirstLine: record.error?.split(/\r?\n/u)[0]?.slice(0, 240) ?? "none",
          historicalTrace,
          evaluatorFailure: step?.failure?.code ?? "none",
          receipts: receiptSummary.statusCounts,
          refused: receiptSummary.refused,
          remaining: receiptSummary.missingRequiredKeys,
          artifactStoreObservation: artifactStoreObservation.summary(),
        }),
      ).toBe("succeeded");
      expect(step).toBeDefined();
      expect(createdRecordSession).toBeDefined();
      expect(recordCallCeilings.length).toBeGreaterThan(0);
      expect(recordCallCeilings.every((value) => value === recordCallCeilings[0])).toBe(true);
      expect(recordCallCeilings[0]).toBe(createdRecordSession!.recordCallCeiling);
      expect(bodies).toHaveLength(batches.length + 2);
      const toolNames = (bodies[0]!.tools as Array<{ function: { name: string } }>).map(
        (tool) => tool.function.name,
      );
      expect(toolNames).toContain(QUALITY_ANSWER_RECORD_TOOL_NAME);
      expect(toolNames).not.toContain(SUBMIT);
      expect(receiptSummary.refused.length).toBeGreaterThan(0);
      const requiredDimensions = requiredProfileDimensionIds(value.selection.profile);
      const expectedRefusedRecords = records
        .filter((entry) => {
          if (
            entry.type !== "dimension" ||
            !entry.key ||
            !requiredDimensions.has(entry.key) ||
            !entry.record ||
            typeof entry.record !== "object" ||
            Array.isArray(entry.record)
          )
            return false;
          return (entry.record as Record<string, unknown>).assessment === "not-applicable";
        })
        .map((entry) => ({ type: entry.type, key: entry.key!, code: "answer-record-shape" }))
        .sort((left, right) => left.key.localeCompare(right.key));
      const actualRefusedRecords = receiptSummary.refused
        .map(({ type, key, code }) => ({ type, key, code }))
        .sort((left, right) => left.key.localeCompare(right.key));
      expect(
        actualRefusedRecords,
        JSON.stringify({ fixture: name, minimalO4, actualRefusedRecords, expectedRefusedRecords }),
      ).toEqual(expectedRefusedRecords);
      const correctionResponses = bodies
        .flatMap((body) => (body.messages ?? []) as Array<Record<string, unknown>>)
        .filter(
          (message) =>
            message.role === "tool" &&
            typeof message.tool_call_id === "string" &&
            message.tool_call_id.startsWith(`historical-${name}-correction-`),
        );
      expect(correctionResponses).toHaveLength(corrections.length);
      const correctionReceiptSummary = correctionResponses.map((message) => {
        try {
          const receipt = JSON.parse(String(message.content)) as Record<string, unknown>;
          return {
            type: receipt.type ?? "none",
            key: receipt.key ?? "singleton",
            status: receipt.status ?? "none",
            code: receipt.code ?? "none",
            location: receipt.location ?? "none",
          };
        } catch {
          return {
            type: "invalid",
            key: "invalid",
            status: "invalid",
            code: "invalid",
            location: "invalid",
          };
        }
      });
      expect(
        correctionReceiptSummary.every(({ status }) =>
          ["admitted", "replaced"].includes(String(status)),
        ),
        JSON.stringify({
          fixture: name,
          minimalO4,
          correctionCount: correctionResponses.length,
          expectedCorrectionCount: corrections.length,
          correctionReceipts: correctionReceiptSummary,
          initialRefusals: actualRefusedRecords,
          expectedInitialRefusals: expectedRefusedRecords,
        }),
      ).toBe(true);
      const index = step?.answerRecordLedger;
      expect(index).toBeDefined();
      if (!index) throw new Error("historical result omitted the answer-record index");
      expect(index.rows).toHaveLength(43);
      expect(index.rows.every((row) => row.state === "admitted" && row.attempt === 1)).toBe(true);
      expect(index.rows.filter((row) => row.type === "finding").map((row) => row.key)).toEqual([
        "F-1",
        "F-2",
        "F-3",
        "F-4",
      ]);
      const binding = record.qualityArtifactValidation;
      expect(binding?.status).toBe("passed");
      const staged = await loadStagedQualityArtifact(
        value.store,
        binding!.artifacts.evaluation!.recordSha256,
      );
      const actual = staged.payload as Record<string, any>;
      const findingRows = index.rows.filter((row) => row.type === "finding");
      const corpusFindingOrigins = Object.fromEntries(
        records
          .filter((entry) => entry.type === "finding")
          .map((entry, ordinal) => {
            const record = entry.record as Record<string, unknown>;
            const origins = record.originating_ids;
            if (!Array.isArray(origins) || !origins.every((value) => typeof value === "string")) {
              throw new Error("Historical corpus finding omitted its typed source origins.");
            }
            return [`F-${ordinal + 1}`, origins as string[]];
          }),
      );
      const originIdsByFindingId: Record<string, readonly string[]> = {};
      for (const row of findingRows) {
        const stored = await value.store.getRecord(row.recordSha256);
        if (!stored || typeof stored !== "object" || !("payload" in stored)) {
          throw new Error("Historical finding row was not durably stored.");
        }
        const payload = (stored as { payload: Record<string, unknown> }).payload;
        const origins = payload.originating_ids;
        if (!Array.isArray(origins) || !origins.every((entry) => typeof entry === "string")) {
          throw new Error("Historical finding row omitted its typed source origins.");
        }
        expect(origins).toEqual(corpusFindingOrigins[row.key]);
        originIdsByFindingId[row.key] = origins as string[];
      }
      expect(admittedTechnical).toBeDefined();
      const technicalDigest = canonicalDigest(admittedTechnical);
      const boundFactIds = [
        ...new Set(
          admittedTechnical!.factInventory.dimensions.flatMap((dimension) =>
            dimension.facts.map((fact) => fact.id),
          ),
        ),
      ];
      const boundIssueIds = [
        ...new Set(
          admittedTechnical!.review.issues.flatMap((issue) =>
            typeof issue.id === "string" ? [issue.id] : [],
          ),
        ),
      ];
      expect(createdRecordSession?.referenceSourceSha256s).toMatchObject({
        "technical-fact": technicalDigest,
        "technical-issue": technicalDigest,
      });
      expect(createdRecordSession?.referenceIds).toMatchObject({
        "technical-fact": boundFactIds,
        "technical-issue": boundIssueIds,
      });
      const normalized = normalizeHistoricalHostFields(actual, oracleArtifact, {
        runId: record.id,
        stepId: step!.id,
        startedAt: step!.startedAt!,
        completedAt: step!.completedAt!,
        revision: value.revision,
        profile: value.selection,
        targetPaths: value.selection.evaluationTarget.map((entry) => entry.path),
        providerId: piHarness.qualityAnswerRecordProviderId()!,
        technical: admittedTechnical!,
        reviewIssues: editorialIssues,
        fixtureName: name,
        originIdsByFindingId,
        expectedHostLimitations,
      });
      expect(
        canonicalDigest(normalized.actual),
        `model-field-diff-paths=${historicalDifferencePaths(normalized.actual, normalized.expected).join(",")}`,
      ).toBe(canonicalDigest(normalized.expected));
      expect(actual.overall_decision).toBe("fail");
      expect(
        Object.fromEntries(
          Object.entries(actual.layers as Record<string, { decision: string }>).map(
            ([id, layer]) => [id, layer.decision],
          ),
        ),
      ).toEqual(expectedLayers);
      expect(actual.outcomes).toEqual({ human: [], agent: [] });
      expect(actual.findings).toHaveLength(4);
      expect(actual.findings.map((finding: Record<string, unknown>) => finding.id)).toEqual([
        "F-1",
        "F-2",
        "F-3",
        "F-4",
      ]);
      expect(editorialIssues.map((issue) => issue.id)).toEqual(["REV-001", "REV-002"]);
      expect(rawEvaluation.overall_decision).toBe("fail");
      if (minimalO4) {
        expect(actual.hard_gate_failures).toEqual(["broken-required-example"]);
        expect(
          Object.fromEntries(
            Object.entries(actual.layers as Record<string, { hard_gate_failures: string[] }>).map(
              ([id, layer]) => [id, layer.hard_gate_failures],
            ),
          ),
        ).toEqual({
          effective_experience: [],
          transferable_understanding: ["broken-required-example"],
          trustworthy_information: [],
        });
      }
    },
    testTimeoutMs(120_000),
  );

  it("refuses records mode before evaluator work when the host provider identity is absent", async () => {
    const value = await fixture(false, false, false, true);
    const technical = technicalVerification();
    let evaluatorCalls = 0;
    const harness: AgentHarness = {
      qualityAnswerRecordRouteBindingSha256: () => "f".repeat(64),
      runStep: async (input) => {
        if (input.step.skill === "evaluate-document-quality") evaluatorCalls += 1;
        if (input.step.skill === "verify-technical-accuracy") {
          return await technicalPhaseFixture(input, technical);
        }
        if (input.step.skill === "review-documentation") {
          return { summary: JSON.stringify({ verdict: "pass", issues: [] }) };
        }
        return { summary: `${input.step.skill} completed` };
      },
    };
    const createSession = vi.spyOn(value.host, "createAnswerRecordSession");
    const record = await new WorkflowRunner({
      harness,
      hostOperations: { runStep: async (input) => ({ summary: `${input.step.skill} completed` }) },
      store: new MemoryStore(),
      ...qualityRunnerOptions(value),
      id: () => "quality-records-provider-absent",
    }).run(reviewRunRequest(value));

    const evaluatorStep = record.steps.find((step) => step.skill === "evaluate-document-quality");
    expect(
      evaluatorStep,
      JSON.stringify(record.steps.map((step) => [step.skill, step.status])),
    ).toBeDefined();
    expect(
      record.steps
        .slice(0, record.steps.indexOf(evaluatorStep!))
        .every((step) => step.status === "succeeded"),
    ).toBe(true);
    expect(record.status).toBe("failed");
    expect(
      evaluatorStep?.failure?.code,
      JSON.stringify({ error: evaluatorStep?.error, failure: evaluatorStep?.failure }),
    ).toBe("quality-evaluator-identity-unbound");
    expect(evaluatorCalls).toBe(0);
    expect(createSession).not.toHaveBeenCalled();
  });

  it.each([
    { name: "successful release", releaseFails: false },
    { name: "release failure", releaseFails: true },
  ])("preserves provider mismatch as primary on $name", async ({ releaseFails }) => {
    const value = await fixture(false, false, false, true);
    const technical = technicalVerification();
    let rowState: "admitted" | "released" = "admitted";
    const index = () => ({
      schemaVersion: 1 as const,
      kind: "docsfab-answer-record-ledger-index" as const,
      contractId: "quality-evaluation",
      bindingsSha256: "a".repeat(64),
      rows: [
        {
          type: "finding" as const,
          key: "F-1",
          recordSha256: "b".repeat(64),
          state: rowState,
          attempt: 1,
        },
      ],
    });
    const session = {
      capability: {
        prepareBatch: vi.fn(async () => undefined),
        receipt: vi.fn(() => ({
          status: "refused" as const,
          type: null,
          key: null,
          code: "answer-record-shape" as const,
          location: "$",
          retry: "terminal" as const,
          remaining: [],
          complete: false,
        })),
        settle: vi.fn(async () => undefined),
      },
      promptGuidance: "records guidance",
      checkpointWasStale: vi.fn(() => false),
      replayState: vi.fn(async () => ({
        pairs: [],
        remainingKeys: [],
        completedKeys: [],
        complete: false,
      })),
      snapshotIndex: vi.fn(async () => index()),
      releaseAll: vi.fn(async () => {
        if (releaseFails) throw new Error("release failed");
        rowState = "released";
      }),
      finish: vi.fn(async () => {
        throw new Error("mismatched provider must not finish the record session");
      }),
    } as unknown as QualityAnswerRecordSessionV1;
    const createSession = vi
      .spyOn(value.host, "createAnswerRecordSession")
      .mockResolvedValue(session);
    const harness: AgentHarness = {
      qualityAnswerRecordRouteBindingSha256: () => "f".repeat(64),
      qualityAnswerRecordProviderId: () => "host-bound-provider",
      runStep: async (input) => {
        if (input.step.skill === "evaluate-document-quality") {
          return {
            summary: "report received",
            qualityAnswerRecordReport: "# Report",
            model: { provider: "different-provider", model: "fixture-model" },
          };
        }
        if (input.step.skill === "verify-technical-accuracy") {
          return await technicalPhaseFixture(input, technical);
        }
        if (input.step.skill === "review-documentation") {
          return { summary: JSON.stringify({ verdict: "pass", issues: [] }) };
        }
        return { summary: `${input.step.skill} completed` };
      },
    };
    const record = await new WorkflowRunner({
      harness,
      hostOperations: { runStep: async (input) => ({ summary: `${input.step.skill} completed` }) },
      store: new MemoryStore(),
      ...qualityRunnerOptions(value),
      id: () => `quality-records-provider-mismatch-${releaseFails ? "release-failed" : "released"}`,
    }).run(reviewRunRequest(value));
    const evaluatorStep = record.steps.find((step) => step.skill === "evaluate-document-quality");

    expect(
      evaluatorStep,
      JSON.stringify(record.steps.map((step) => [step.skill, step.status, step.failure?.code])),
    ).toBeDefined();
    expect(
      record.steps
        .slice(0, record.steps.indexOf(evaluatorStep!))
        .every((step) => step.status === "succeeded"),
    ).toBe(true);
    expect(record.status).toBe("failed");
    expect(
      evaluatorStep?.failure?.code,
      JSON.stringify({ error: evaluatorStep?.error, failure: evaluatorStep?.failure }),
    ).toBe("quality-evaluator-identity-unbound");
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(session.releaseAll).toHaveBeenCalledTimes(1);
    expect(session.finish).not.toHaveBeenCalled();
    if (releaseFails) {
      expect(session.snapshotIndex).not.toHaveBeenCalled();
      expect(evaluatorStep?.answerRecordLedger).toBeUndefined();
    } else {
      expect(evaluatorStep?.answerRecordLedger?.rows).toMatchObject([
        { type: "finding", key: "F-1", state: "released", attempt: 1 },
      ]);
    }
  });
});

describe("final quality evaluator correction round (#1246)", {
  timeout: testTimeoutMs(60_000),
}, () => {
  const correctionPolicy = (maxRetries: number): InferenceRetryPolicy => ({
    maxRetries,
    baseDelayMs: 0,
    maxDelayMs: 0,
    retryableCategories: ["malformed-response"],
  });

  /** A review whose final evaluator returns `candidates` in order, repeating the last. */
  async function correctionRun(input: {
    readonly id: string;
    readonly maxRetries: number;
    readonly candidates: (value: QualityFixture) => readonly QualityArtifactCandidateV1[];
    readonly host?: (value: QualityFixture) => QualityValidatorHost;
    readonly outOfScopeDoc?: boolean;
    readonly fullArtifact?: boolean;
  }) {
    const value = await fixture(false, false, input.outOfScopeDoc ?? false);
    const technical = technicalVerification();
    const candidates = input.candidates(value);
    const evaluatorInputs: Parameters<AgentHarness["runStep"]>[0][] = [];
    const harness: AgentHarness = {
      runStep: async (stepInput) => {
        if (stepInput.step.skill === "verify-technical-accuracy") {
          return {
            ...(await technicalPhaseFixture(stepInput, technical)),
            skill: { id: stepInput.step.skill, contentSha256: "a".repeat(64) },
          };
        }
        if (stepInput.step.skill === "evaluate-document-quality") {
          evaluatorInputs.push(stepInput);
          const next = candidates[Math.min(evaluatorInputs.length, candidates.length) - 1]!;
          return {
            summary: next.reportMarkdown,
            qualityArtifactCandidate:
              input.fullArtifact !== false ? { ...next, answerPath: "text" } : next,
            answerBytes: Buffer.byteLength(next.reportMarkdown, "utf8"),
            model: { provider: "fixture-provider", model: "fixture-model" },
            skill: { id: stepInput.step.skill, contentSha256: "f".repeat(64) },
          };
        }
        return { summary: `${stepInput.step.skill} completed` };
      },
    };
    const record = await new WorkflowRunner({
      harness,
      hostOperations: {
        runStep: async (stepInput) => ({ summary: `${stepInput.step.skill} completed` }),
      },
      store: new MemoryStore(),
      ...qualityRunnerOptions(value, input.host?.(value)),
      retryPolicy: correctionPolicy(input.maxRetries),
      retrySleep: async () => undefined,
      id: () => input.id,
    }).run(reviewRunRequest(value));
    const step = record.steps.find((candidate) => candidate.skill === "evaluate-document-quality")!;
    return { value, record, step, evaluatorInputs };
  }

  /** The matrix's missing-source-locator shape: every trace element but the exact locator. */
  function wrongLocator(value: QualityFixture): QualityArtifactCandidateV1 {
    const artifact = candidate(value.selection.profile, value.revision);
    artifact.selectionSha256 = value.selection.receipt.selectionSha256;
    addTechnicalTrace(artifact, "src/cli.ts:86-91");
    return artifact;
  }

  /** A trace element only the evaluator can supply: the finding drops the fact's uncertainty. */
  function missingUncertainty(value: QualityFixture): QualityArtifactCandidateV1 {
    const artifact = traced(value);
    const finding = (artifact.evaluation.findings as Array<Record<string, unknown>>)[0]!;
    (finding.evidence as Array<Record<string, unknown>>)[0]!.description =
      "The evaluator dropped the admitted uncertainty.";
    return artifact;
  }

  function traced(value: QualityFixture): QualityArtifactCandidateV1 {
    const artifact = candidate(value.selection.profile, value.revision);
    artifact.selectionSha256 = value.selection.receipt.selectionSha256;
    addTechnicalTrace(artifact);
    return artifact;
  }

  const firstLayer = (value: QualityFixture): string =>
    Object.keys(
      (
        value.selection.profile.applicability as {
          documentation_set: { required_dimensions_by_layer: Record<string, string[]> };
        }
      ).documentation_set.required_dimensions_by_layer,
    )[0]!;

  it("admits the recorded missing-source-locator shape on its first attempt (#1267)", async () => {
    const { value, record, step, evaluatorInputs } = await correctionRun({
      id: "quality-correction-carried-locator",
      maxRetries: 1,
      candidates: (fixtureValue) => [wrongLocator(fixtureValue)],
    });

    expect(record.status, safeRunFailureSummary(record)).toBe("succeeded");
    expect(record.qualityArtifactValidation).toMatchObject({ status: "passed", failureCode: null });
    expect(step.qualityValidationRejection).toBeUndefined();
    expect(step.inference?.attempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        outcome: "succeeded",
        retryDecision: "not-applicable",
      }),
    ]);
    expect(evaluatorInputs.map((input) => input.responseCorrection)).toEqual([undefined]);
    const staged = await loadStagedQualityArtifact(
      value.store,
      record.qualityArtifactValidation!.artifacts.evaluation!.recordSha256,
    );
    expect(
      (staged.payload as { findings: Array<{ evidence: unknown[] }> }).findings[0]!.evidence,
    ).toContainEqual({
      ...HOST_CARRIED_LOCATOR_EVIDENCE,
      locator: "src/cli.ts:85-91",
      description: hostCarriedLocatorDescription("FACT-TRACE-001"),
    });
  });

  it("names the fact the findings missed in the next attempt's correction, through the runner", async () => {
    // The runner supplies the admitted verification the fact-ID repair reads.
    const missingFactId = (value: QualityFixture): QualityArtifactCandidateV1 => {
      const artifact = traced(value);
      artifact.evaluation = JSON.parse(
        JSON.stringify(artifact.evaluation).replaceAll("FACT-TRACE-001", "ANOTHER-FACT"),
      ) as typeof artifact.evaluation;
      return artifact;
    };
    const { record, step, evaluatorInputs } = await correctionRun({
      id: "quality-correction-fact-id",
      maxRetries: 1,
      candidates: (value) => [missingFactId(value), traced(value)],
    });
    const rejection = { code: "technical-trace-missing-fact-id", location: "$.findings" };

    expect(record.status, safeRunFailureSummary(record)).toBe("succeeded");
    expect(step.inference?.attempts[0]).toMatchObject({ outcome: "malformed-response", rejection });
    expect(evaluatorInputs.map((input) => input.responseCorrection)).toEqual([
      undefined,
      {
        rejection,
        detail: { kind: "quality-trace-fact-ids", factIds: ["FACT-TRACE-001"], withheldCount: 0 },
      },
    ]);
    expect(responseCorrectionInstruction(evaluatorInputs[1]!.responseCorrection)).toContain(
      "No finding names these facts that the admitted technical verification lists as not documented: FACT-TRACE-001.",
    );
  });

  it("retries a missing uncertainty with its rule hint, and a correct reply passes", async () => {
    const { record, step, evaluatorInputs } = await correctionRun({
      id: "quality-correction-uncertainty",
      maxRetries: 1,
      candidates: (value) => [missingUncertainty(value), traced(value)],
    });
    const rejection = { code: "technical-trace-missing-uncertainty", location: "$.findings" };

    expect(record.status, safeRunFailureSummary(record)).toBe("succeeded");
    expect(record.qualityArtifactValidation).toMatchObject({ status: "passed", failureCode: null });
    expect(step.status).toBe("succeeded");
    expect(step.qualityValidationRejection).toBeUndefined();
    expect(step.inference?.attempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        outcome: "malformed-response",
        retryable: true,
        retryScheduled: true,
        conditionRetryability: "eligible",
        retryDecision: "retried",
        rejection,
      }),
      expect.objectContaining({
        attempt: 2,
        outcome: "succeeded",
        retryDecision: "not-applicable",
      }),
    ]);
    expect(evaluatorInputs.map((input) => input.responseCorrection)).toEqual([
      undefined,
      { rejection },
    ]);
    const prompt = responseCorrectionInstruction(evaluatorInputs[1]!.responseCorrection);
    expect(prompt).toContain(
      "The previous response failed host rule technical-trace-missing-uncertainty at $.findings.",
    );
    expect(prompt).toContain(QUALITY_RESPONSE_RULE_HINTS[rejection.code]!.rule);
  });

  it("derives layer confidence from the dimension judgments before validation", async () => {
    let layerId = "";
    const { value, record, step, evaluatorInputs } = await correctionRun({
      id: "quality-correction-layer-confidence",
      maxRetries: 1,
      candidates: (fixtureValue) => {
        layerId = firstLayer(fixtureValue);
        const overconfident = traced(fixtureValue);
        (overconfident.evaluation.layers as Record<string, Record<string, unknown>>)[
          layerId
        ]!.confidence = 0.25;
        return [overconfident];
      },
    });

    expect(record.status, safeRunFailureSummary(record)).toBe("succeeded");
    expect(record.qualityArtifactValidation).toMatchObject({ status: "passed", failureCode: null });
    expect(step.qualityValidationRejection).toBeUndefined();
    expect(step.inference?.attempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        outcome: "succeeded",
        retryDecision: "not-applicable",
      }),
    ]);
    expect(evaluatorInputs).toHaveLength(1);
    const staged = await loadStagedQualityArtifact(
      value.store,
      record.qualityArtifactValidation!.artifacts.evaluation!.recordSha256,
    );
    const layers = (staged.payload as { layers: Record<string, { confidence: number }> }).layers;
    // The fixture's required dimensions all have confidence 0, so the host
    // replaces the supplied layer confidence with the rule-derived value.
    expect(layers[layerId]!.confidence).toBe(0);
  });

  it("declines the artifact instead of failing the run once the configured budget ends", async () => {
    const { value, record, step, evaluatorInputs } = await correctionRun({
      id: "quality-correction-exhausted",
      maxRetries: 1,
      candidates: (value) => [missingUncertainty(value)],
    });

    // No amount of model correction cleared the refusal (both attempts used
    // the same bad candidate), so the host declines the artifact once the
    // configured budget ends instead of failing the whole review -- the
    // same fail-open shape `hostFillRefusedJudgment` already gives the two
    // ledger judgment steps. `record.qualityArtifactValidation` stays unset:
    // nothing was validated, because nothing was admitted for validation.
    expect(evaluatorInputs, safeRunFailureSummary(record)).toHaveLength(2);
    expect(record.status, safeRunFailureSummary(record)).toBe("succeeded");
    expect(record.error).toBeUndefined();
    expect(record.qualityArtifactValidation).toBeUndefined();
    expect(step.status).toBe("succeeded");
    // The rejection is kept on the record even though the step now succeeds,
    // so a reader (or the operator run-index) still finds the exact code.
    expect(step.qualityValidationRejection).toEqual({
      validator: "technical-trace",
      code: "technical-trace-missing-uncertainty",
      location: "$.findings",
      issueCount: 1,
    });
    expect(formatStepRejectionSentence(step)).toBe(
      "Rejected by technical-trace-missing-uncertainty at $.findings (1 quality validator issue).",
    );
    expect(step.failure).toBeUndefined();
    expect(step.summary).toContain(QUALITY_REPORT_DECLINE_STEM);
    expect(step.summary).toContain("technical-trace-missing-uncertainty");
    expect(step.summary).toContain("2 attempts spent");
    // The declining attempt returns normally (it is the host's own choice
    // to stop asking, not a provider failure), so its retained evidence
    // honestly says `succeeded` -- consistent with the step `succeeded` too
    // -- while `qualityValidationRejection` above still names what it
    // declined.
    expect(step.inference?.attempts.map((attempt) => attempt.retryDecision)).toEqual([
      "retried",
      "not-applicable",
    ]);
    expect(step.inference?.attempts.at(-1)).toMatchObject({ attempt: 2, outcome: "succeeded" });
    // The declined attempt still records the size of the reply it admitted;
    // the refused attempt before it records none.
    expect(step.inference?.attempts.map((attempt) => attempt.answerBytes)).toEqual([
      undefined,
      Buffer.byteLength(missingUncertainty(value).reportMarkdown, "utf8"),
    ]);
  });

  it("preserves model limitation rows longer than the former ceiling", async () => {
    const value = await fixture();
    const artifact = candidate(value.selection.profile, value.revision);
    artifact.selectionSha256 = value.selection.receipt.selectionSha256;
    const longLimitation = "x".repeat(513);
    artifact.reportMarkdown += `\n- Limitation: ${longLimitation}`;

    const result = await value.host.validate(
      validationInput(value, "quality-long-model-limitation", artifact),
    );

    expect(result.binding).toMatchObject({ status: "passed" });
    expect(validatedSummary(result.reportMarkdown).limitations).toContain(longLimitation);
    expect(result.reportMarkdown).toContain(`- Limitation: ${longLimitation}`);
  });

  it("keeps a host fault terminal with retries left", async () => {
    const { record, step, evaluatorInputs } = await correctionRun({
      id: "quality-correction-host-fault",
      maxRetries: 3,
      // Keep this legacy candidate untagged to isolate validator unavailability
      // from the full-artifact host derivation path.
      fullArtifact: false,
      candidates: (value) => [traced(value)],
      host: (value) =>
        new QualityValidatorHost({
          store: value.store,
          selection: value.selection,
          temporaryRoot: join(value.root, "missing-runtime-tmp"),
          stateDirectory: value.stateDirectory,
          executable: join(value.root, "missing-python3"),
        }),
    });

    expect(evaluatorInputs, safeRunFailureSummary(record)).toHaveLength(1);
    expect(record).toMatchObject({
      status: "failed",
      qualityArtifactValidation: { status: "incomplete", failureCode: "validator-unavailable" },
    });
    expect(step.qualityValidationRejection).toMatchObject({
      code: "evaluation-validator-unavailable",
    });
    // The provider's reply was not at fault: the attempt keeps its outcome.
    expect(step.inference?.attempts).toEqual([
      expect.objectContaining({ attempt: 1, outcome: "succeeded", retryScheduled: false }),
    ]);
  });

  /** The candidate with `target.paths` as the evaluator wrote it. */
  function targeting(value: QualityFixture, paths: readonly string[]): QualityArtifactCandidateV1 {
    const artifact = traced(value);
    (artifact.evaluation.target as { paths: string[] }).paths = [...paths];
    return artifact;
  }

  async function stagedTargetPaths(value: QualityFixture, record: RunRecord): Promise<unknown> {
    const staged = await loadStagedQualityArtifact(
      value.store,
      record.qualityArtifactValidation!.artifacts.evaluation!.recordSha256,
    );
    return (staged.payload as { target: { paths: unknown } }).target.paths;
  }

  it("writes the host-bound target over a narrowed unfocused one and reports it by counts", async () => {
    // Matrix lane C: the evaluator named only the page earlier steps dwelt on.
    const { value, record, step, evaluatorInputs } = await correctionRun({
      id: "quality-target-narrowed",
      maxRetries: 1,
      candidates: (fixtureValue) => [
        targeting(fixtureValue, ["docs/guide.md", "MARKER-outside.md"]),
      ],
    });

    expect(value.selection.evaluationTarget.map((entry) => entry.path)).toEqual([
      "README.md",
      "docs",
    ]);
    expect(evaluatorInputs, safeRunFailureSummary(record)).toHaveLength(1);
    expect(evaluatorInputs[0]!.qualityEvaluationTarget).toEqual(value.selection.evaluationTarget);
    expect(record.status, safeRunFailureSummary(record)).toBe("succeeded");
    expect(record.qualityArtifactValidation).toMatchObject({ status: "passed", failureCode: null });
    expect(step.inference?.attempts).toEqual([
      expect.objectContaining({ attempt: 1, outcome: "succeeded" }),
    ]);
    expect(await stagedTargetPaths(value, record)).toEqual(["README.md", "docs"]);
    const limitation = evaluationTargetReplacedLimitation(1, 2, 1);
    expect(projectQualityReportFromRun(record)?.limitations).toContain(limitation);
    expect(JSON.stringify(record)).not.toContain("MARKER-outside");
  });

  it("writes the exact cover over a directory that over-claims an out-of-scope page", async () => {
    const { value, record } = await correctionRun({
      id: "quality-target-over-claim",
      maxRetries: 1,
      outOfScopeDoc: true,
      candidates: (fixtureValue) => [targeting(fixtureValue, ["README.md", "docs"])],
    });

    expect(value.selection.evaluationTarget.map((entry) => entry.path)).toEqual([
      "README.md",
      "docs/guide.md",
    ]);
    expect(record.status, safeRunFailureSummary(record)).toBe("succeeded");
    expect(await stagedTargetPaths(value, record)).toEqual(["README.md", "docs/guide.md"]);
    expect(projectQualityReportFromRun(record)?.limitations).toContain(
      evaluationTargetReplacedLimitation(2, 2, 0),
    );
  });

  it("fills an omitted target, as the contract asks, without a limitation", async () => {
    const { value, record, step } = await correctionRun({
      id: "quality-target-omitted",
      maxRetries: 1,
      candidates: (fixtureValue) => {
        const omitted = traced(fixtureValue);
        delete (omitted.evaluation.target as { paths?: unknown }).paths;
        return [omitted];
      },
    });

    expect(record.status, safeRunFailureSummary(record)).toBe("succeeded");
    expect(record.qualityArtifactValidation).toMatchObject({ status: "passed", failureCode: null });
    expect(step.inference?.attempts).toEqual([
      expect.objectContaining({ attempt: 1, outcome: "succeeded" }),
    ]);
    expect(await stagedTargetPaths(value, record)).toEqual(["README.md", "docs"]);
    expect(
      projectQualityReportFromRun(record)?.limitations.some((limitation) =>
        limitation.startsWith("The host bound evaluation.target.paths"),
      ),
    ).toBe(false);
  });

  it("adds no target limitation when the evaluator echoes the bound target", async () => {
    const { value, record } = await correctionRun({
      id: "quality-target-echo",
      maxRetries: 1,
      candidates: (fixtureValue) => [targeting(fixtureValue, ["README.md", "docs/"])],
    });

    expect(record.status, safeRunFailureSummary(record)).toBe("succeeded");
    expect(await stagedTargetPaths(value, record)).toEqual(["README.md", "docs"]);
    expect(
      projectQualityReportFromRun(record)?.limitations.some((limitation) =>
        limitation.startsWith("The host bound evaluation.target.paths"),
      ),
    ).toBe(false);
  });

  it("names the host-bound target, never the reply's paths, when family evidence is unrelated", async () => {
    const { value, record, evaluatorInputs } = await correctionRun({
      id: "quality-target-family-feedback",
      maxRetries: 1,
      candidates: (fixtureValue) => {
        const unrelated = traced(fixtureValue);
        (
          unrelated.evaluation.target as {
            documentation_family_evidence: Array<{ paths: string[] }>;
          }
        ).documentation_family_evidence[0]!.paths = ["MARKER-elsewhere/"];
        return [unrelated, traced(fixtureValue)];
      },
    });
    const rejection = {
      code: "family-evidence-path-unrelated",
      location: "$.target.documentation_family_evidence",
    };

    expect(record.status, safeRunFailureSummary(record)).toBe("succeeded");
    expect(evaluatorInputs.map((input) => input.responseCorrection)).toEqual([
      undefined,
      { rejection },
    ]);
    const correction = responseCorrectionInstruction(
      evaluatorInputs[1]!.responseCorrection,
      evaluatorInputs[1]!,
    );
    expect(correction).toContain(QUALITY_RESPONSE_RULE_HINTS[rejection.code]!.rule);
    expect(correction).toContain(describeEvaluationTarget(value.selection.evaluationTarget));
    expect(correction).not.toContain("MARKER");
  });

  it("checks inertness and credentials before the host writes the target", async () => {
    const value = await fixture();
    const credential = `glpat-${"x".repeat(24)}`;
    const leaking = targeting(value, ["docs/guide.md", credential]);
    const credentialError = await value.host
      .validate(validationInput(value, "quality-target-credential", leaking))
      .catch((error: unknown) => error);
    expect((credentialError as QualityArtifactValidationError).rejection).toMatchObject({
      validator: "candidate-staging",
      code: "candidate-credential-material",
    });
    expect((credentialError as QualityArtifactValidationError).binding).toMatchObject({
      status: "failed",
      failureCode: "candidate-invalid",
    });

    const active = traced(value);
    const target = active.evaluation.target as Record<string, unknown>;
    // A throwing getter: the host must refuse it as non-inert before any fill reads it.
    Object.defineProperty(target, "paths", {
      enumerable: true,
      get: () => {
        throw new Error("evaluator getter ran");
      },
    });
    const inertError = await value.host
      .validate(validationInput(value, "quality-target-not-inert", active))
      .catch((error: unknown) => error);
    expect((inertError as QualityArtifactValidationError).rejection).toMatchObject({
      validator: "candidate-staging",
      code: "candidate-not-inert",
    });
    expect((inertError as QualityArtifactValidationError).binding).toMatchObject({
      status: "failed",
      failureCode: "candidate-invalid",
    });
  });
});

class MemoryStore implements RunStore {
  public readonly records: RunRecord[] = [];

  public async save(record: RunRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}

const passedScanner: RepositorySecurityScanner = {
  scan: async () => ({
    ruleSet: "fixture-v1",
    status: "passed",
    scannedFiles: 1,
    binaryFiles: 0,
    findings: [],
  }),
};

function runRecord(
  selection: RunRecord["qualityProfileSelection"],
  binding: RunRecord["qualityArtifactValidation"],
  markdown: string,
  sourcePath: string,
): RunRecord {
  return {
    schemaVersion: 2,
    id: binding!.runId,
    workflow: "review-documentation",
    repository: {
      sourcePath,
      requestedRevision: "HEAD",
      revision: selection!.repositoryRevision,
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-09-11T12:00:00.000Z",
    models: [],
    skills: [],
    qualityPack: {
      schemaVersion: 1,
      id: "docsfab-default",
      version: "1.0.0",
      manifestSha256: selection!.qualityPackManifestSha256,
      bindingSha256: selection!.qualityPackBindingSha256,
      skillLockSha256: selection!.skillLockSha256,
      qualityLockSha256: selection!.qualityLockSha256,
      qualityBundleSha256: selection!.qualityBundleSha256,
      barIds: ["profile:docsfab-documentation-quality"],
    },
    qualityProfileSelection: selection,
    qualityArtifactValidation: binding,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      turns: 0,
    },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [
      {
        id: "evaluate-document-quality",
        title: "Produce the final quality report",
        kind: "evaluate",
        skill: "evaluate-document-quality",
        mode: "read-only",
        status: "succeeded",
        evaluateEvidence: {
          schemaVersion: 1,
          kind: "docsfab-evaluate-step-evidence",
          evaluatorIdentitySha256: EVALUATOR_IDENTITY,
          toolPolicySha256: "4".repeat(64),
          acceptancePolicySha256: "5".repeat(64),
        },
        summary: markdown,
      },
    ],
  };
}

function restatedEditorialReview(
  options: { fullEvidence?: boolean } = {},
): Record<string, unknown> {
  const issue = (
    id: string,
    severity: string,
    category: string,
    path: string,
    locator: string,
    finding: string,
    requiredChange: string,
  ) => ({
    id,
    severity,
    category,
    location: `${path}:${locator.split(":")[1]!.split("-")[0]}`,
    finding,
    evidence: { source_id: path, locator },
    required_change: requiredChange,
  });
  return {
    verdict: "needs-revision",
    issues: [
      issue(
        "REV-001",
        "major",
        "task_success",
        "README.md",
        options.fullEvidence
          ? `README.md:3-5 ${"Install heading followed only by the help command. ".repeat(8)}`.trim()
          : "README.md:3-5",
        "The Install section contains only `widget --help`. A reader looking for installation steps cannot determine how to install Widget before running the command.",
        "Provide an installation path supported by an approved source, or change the section heading so it accurately describes the help command.",
      ),
      issue(
        "REV-002",
        "major",
        "completeness",
        "docs/usage.md",
        "docs/usage.md:1",
        "The Usage page contains only a heading. A reader cannot find a usage task, its prerequisites, or a way to recognize a useful result.",
        "Add a source-grounded usage task with the prerequisites and observable result needed to follow it.",
      ),
      issue(
        "REV-003",
        "minor",
        "style_compliance",
        "docs/usage.md",
        "docs/usage.md:1",
        "The title omits Widget, and the page has no opening paragraph identifying the product or directing readers to its parent.",
        "Include Widget in the page title and add an opening paragraph that names Widget in its first sentence.",
      ),
    ],
  };
}

function restatingEvaluationFinding(
  id: string,
  description: string,
  locator: string,
): Record<string, unknown> {
  return {
    id,
    severity: "major",
    dimension_id: "scoped-sufficiency",
    description,
    evidence: [
      {
        evidence_class: "grounded-judgment",
        strength: "direct",
        locator,
        description: "Restated editorial evidence.",
      },
    ],
    owner: "documentation-owner",
    acceptance_condition: `Resolve ${id}.`,
    status: "open",
  };
}

function restatingEvaluationFindings(): Record<string, unknown>[] {
  const finding = (
    id: string,
    severity: string,
    dimension: string,
    description: string,
    locator: string,
    evidence: string,
  ) => ({
    id,
    severity,
    dimension_id: dimension,
    description,
    evidence: [
      { evidence_class: "grounded-judgment", strength: "direct", locator, description: evidence },
    ],
    owner: "documentation-owner",
    acceptance_condition: `Resolve ${id}.`,
    status: "open",
  });
  return [
    finding(
      "F-1",
      "major",
      "scoped-sufficiency",
      "REV-001: Install section offers only widget --help, not an installation path; task success has not been observed.",
      "README.md:3-5",
      "Install label and help command, as reported by independent editorial review.",
    ),
    finding(
      "F-2",
      "major",
      "scoped-sufficiency",
      "REV-002: Usage page has only a heading and no usable task, prerequisites, or expected result.",
      "docs/usage.md:1",
      "Heading-only page in independent editorial review.",
    ),
    finding(
      "F-3",
      "major",
      "scoped-sufficiency",
      "REV-003: Usage title lacks Widget context.",
      "docs/usage.md:1",
      "Only generic title.",
    ),
    finding(
      "F-4",
      "minor",
      "editorial-style",
      "The Usage page has no next step.",
      "docs/usage.md:1",
      "No link after the heading.",
    ),
  ];
}

function retainedUnsupportedStep(
  skill: "lint-documentation" | "verify-technical-accuracy" | "review-documentation",
): RunRecord["steps"][number] {
  const summary =
    skill === "verify-technical-accuracy"
      ? [
          "# Human technical report",
          "",
          "```json",
          JSON.stringify({
            verdict: "needs-revision",
            issues: [
              {
                id: "TECH-999",
                severity: "major",
                category: "technical_accuracy",
                location: "README.md:1",
                finding: "A prose-fenced issue is not an admitted artifact.",
                evidence: { source_id: "source-1", locator: "README.md:1" },
                required_change: "Keep prose outside the findings authority channel.",
              },
            ],
          }),
          "```",
        ].join("\n")
      : `# Human ${skill} report\n\nNo structured artifact is admitted.`;
  return {
    id: skill,
    title: skill,
    kind: "evaluate",
    skill,
    mode: "read-only",
    status: "succeeded",
    summary,
  };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function git(repository: string, args: string[]): Promise<string> {
  return (await exec("git", ["-C", repository, ...args], { encoding: "utf8" })).stdout.trim();
}

async function retainedArtifactText(root: string): Promise<string> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  return (
    await Promise.all(files.map((entry) => readFile(join(entry.parentPath, entry.name), "utf8")))
  ).join("\n");
}

describe("answer-record caller path security regressions", {
  timeout: testTimeoutMs(60_000),
}, () => {
  it("binds invalid-key refusals to the original tool_call_id while admitting a valid neighbor", async () => {
    const value = await fixture(false, false, false, true);
    const artifactCandidate = candidate(value.selection.profile, value.revision);
    artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
    const calls = qualityAnswerRecordCalls(artifactCandidate, value.selection.profile);
    expect(calls.length).toBeGreaterThan(1);
    const invalid = calls.find(
      (call) => (JSON.parse(call.chunks[0]!) as { type?: unknown }).type === "dimension",
    )!;
    const invalidEnvelope = JSON.parse(invalid.chunks[0]!) as Record<string, unknown>;
    invalidEnvelope.key = "model-invented-dimension";
    const badCall = { ...invalid, chunks: [JSON.stringify(invalidEnvelope)] };
    const neighbor = calls.find(
      (call) =>
        call.id !== invalid.id &&
        (JSON.parse(call.chunks[0]!) as { type?: unknown }).type === "dimension",
    )!;
    const stored = vi.spyOn(value.store, "putRecord");

    const { bodies, record } = await runPiQualityRecordCalls(value, [badCall, neighbor]);

    const refusal = answerRecordReceiptFor(bodies, badCall.id);
    const admission = answerRecordReceiptFor(bodies, neighbor.id);
    expect(refusal, JSON.stringify(refusal)).toMatchObject({
      status: "refused",
      type: "dimension",
      key: null,
      code: "answer-record-key",
    });
    expect(JSON.stringify(refusal)).not.toContain("model-invented-dimension");
    expect(admission).toMatchObject({ status: "admitted", type: "dimension" });
    expect(answerRecordReceiptFor(bodies, neighbor.id)).not.toEqual(refusal);
    expect(
      stored.mock.calls.some(
        ([, row]) =>
          row && typeof row === "object" && Reflect.get(row, "key") === "model-invented-dimension",
      ),
    ).toBe(false);
    expectExhaustedProviderTurn(record, bodies, 2);
  });

  it("refuses model-authored reserved host evidence through the real Pi route", async () => {
    const value = await fixture(false, false, false, true);
    const artifactCandidate = candidate(value.selection.profile, value.revision, [
      {
        severity: "major",
        dimension_id: "factual-accuracy",
        description: "A model-authored finding with spoofed host evidence.",
        evidence: [
          {
            description: "MODEL-SPOOFED-HOST-FACT-9bd0",
            evidence_class: "grounded-judgment",
            locator: "docs/guide.md:1-3",
            strength: "direct",
            provider_id: "docsfab-host-fact-render",
          },
        ],
        acceptance_condition: "Document the behavior stated by the source.",
        originating_ids: [],
      },
    ]);
    artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
    const calls = qualityAnswerRecordCalls(artifactCandidate, value.selection.profile);
    const finding = calls.find((call) => {
      const envelope = JSON.parse(call.chunks[0]!) as { type?: unknown };
      return envelope.type === "finding";
    });
    const neighbor = calls.find((call) => {
      const envelope = JSON.parse(call.chunks[0]!) as { type?: unknown };
      return envelope.type === "dimension";
    });
    expect(finding).toBeDefined();
    expect(neighbor).toBeDefined();
    const stored = vi.spyOn(value.store, "putRecord");

    const { bodies, record } = await runPiQualityRecordCalls(value, [finding!, neighbor!]);

    expect(answerRecordReceiptFor(bodies, finding!.id)).toMatchObject({
      status: "refused",
      code: "evaluation-profile-semantics",
    });
    expect(answerRecordReceiptFor(bodies, neighbor!.id)).toMatchObject({ status: "admitted" });
    expect(
      stored.mock.calls.some(([, row]) =>
        JSON.stringify(row).includes("MODEL-SPOOFED-HOST-FACT-9bd0"),
      ),
    ).toBe(false);
    expectExhaustedProviderTurn(record, bodies, 2);
  });

  it.each(["raw", "decoded"] as const)(
    "screens %s credential disclosure before canonical checks, derivation, or durable writes",
    async (mode) => {
      const value = await fixture(false, false, false, true);
      const sentinel = `glpat-caller-${Date.now()}-${mode}-fixture-7c9e2a`;
      expect(registerConfiguredCredential(sentinel, `caller-path ${mode} disclosure test`)).toBe(
        "screened",
      );
      const artifactCandidate = candidate(value.selection.profile, value.revision, [
        {
          severity: "major",
          dimension_id: "factual-accuracy",
          description: `Synthetic disclosure sentinel ${sentinel}`,
          evidence: [],
          acceptance_condition: "Document the behavior stated by the source.",
          originating_ids: [],
        },
      ]);
      artifactCandidate.selectionSha256 = value.selection.receipt.selectionSha256;
      const finding = qualityAnswerRecordCalls(artifactCandidate, value.selection.profile).find(
        (call) => (JSON.parse(call.chunks[0]!) as { type?: unknown }).type === "finding",
      )!;
      let rawArguments: string;
      if (mode === "raw") {
        // Keep the captured function arguments valid JSON so Pi delivers the
        // call, but make its nested record JSON malformed. The raw credential
        // guard must stop before the inner decoder; without it the call would
        // receive the ordinary correctable answer-record-json refusal.
        rawArguments = JSON.stringify({
          type: "finding",
          record: `{"description":"Synthetic ${sentinel}`,
        });
      } else {
        const envelope = JSON.parse(finding.chunks[0]!) as Record<string, unknown>;
        const escapedSentinel = Array.from(sentinel)
          .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
          .join("");
        const recordBytes = JSON.stringify(envelope.record).replace(sentinel, escapedSentinel);
        envelope.record = recordBytes;
        rawArguments = JSON.stringify(envelope);
        expect(rawArguments).not.toContain(sentinel);
      }
      const call = { ...finding, chunks: [rawArguments] };
      const spawnLog = join(value.root, "quality-validator-spawns.log");
      const spawnWrapper = join(value.root, "recording-python3");
      await writeFile(
        spawnWrapper,
        `#!/bin/sh\nprintf '%s\\n' "$*" >> "${spawnLog}"\nexec python3 "$@"\n`,
        "utf8",
      );
      await chmod(spawnWrapper, 0o700);
      value.host = new QualityValidatorHost({
        store: value.store,
        selection: value.selection,
        temporaryRoot: join(value.root, "validator-tmp"),
        executable: spawnWrapper,
        answerRecordsTestInjection: true,
      });
      const capabilityReceipts: Array<{
        toolCallId: string;
        receipt: ReturnType<QualityAnswerRecordSessionV1["capability"]["receipt"]>;
      }> = [];
      let referenceLookups = 0;
      const createSession = value.host.createAnswerRecordSession.bind(value.host);
      value.host.createAnswerRecordSession = async (input) => {
        const session = await createSession({
          ...input,
          renderReference: (namespace, ids) => {
            referenceLookups += 1;
            return input.renderReference(namespace, ids);
          },
        });
        const receipt = session.capability.receipt.bind(session.capability);
        session.capability.receipt = (toolCallId) => {
          const result = receipt(toolCallId);
          capabilityReceipts.push({ toolCallId, receipt: result });
          return result;
        };
        return session;
      };
      const validate = vi.spyOn(value.host, "validate");
      const derive = vi.spyOn(value.host, "derive");
      const completion = vi.spyOn(value.host, "validateAnswerRecordCompletion");
      const putRecord = vi.spyOn(value.store, "putRecord");

      if (mode === "raw") {
        // Retain distinct evidence for the earlier composition response
        // screen; the non-composition run below isolates QAR's raw-byte guard.
        const composed = await runPiQualityRecordCalls(value, [call]);
        expect(composed.record.status).toBe("failed");
        expect(answerRecordReceiptFor(composed.bodies, call.id)).toBeUndefined();
      }

      const { bodies, record } = await runPiQualityRecordCalls(value, [call], undefined, {
        composition: mode !== "raw",
      });

      // A terminal refusal can stop the workflow before Pi asks the provider
      // for another turn, so body history is not a reliable observation point.
      // Capture the host's actual content-free receipt at the capability seam.
      const receipt = capabilityReceipts
        .filter((entry) => entry.toolCallId === call.id)
        .at(-1)?.receipt;
      expect(receipt, JSON.stringify(receipt)).toBeDefined();
      if (mode === "raw") {
        expect(receipt, JSON.stringify(receipt)).toMatchObject({
          status: "refused",
          retry: "terminal",
        });
        expect(receipt!.feedback).toBeUndefined();
        expect(JSON.stringify(receipt)).not.toContain('"feedback"');
      } else {
        expect(receipt, JSON.stringify(receipt)).toMatchObject({ status: "refused" });
      }
      const toolContents = bodies.flatMap((body) =>
        ((body.messages ?? []) as Array<Record<string, unknown>>)
          .filter((message) => message.role === "tool" && typeof message.content === "string")
          .map((message) => message.content as string),
      );
      expect(toolContents.join("\n")).not.toContain(sentinel);
      expect(validate).not.toHaveBeenCalled();
      expect(derive).not.toHaveBeenCalled();
      expect(completion).not.toHaveBeenCalled();
      expect(putRecord).not.toHaveBeenCalled();
      expect(referenceLookups).toBe(0);
      expect(record.status).toBe("failed");
      const spawns = await readFile(spawnLog, "utf8");
      expect(spawns).not.toContain("p.check_record(");
      expect(spawns).not.toContain("derive_documentation_quality_evaluation.py");
      if (mode === "decoded") expectExhaustedProviderTurn(record, bodies, 2);
    },
  );
});

describe("records caller guards on disposable locked assets", {
  timeout: testTimeoutMs(60_000),
}, () => {
  it(
    "succeeds on the unmodified full runner/Pi records path before guard mutations",
    async () => {
      const value = await fixture(false, false, false, true);
      const artifact = callerGuardCandidate(value);
      const calls = qualityAnswerRecordCalls(artifact, value.selection.profile);

      const { record, bodies } = await runPiQualityRecordCalls(
        value,
        calls,
        artifact.reportMarkdown,
      );

      expect(record.status).toBe("succeeded");
      const toolMessages = bodies
        .flatMap((body) => (body.messages ?? []) as Array<Record<string, unknown>>)
        .filter((message) => message.role === "tool");
      expect(
        toolMessages.some((message) => {
          try {
            return (
              (JSON.parse(String(message.content)) as { complete?: unknown }).complete === true
            );
          } catch {
            return false;
          }
        }),
      ).toBe(true);
    },
    testTimeoutMs(60_000),
  );

  it("rechecks the rule digest between policy metadata and check_record spawns", async () => {
    const value = await fixture(false, false, false, true);
    const qualityRoot = join(value.root, "disposable-rule-pack");
    await cp(value.selection.pack.qualityRoot, qualityRoot, {
      recursive: true,
      dereference: false,
    });
    value.selection = { ...value.selection, pack: { ...value.selection.pack, qualityRoot } };
    const rulePath = join(qualityRoot, "checks/quality_decision_policy.py");
    const log = join(value.root, "rule-spawns.log");
    const executable = join(value.root, "controlled-python3");
    await writeFile(
      executable,
      [
        "#!/bin/bash",
        "printf '%s\\n' \"$*\" >> '" + log + "'",
        'if [[ "$*" == *constraintKeys* ]]; then',
        '  python3 "$@"',
        "  status=$?",
        "  printf '\\n# disposable integrity mutation\\n' >> '" + rulePath + "'",
        '  exit "$status"',
        "fi",
        'exec python3 "$@"',
      ].join("\n"),
      "utf8",
    );
    await chmod(executable, 0o700);
    value.host = new QualityValidatorHost({
      store: value.store,
      selection: value.selection,
      temporaryRoot: join(value.root, "validator-tmp"),
      executable,
      answerRecordsTestInjection: true,
    });
    const artifact = callerGuardCandidate(value);
    const call = qualityAnswerRecordCalls(artifact, value.selection.profile).find((entry) => {
      return (JSON.parse(entry.chunks[0]!) as { type?: unknown }).type === "dimension";
    })!;

    const { record } = await runPiQualityRecordCalls(value, [call]);

    const spawns = await readFile(log, "utf8");
    expect(spawns).toContain("constraintKeys");
    expect(spawns).not.toContain("p.check_record(");
    expect(record.status).toBe("failed");
  });

  it(
    "rechecks the rule digest after admitted records and before the deriver spawn",
    async () => {
      const value = await fixture(false, false, false, true);
      const qualityRoot = join(value.root, "disposable-prederive-rule-pack");
      await cp(value.selection.pack.qualityRoot, qualityRoot, {
        recursive: true,
        dereference: false,
      });
      value.selection = { ...value.selection, pack: { ...value.selection.pack, qualityRoot } };
      const rulePath = join(qualityRoot, "checks/quality_decision_policy.py");
      const log = join(value.root, "prederive-rule-spawns.log");
      const executable = join(value.root, "controlled-python3");
      await writeFile(
        executable,
        ["#!/bin/bash", "printf '%s\\n' \"$*\" >> '" + log + "'", 'exec python3 "$@"'].join("\n"),
        "utf8",
      );
      await chmod(executable, 0o700);
      value.host = new QualityValidatorHost({
        store: value.store,
        selection: value.selection,
        temporaryRoot: join(value.root, "validator-tmp"),
        executable,
        answerRecordsTestInjection: true,
      });
      const artifact = callerGuardCandidate(value);
      const calls = qualityAnswerRecordCalls(artifact, value.selection.profile);
      const derivationFailures: string[] = [];
      const derive = value.host.derive.bind(value.host);
      value.host.derive = async (input) => {
        // This entry point is reached only after the real runner/Pi path has
        // admitted the record batches. Rotate a disposable rule byte before the
        // canonical derivation integrity check runs.
        await appendFile(rulePath, "\n# post-admission integrity mutation\n", "utf8");
        try {
          return await derive(input);
        } catch (error) {
          if (error instanceof QualityDerivationError) derivationFailures.push(error.reason);
          throw error;
        }
      };

      const { record, bodies } = await runPiQualityRecordCalls(
        value,
        calls,
        artifact.reportMarkdown,
      );

      expect(record.status).toBe("failed");
      expect(derivationFailures).toEqual(["input-integrity"]);
      const spawns = await readFile(log, "utf8");
      expect(spawns).toContain("p.check_record(");
      expect(spawns).not.toContain("derive_documentation_quality_evaluation.py");
      expect(bodies.length).toBeGreaterThan(0);
    },
    testTimeoutMs(60_000),
  );

  it(
    "screens a credential registered after admission before the deriver spawn",
    async () => {
      const value = await fixture(false, false, false, true);
      const qualityRoot = join(value.root, "disposable-derive-screen-pack");
      await cp(value.selection.pack.qualityRoot, qualityRoot, {
        recursive: true,
        dereference: false,
      });
      value.selection = { ...value.selection, pack: { ...value.selection.pack, qualityRoot } };
      const sentinel = "derive-screen-rotation-fixture-20261009-3d1a8c";
      const artifact = callerGuardCandidate(value, " " + sentinel);
      const calls = qualityAnswerRecordCalls(artifact, value.selection.profile);
      const log = join(value.root, "derive-input-spawns.log");
      const executable = join(value.root, "controlled-python3");
      await writeFile(
        executable,
        ["#!/bin/bash", "printf '%s\\n' \"$*\" >> '" + log + "'", 'exec python3 "$@"'].join("\n"),
        "utf8",
      );
      await chmod(executable, 0o700);
      value.host = new QualityValidatorHost({
        store: value.store,
        selection: value.selection,
        temporaryRoot: join(value.root, "validator-tmp"),
        executable,
        answerRecordsTestInjection: true,
      });
      const derivationFailures: string[] = [];
      const derive = value.host.derive.bind(value.host);
      value.host.derive = async (input) => {
        expect(registerConfiguredCredential(sentinel, "derive input rotation fixture")).toBe(
          "screened",
        );
        try {
          return await derive(input);
        } catch (error) {
          if (error instanceof QualityDerivationError) derivationFailures.push(error.reason);
          throw error;
        }
      };

      const { record, bodies } = await runPiQualityRecordCalls(
        value,
        calls,
        artifact.reportMarkdown,
      );

      expect(record.status).toBe("failed");
      expect(derivationFailures).toEqual(["input-not-screened"]);
      expect(await readFile(log, "utf8")).not.toContain(
        "derive_documentation_quality_evaluation.py",
      );
      const toolText = bodies
        .flatMap((body) => (body.messages ?? []) as Array<Record<string, unknown>>)
        .filter((message) => message.role === "tool")
        .map((message) => String(message.content ?? ""))
        .join("\n");
      expect(toolText).not.toContain(sentinel);
    },
    testTimeoutMs(60_000),
  );

  it.each(["symlink", "directory", "oversize"] as const)(
    "rejects %s output returned by a real runner/Pi derivation",
    async (mutation) => {
      const value = await fixture(false, false, false, true);
      const qualityRoot = join(value.root, "disposable-output-pack-" + mutation);
      await cp(value.selection.pack.qualityRoot, qualityRoot, {
        recursive: true,
        dereference: false,
      });
      value.selection = { ...value.selection, pack: { ...value.selection.pack, qualityRoot } };
      const artifact = callerGuardCandidate(value);
      const calls = qualityAnswerRecordCalls(artifact, value.selection.profile);
      const log = join(value.root, "derive-output-spawns.log");
      const executable = join(value.root, "controlled-python3");
      const target = join(value.root, "symlink-target");
      // Match the symlink's lstat size (its target path length) so the
      // post-read byte-length check cannot mask removal of the pre-read
      // regular-file guard.
      await writeFile(target, "x".repeat(Buffer.byteLength(target, "utf8")), "utf8");
      const maxOutputBytes = limit("qualityValidator.maxDerivedArtifactBytes").value;
      const mutationCommand =
        mutation === "symlink"
          ? "ln -s '" + target + '\' "$output"'
          : mutation === "directory"
            ? 'mkdir "$output"'
            : "head -c " + String(maxOutputBytes + 1) + ' /dev/zero > "$output"';
      await writeFile(
        executable,
        [
          "#!/bin/bash",
          "printf '%s\\n' \"$*\" >> '" + log + "'",
          'if [[ "$1" == */derive_documentation_quality_evaluation.py ]]; then',
          '  output=""',
          '  previous=""',
          '  for arg in "$@"; do',
          '    if [[ "$previous" == "--output" ]]; then output="$arg"; fi',
          '    previous="$arg"',
          "  done",
          '  python3 "$@"',
          "  status=$?",
          '  rm -f "$output"',
          "  " + mutationCommand,
          '  exit "$status"',
          "fi",
          'exec python3 "$@"',
        ].join("\n"),
        "utf8",
      );
      await chmod(executable, 0o700);
      value.host = new QualityValidatorHost({
        store: value.store,
        selection: value.selection,
        temporaryRoot: join(value.root, "validator-tmp"),
        executable,
        answerRecordsTestInjection: true,
      });
      const derivationFailures: string[] = [];
      const derive = value.host.derive.bind(value.host);
      value.host.derive = async (input) => {
        try {
          return await derive(input);
        } catch (error) {
          if (error instanceof QualityDerivationError) derivationFailures.push(error.reason);
          throw error;
        }
      };

      const { record, bodies } = await runPiQualityRecordCalls(
        value,
        calls,
        artifact.reportMarkdown,
      );

      expect(record.status).toBe("failed");
      expect(derivationFailures).toEqual([
        mutation === "oversize" ? "output-oversize" : "output-not-regular",
      ]);
      expect(await readFile(log, "utf8")).toContain("derive_documentation_quality_evaluation.py");
      // The terminal derivation failure occurs while admitting the final batch,
      // before Pi asks for the later report-text turn.
      expect(bodies.length).toBe(Math.ceil(calls.length / 8));
    },
    testTimeoutMs(60_000),
  );
});

describe("answer-record caller lifecycle obligations", {
  timeout: testTimeoutMs(120_000),
}, () => {
  async function runCaller(input: {
    readonly value: QualityFixture;
    readonly artifact: ReturnType<typeof candidate>;
    readonly id: string;
    readonly technicalVerification?: VerificationResult;
    readonly extraTurns?: readonly (readonly {
      id: string;
      name: string;
      chunks: readonly string[];
    }[])[];
    readonly onSession?: (
      session: QualityAnswerRecordSessionV1,
      sessionInput: Parameters<QualityValidatorHost["createAnswerRecordSession"]>[0],
    ) => void | Promise<void>;
    readonly beforeSession?: (
      sessionInput: Parameters<QualityValidatorHost["createAnswerRecordSession"]>[0],
    ) => void;
  }) {
    input.artifact.selectionSha256 = input.value.selection.receipt.selectionSha256;
    const calls = qualityAnswerRecordCalls(input.artifact, input.value.selection.profile);
    const batches = Array.from({ length: Math.ceil(calls.length / 8) }, (_, index) =>
      calls.slice(index * 8, (index + 1) * 8),
    );
    const piHarness = toolPathHarness({
      maxProviderTurns: EXECUTION_LEASE_DEFAULTS.maxProviderTurns,
    });
    const bodies = recordingProvider([
      ...batches.map((batch) => rawToolCallTurn(batch)),
      ...(input.extraTurns ?? []).map((turn) => rawToolCallTurn(turn)),
      textTurn(input.artifact.reportMarkdown),
    ]);
    const createSession = input.value.host.createAnswerRecordSession.bind(input.value.host);
    let observedSession: QualityAnswerRecordSessionV1 | undefined;
    vi.spyOn(input.value.host, "createAnswerRecordSession").mockImplementation(
      async (sessionInput) => {
        input.beforeSession?.(sessionInput);
        const session = await createSession(sessionInput);
        observedSession = session;
        await input.onSession?.(session, sessionInput);
        return session;
      },
    );
    const technical = input.technicalVerification ?? technicalVerification();
    const harness: AgentHarness = {
      qualityAnswerRecordRouteBindingSha256: () => "f".repeat(64),
      qualityAnswerRecordProviderId: () => piHarness.qualityAnswerRecordProviderId(),
      runStep: async (stepInput) => {
        if (stepInput.step.skill === "evaluate-document-quality")
          return await piHarness.runStep(stepInput);
        if (stepInput.step.skill === "verify-technical-accuracy")
          return await technicalPhaseFixture(stepInput, technical);
        if (stepInput.step.skill === "review-documentation")
          return { summary: JSON.stringify({ verdict: "pass", issues: [] }) };
        return { summary: `${stepInput.step.skill} completed` };
      },
    };
    const record = await new WorkflowRunner({
      harness,
      hostOperations: {
        runStep: async (stepInput) => ({ summary: `${stepInput.step.skill} completed` }),
      },
      store: new MemoryStore(),
      ...qualityRunnerOptions(input.value),
      id: () => input.id,
    }).run(reviewRunRequest(input.value));
    return { record, bodies, calls, session: observedSession };
  }

  it("retains records until the admitted technical facts are represented before closure", async () => {
    const value = await fixture(false, false, false, false, false, true);
    const incompleteArtifact = candidate(value.selection.profile, value.revision, [
      tracedFinding(),
    ]);
    incompleteArtifact.selectionSha256 = value.selection.receipt.selectionSha256;
    addTechnicalTrace(incompleteArtifact);
    incompleteArtifact.evaluation.limitations = [];
    const incompleteCalls = qualityAnswerRecordCalls(incompleteArtifact, value.selection.profile);

    const completeArtifact = candidate(value.selection.profile, value.revision, [
      { ...tracedFinding(), originating_ids: ["FACT-TRACE-001"] },
    ]);
    completeArtifact.selectionSha256 = value.selection.receipt.selectionSha256;
    const completeCalls = qualityAnswerRecordCalls(completeArtifact, value.selection.profile);
    const findingCall = completeCalls.find(
      (call) => (JSON.parse(call.chunks[0]!) as { type?: unknown }).type === "finding",
    )!;
    const scoreCall = completeCalls.find(
      (call) => (JSON.parse(call.chunks[0]!) as { type?: unknown }).type === "quality-score",
    )!;
    const extraTurns = [
      [
        { ...findingCall, id: "trace-repair-finding" },
        { ...scoreCall, id: "trace-repair-score" },
      ],
    ];
    const technical = technicalVerification();
    const reason480 = "r".repeat(480);
    const reason2048 = "s".repeat(2048);
    expect(reason480).toHaveLength(480);
    expect(reason2048).toHaveLength(2048);
    const unverifiedDimensions = technical.factInventory.dimensions.filter(
      (dimension) =>
        dimension.dimension === "environment-prerequisite" ||
        dimension.dimension === "error-status-retry",
    );
    expect(unverifiedDimensions).toHaveLength(2);
    unverifiedDimensions[0]!.status = "unverified";
    unverifiedDimensions[0]!.reason = reason480;
    unverifiedDimensions[1]!.status = "unverified";
    unverifiedDimensions[1]!.reason = reason2048;
    const limitation512 = "a".repeat(512);
    const limitation513 = "b".repeat(513);
    const multilineLimitation = "First line.\r\nSecond line.\u0001control\u0085next\u2028last.";
    technical.factInventory.limitations = [
      limitation512,
      limitation513,
      multilineLimitation,
      reason480,
      reason2048,
    ];
    let finalCandidate: QualityArtifactCandidateV1 | undefined;
    let finalReport: string | undefined;
    let admittedVerification: VerificationResult | undefined;
    const validateOriginal = value.host.validate.bind(value.host);
    const validate = vi.spyOn(value.host, "validate").mockImplementation(async (input) => {
      const result = await validateOriginal(input);
      finalCandidate = input.candidate;
      finalReport = result.reportMarkdown;
      return result;
    });

    const result = await runCaller({
      value,
      artifact: incompleteArtifact,
      id: "quality-record-trace-closure",
      extraTurns,
      technicalVerification: technical,
      beforeSession: (sessionInput) => {
        admittedVerification = sessionInput.technicalVerification;
      },
    });

    expect(result.record.status).toBe("succeeded");
    expect(answerRecordReceiptFor(result.bodies, scoreCall.id)).toMatchObject({
      status: "refused",
      code: "technical-trace-missing-fact-id",
      retry: "model-correctable",
    });
    const refusal = answerRecordReceiptFor(result.bodies, scoreCall.id)!;
    expect(String(refusal.feedback)).toContain("FACT-TRACE-001");
    expect(String(refusal.feedback)).toContain("record.originating_ids");
    expect(String(refusal.feedback)).toContain("prose alone does not establish");
    expect(answerRecordReceiptFor(result.bodies, "trace-repair-score")).toMatchObject({
      status: "admitted",
      complete: true,
    });
    const index = await result.session?.snapshotIndex();
    expect(index?.rows.map(({ type }) => type)).toContain("finding");
    expect(index?.rows.map(({ type, key }) => `${type}:${key}`)).toContain(
      "target-judgment:singleton",
    );

    expect(admittedVerification).toBeDefined();
    const hostLimitations = [
      ...admittedVerification!.factInventory.limitations,
      ...admittedVerification!.factInventory.dimensions
        .filter((dimension) => dimension.status === "unverified")
        .map(
          (dimension) => `Host records ${dimension.dimension} as unverified: ${dimension.reason}`,
        ),
    ];
    const initialWire = JSON.stringify(incompleteCalls);
    for (const limitation of hostLimitations) expect(initialWire).not.toContain(limitation);
    const candidateLimitations = finalCandidate?.evaluation.limitations;
    expect(
      hostLimitations.filter((limitation) => !candidateLimitations?.includes(limitation)),
      JSON.stringify({ hostLimitations, candidateLimitations }),
    ).toEqual([]);
    expect(finalReport).toBeDefined();
    const reportLimitations = validatedSummary(finalReport!).limitations;
    expect(
      hostLimitations.filter((limitation) => !reportLimitations.includes(limitation)),
      JSON.stringify({ hostLimitations, reportLimitations }),
    ).toEqual([]);
    const projection = projectQualityReportFromRun(result.record);
    expect(projection?.schemaVersion).toBe(2);
    expect(projection?.limitations).toEqual(expect.arrayContaining(hostLimitations));
    if (!projection) throw new Error("Expected a validated quality report projection.");
    const decodedProjection = decodeQualityReportProjection(projection);
    if (projection.schemaVersion !== 2) {
      throw new Error("Expected a V2 quality report projection.");
    }
    expect(decodedProjection).toMatchObject({
      schemaVersion: 2,
      limitations: [...projection.limitations].sort(),
      unclassifiedLimitations: [...projection.unclassifiedLimitations].sort(),
    });
    expect(finalReport).toContain("- Limitation (JSON):");
    const encodedMultiline = JSON.stringify(multilineLimitation)
      .replace(/\u0085/gu, "\\u0085")
      .replace(/\u2028/gu, "\\u2028")
      .replace(/\u2029/gu, "\\u2029");
    expect(finalReport).toContain(`- Limitation (JSON): ${encodedMultiline}`);
    expect(reportLimitations).toContain(limitation512);
    expect(reportLimitations).toContain(limitation513);
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it("M6 replaces a finding through Pi and retains the old sealed digest", async () => {
    const value = await fixture(false, false, false, true);
    const artifact = candidate(value.selection.profile, value.revision);
    addTechnicalTrace(artifact);
    const initialFinding = (artifact.evaluation.findings as Array<Record<string, unknown>>)[0]!;
    initialFinding.originating_ids = ["FACT-TRACE-001", "TECH-001"];
    initialFinding.description = "The source-backed concern before replacement.";
    const baseCalls = qualityAnswerRecordCalls(artifact, value.selection.profile);
    const findingCall = baseCalls.find((call) => {
      const parsed = JSON.parse(call.chunks[0]!) as { type?: unknown };
      return parsed.type === "finding";
    })!;
    const originalEnvelope = JSON.parse(findingCall.chunks[0]!) as {
      type: string;
      record: Record<string, unknown>;
    };
    const replacement = {
      ...originalEnvelope.record,
      description: "The source-backed concern after same-attempt replacement.",
    };
    const replaceCall = {
      id: "m6-replace-f1",
      name: QUALITY_ANSWER_RECORD_TOOL_NAME,
      chunks: [JSON.stringify({ type: "finding", key: "F-1", record: replacement })],
    };
    const snapshots: Array<{ digest: string; state: string }> = [];
    const result = await runCaller({
      value,
      artifact,
      id: "quality-record-caller-m6",
      extraTurns: [[replaceCall]],
      onSession: (session) => {
        const settle = session.capability.settle.bind(session.capability);
        session.capability.settle = async (settlement) => {
          await settle(settlement);
          const row = (await session.snapshotIndex())?.rows.find(
            (item) => item.type === "finding" && item.key === "F-1",
          );
          if (row) snapshots.push({ digest: row.recordSha256, state: row.state });
        };
      },
    });
    const step = result.record.steps.find((item) => item.skill === "evaluate-document-quality");
    expect(result.record.status).toBe("succeeded");
    expect(step?.status).toBe("succeeded");
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    const originalDigest = snapshots[0]!.digest;
    const latestDigest = snapshots.at(-1)!.digest;
    expect(latestDigest).not.toBe(originalDigest);
    const oldRow = await value.store.getRecord(originalDigest);
    expect(oldRow).toMatchObject({ state: "admitted", type: "finding", key: "F-1", attempt: 1 });
    expect((oldRow as { payload: Record<string, unknown> }).payload.description).toBe(
      "The source-backed concern before replacement.",
    );
    const index = step?.answerRecordLedger;
    expect(index).toBeDefined();
    if (!index) throw new Error("caller result omitted the answer-record index");
    expect(index.rows).toContainEqual({
      type: "finding",
      key: "F-1",
      recordSha256: latestDigest,
      state: "admitted",
      attempt: 1,
    });
    expect(
      result.bodies
        .flatMap((body) => (body.messages ?? []) as Array<Record<string, unknown>>)
        .filter((message) => message.role === "tool" && message.tool_call_id === "m6-replace-f1")
        .some((message) => JSON.parse(String(message.content)).status === "replaced"),
    ).toBe(true);
  });

  it("retains answer-record recovery fields when final report validation declines the report", async () => {
    const value = await fixture(false, false, false, true);
    const artifact = candidate(value.selection.profile, value.revision);
    addTechnicalTrace(artifact);
    const finding = (artifact.evaluation.findings as Array<Record<string, unknown>>)[0]!;
    finding.originating_ids = ["FACT-TRACE-001", "TECH-001"];
    artifact.reportMarkdown +=
      "\n\n## Evidence gaps and limitations\n\n- Limitation: duplicate section must be refused.";
    let finishCalled = false;
    let finishedReport = "";
    let finishedIndex:
      | Awaited<ReturnType<QualityAnswerRecordSessionV1["finish"]>>["index"]
      | undefined;
    const result = await runCaller({
      value,
      artifact,
      id: "quality-record-report-refusal-retains-checkpoint",
      onSession: (session) => {
        const finish = session.finish.bind(session);
        vi.spyOn(session, "finish").mockImplementation(async (reportMarkdown) => {
          const assembled = await finish(reportMarkdown);
          finishCalled = true;
          finishedReport = reportMarkdown;
          finishedIndex = assembled.index;
          return assembled;
        });
      },
    });
    const step = result.record.steps.find((item) => item.skill === "evaluate-document-quality");
    expect(finishCalled).toBe(true);
    expect(finishedReport).toBe(artifact.reportMarkdown);
    expect(finishedReport.match(/^## Evidence gaps and limitations$/gmu)).toHaveLength(2);
    expect(result.record.status).toBe("succeeded");
    expect(result.record.qualityArtifactValidation).toBeUndefined();
    expect(step?.qualityValidationRejection).toEqual({
      validator: "report-finalization",
      code: "report-limitation-section-count",
      location: "$.limitations",
      issueCount: 1,
    });
    expect(step?.status).toBe("succeeded");
    expect(step?.summary).toContain(QUALITY_REPORT_DECLINE_STEM);
    expect(finishedIndex?.checkpoint).toBeDefined();
    expect(finishedIndex?.progress?.complete).toBe(true);
    expect(step?.answerRecordLedger?.checkpoint).toEqual(finishedIndex?.checkpoint);
    expect(step?.answerRecordLedger?.progress).toEqual(finishedIndex?.progress);
    expect(step?.answerRecordLedger?.checkpoint).toBeDefined();
    expect(step?.answerRecordLedger?.progress).toMatchObject({
      complete: true,
      admittedRowCount: expect.any(Number),
    });
    expect(step?.answerRecordLedger?.rows.some((row) => row.type === "finding")).toBe(true);
  });

  it("M8 preserves host-issued finding order after an open-set withdrawal and reintroduction", async () => {
    const value = await fixture(false, false, false, true);
    const artifact = candidate(value.selection.profile, value.revision);
    addTechnicalTrace(artifact);
    const first = (artifact.evaluation.findings as Array<Record<string, unknown>>)[0]!;
    first.originating_ids = ["FACT-TRACE-001", "TECH-001"];
    first.description = "Host-issued finding F-1 before withdrawal.";
    const second: Record<string, unknown> = {
      ...structuredClone(first),
      description: "Host-issued finding F-2 remains admitted.",
    };
    artifact.evaluation.findings = [first, second];
    const baseCalls = qualityAnswerRecordCalls(artifact, value.selection.profile);
    const findingCall = baseCalls.find((call) => {
      const parsed = JSON.parse(call.chunks[0]!) as { type?: unknown; record?: unknown };
      return parsed.type === "finding" && parsed.record !== null;
    })!;
    const original = JSON.parse(findingCall.chunks[0]!) as {
      type: string;
      record: Record<string, unknown>;
    };
    const replacement = {
      ...original.record,
      description: "Host-issued finding F-1 after withdrawal and reintroduction.",
    };
    const withdrawal = {
      id: "m8-withdraw-f1",
      name: QUALITY_ANSWER_RECORD_TOOL_NAME,
      chunks: [JSON.stringify({ type: "finding", key: "F-1", record: "null" })],
    };
    const reintroduction = {
      id: "m8-reintroduce-f1",
      name: QUALITY_ANSWER_RECORD_TOOL_NAME,
      chunks: [JSON.stringify({ type: "finding", key: "F-1", record: replacement })],
    };
    const snapshots: Array<{ readonly keys: string[]; readonly f1Digest?: string }> = [];
    const result = await runCaller({
      value,
      artifact,
      id: "quality-record-caller-m8",
      extraTurns: [[withdrawal], [reintroduction]],
      onSession: (session) => {
        const settle = session.capability.settle.bind(session.capability);
        session.capability.settle = async (settlement) => {
          await settle(settlement);
          const rows = (await session.snapshotIndex())?.rows ?? [];
          snapshots.push({
            keys: rows.filter((row) => row.type === "finding").map((row) => row.key),
            f1Digest: rows.find((row) => row.type === "finding" && row.key === "F-1")?.recordSha256,
          });
        };
      },
    });
    const step = result.record.steps.find((item) => item.skill === "evaluate-document-quality");
    expect(result.record.status).toBe("succeeded");
    expect(step?.status).toBe("succeeded");
    const initialF1 = snapshots.find((snapshot) => snapshot.f1Digest)?.f1Digest;
    const finalF1 = snapshots.at(-1)?.f1Digest;
    expect(initialF1).toBeDefined();
    expect(snapshots.some((snapshot) => snapshot.keys.includes("F-2") && !snapshot.f1Digest)).toBe(
      true,
    );
    expect(finalF1).toBeDefined();
    expect(finalF1).not.toBe(initialF1);
    const oldRow = await value.store.getRecord(initialF1!);
    expect(oldRow).toMatchObject({ state: "admitted", type: "finding", key: "F-1", attempt: 1 });
    expect((oldRow as { payload: Record<string, unknown> }).payload.description).toBe(
      "Host-issued finding F-1 before withdrawal.",
    );
    const ledger = step?.answerRecordLedger;
    const findingRows = ledger?.rows.filter((row) => row.type === "finding") ?? [];
    expect(findingRows).toHaveLength(2);
    expect(Object.fromEntries(findingRows.map((row) => [row.key, row]))).toMatchObject({
      "F-1": { recordSha256: finalF1, state: "admitted", attempt: 1 },
      "F-2": { state: "admitted", attempt: 1 },
    });
    const persistedFindingPayloads = await Promise.all(
      findingRows.map(async (row) => {
        const stored = await value.store.getRecord(row.recordSha256);
        if (!stored || typeof stored !== "object" || !("payload" in stored)) {
          throw new Error("Expected the final finding row to be durably stored.");
        }
        return (stored as { payload: Record<string, unknown> }).payload;
      }),
    );
    expect(persistedFindingPayloads.map((payload) => payload.originating_ids)).toEqual([
      ["FACT-TRACE-001", "TECH-001"],
      ["FACT-TRACE-001", "TECH-001"],
    ]);
    const staged = await loadStagedQualityArtifact(
      value.store,
      result.record.qualityArtifactValidation!.artifacts.evaluation!.recordSha256,
    );
    const findings = (staged.payload as { findings: Array<Record<string, unknown>> }).findings;
    const modelEvidence = (first.evidence as Array<Record<string, unknown>>)[0];
    const actualProjection = findings.map((finding) => ({
      id: finding.id,
      owner: finding.owner,
      status: finding.status,
      severity: finding.severity,
      dimension_id: finding.dimension_id,
      description: finding.description,
      acceptance_condition: finding.acceptance_condition,
      firstEvidence: (finding.evidence as Array<Record<string, unknown>>)[0],
    }));
    const expectedProjection = [
      {
        id: "F-1",
        owner: "documentation-owner",
        status: "open",
        severity: first.severity,
        dimension_id: first.dimension_id,
        description: "Host-issued finding F-1 after withdrawal and reintroduction.",
        acceptance_condition: first.acceptance_condition,
        firstEvidence: modelEvidence,
      },
      {
        id: "F-2",
        owner: "documentation-owner",
        status: "open",
        severity: second.severity,
        dimension_id: second.dimension_id,
        description: "Host-issued finding F-2 remains admitted.",
        acceptance_condition: second.acceptance_condition,
        firstEvidence: modelEvidence,
      },
    ];
    const differingPaths = historicalDifferencePaths(actualProjection, expectedProjection);
    expect(
      actualProjection,
      `M8 finding projection differs at ${differingPaths.join(", ")}; ` +
        `actual=${JSON.stringify(actualProjection)} expected=${JSON.stringify(expectedProjection)}`,
    ).toEqual(expectedProjection);
  });

  it(
    "refuses a withdrawn finding reintroduced when the open-set capacity is full",
    async () => {
      const value = await fixture(false, false, false, true);
      const artifact = candidate(value.selection.profile, value.revision);
      addTechnicalTrace(artifact);
      const first = (artifact.evaluation.findings as Array<Record<string, unknown>>)[0]!;
      first.originating_ids = ["FACT-TRACE-001", "TECH-001"];
      first.description = "Host-issued finding F-1 before bounded reintroduction.";
      const second = {
        ...structuredClone(first),
        description: "Host-issued finding F-2 remains in the full open set.",
      };
      artifact.evaluation.findings = [first, second];
      const baseCalls = qualityAnswerRecordCalls(artifact, value.selection.profile);
      const findingCall = baseCalls.find((call) => {
        const parsed = JSON.parse(call.chunks[0]!) as { type?: unknown; record?: unknown };
        return parsed.type === "finding" && parsed.record !== null;
      })!;
      const modelFinding = JSON.parse(findingCall.chunks[0]!) as {
        type: string;
        record: Record<string, unknown>;
      };
      const third = {
        ...structuredClone(modelFinding.record),
        description: "Host-issued finding F-3 replaces the withdrawn capacity slot.",
      };
      const withdrawal = {
        id: "open-set-withdraw-f1",
        name: QUALITY_ANSWER_RECORD_TOOL_NAME,
        chunks: [JSON.stringify({ type: "finding", key: "F-1", record: "null" })],
      };
      const fillFreedSlot = {
        id: "open-set-add-f3",
        name: QUALITY_ANSWER_RECORD_TOOL_NAME,
        chunks: [JSON.stringify({ type: "finding", record: third })],
      };
      const reintroduction = {
        id: "open-set-reintroduce-f1",
        name: QUALITY_ANSWER_RECORD_TOOL_NAME,
        chunks: [
          JSON.stringify({
            type: "finding",
            key: "F-1",
            record: {
              ...structuredClone(modelFinding.record),
              description: "Host-issued finding F-1 must not return above the open-set bound.",
            },
          }),
        ],
      };
      const store = vi.spyOn(value.store, "putRecord");
      const originalLimit = limitsModule.limit.bind(limitsModule);
      const limitOverride = vi.spyOn(limitsModule, "limit").mockImplementation((name, options) => {
        const resolved = originalLimit(name, options);
        return name === "answerRecords.maxOpenRecordsPerSet" ? { ...resolved, value: 2 } : resolved;
      });
      let result: Awaited<ReturnType<typeof runCaller>>;
      try {
        result = await runCaller({
          value,
          artifact,
          id: "quality-record-caller-open-set-reintroduction-bound",
          extraTurns: [[withdrawal], [fillFreedSlot], [reintroduction]],
        });
      } finally {
        limitOverride.mockRestore();
      }

      expect(result.session).toBeDefined();
      expect(answerRecordReceiptFor(result.bodies, withdrawal.id)).toMatchObject({
        status: "withdrawn",
        type: "finding",
        key: "F-1",
      });
      expect(answerRecordReceiptFor(result.bodies, fillFreedSlot.id)).toMatchObject({
        status: "admitted",
        type: "finding",
        key: "F-3",
      });
      expect(answerRecordReceiptFor(result.bodies, reintroduction.id)).toMatchObject({
        status: "refused",
        type: "finding",
        key: "F-1",
        code: "answer-record-open-set-bound",
      });
      const step = result.record.steps.find((item) => item.skill === "evaluate-document-quality");
      expect(result.record.status).toBe("succeeded");
      const findings = step?.answerRecordLedger?.rows.filter((row) => row.type === "finding") ?? [];
      expect(findings.map((row) => row.key)).toEqual(["F-2", "F-3"]);
      const durableRows = await Promise.all(
        findings.map((row) => value.store.getRecord(row.recordSha256)),
      );
      expect(durableRows.every((row) => row !== undefined)).toBe(true);
      expect(
        durableRows.map((row) => (row as { payload: Record<string, unknown> }).payload.description),
      ).toEqual([second.description, third.description]);
      expect(
        store.mock.calls.some(([, row]) =>
          JSON.stringify(row).includes("must not return above the open-set bound"),
        ),
      ).toBe(false);
    },
    testTimeoutMs(60_000),
  );

  it("M7 fails final assembly when an admitted technical link becomes unresolved", async () => {
    const value = await fixture(false, false, false, true);
    const artifact = candidate(value.selection.profile, value.revision);
    addTechnicalTrace(artifact);
    (artifact.evaluation.findings as Array<Record<string, unknown>>)[0]!.originating_ids = [
      "FACT-TRACE-001",
      "TECH-001",
    ];
    let admittedFinding = false;
    let unresolvedAssembly = "not-observed";
    let finalReferenceRenderCalls = 0;
    let referenceInvalidations = 0;
    let finalAssembly = false;
    const result = await runCaller({
      value,
      artifact,
      id: "quality-record-caller-m7",
      beforeSession: (sessionInput) => {
        const originalRenderReference = sessionInput.renderReference;
        const mutableSessionInput = sessionInput as {
          renderReference: typeof sessionInput.renderReference;
        };
        mutableSessionInput.renderReference = (namespace, ids) => {
          if (finalAssembly) finalReferenceRenderCalls += 1;
          if (finalAssembly && admittedFinding && namespace === "technical-fact") {
            referenceInvalidations += 1;
            const refs = sessionInput.referenceIds as Record<string, string[]>;
            refs["technical-issue"] = (refs["technical-issue"] ?? []).filter(
              (id) => id !== "TECH-001",
            );
          }
          return originalRenderReference(namespace, ids);
        };
      },
      onSession: (session) => {
        const settle = session.capability.settle.bind(session.capability);
        session.capability.settle = async (settlement) => {
          await settle(settlement);
          const finding = (await session.snapshotIndex())?.rows.find(
            (row) => row.type === "finding" && row.key === "F-1",
          );
          if (!finding || admittedFinding) return;
          admittedFinding = true;
        };
        const prepare = session.capability.prepareBatch.bind(session.capability);
        session.capability.prepareBatch = async (batch) => {
          try {
            await prepare(batch);
          } catch (error) {
            if (error instanceof AnswerRecordHostError) unresolvedAssembly = error.message;
            throw error;
          }
        };
        const finish = session.finish.bind(session);
        session.finish = async (reportMarkdown) => {
          finalAssembly = true;
          try {
            return await finish(reportMarkdown);
          } catch (error) {
            if (error instanceof AnswerRecordHostError) unresolvedAssembly = error.message;
            throw error;
          }
        };
      },
    });
    const step = result.record.steps.find((item) => item.skill === "evaluate-document-quality");
    expect(admittedFinding).toBe(true);
    expect(referenceInvalidations).toBe(1);
    expect(finalReferenceRenderCalls).toBeGreaterThan(0);
    expect(result.record.status).toBe("failed");
    expect(unresolvedAssembly).toBe(
      "A finding link reached assembly unresolved in technical-fact, technical-issue, review-issue.",
    );
    expect(step?.failure?.code).toBeDefined();
    expect(step?.answerRecordLedger?.rows).toContainEqual(
      expect.objectContaining({ type: "finding", key: "F-1", state: "admitted", attempt: 1 }),
    );
    expect(result.record.qualityArtifactValidation?.status).not.toBe("passed");
  });

  it("M16 relays a whole-artifact completion refusal to its owning row and corrects it", async () => {
    const value = await fixture(false, false, false, true);
    const artifact = candidate(value.selection.profile, value.revision);
    addTechnicalTrace(artifact);
    (artifact.evaluation.findings as Array<Record<string, unknown>>)[0]!.originating_ids = [
      "FACT-TRACE-001",
      "TECH-001",
    ];
    const baseCalls = qualityAnswerRecordCalls(artifact, value.selection.profile);
    const dimensionCall = baseCalls.find((call) => {
      const parsed = JSON.parse(call.chunks[0]!) as { type?: unknown; key?: unknown };
      return parsed.type === "dimension" && typeof parsed.key === "string";
    })!;
    const scoreCall = baseCalls.find((call) => {
      const parsed = JSON.parse(call.chunks[0]!) as { type?: unknown };
      return parsed.type === "quality-score";
    })!;
    const parsedDimension = JSON.parse(dimensionCall.chunks[0]!) as {
      type: string;
      key: string;
      record: Record<string, unknown>;
    };
    const layerEntry = Object.entries(
      artifact.evaluation.layers as Record<string, { dimensions: Array<Record<string, unknown>> }>,
    ).find(([, layer]) =>
      layer.dimensions.some((dimension) => dimension.dimension_id === parsedDimension.key),
    );
    expect(layerEntry).toBeDefined();
    const dimensionIndex = layerEntry![1].dimensions.findIndex(
      (dimension) => dimension.dimension_id === parsedDimension.key,
    );
    const replacement = {
      ...parsedDimension.record,
      rationale: "Corrected after whole-artifact validation identified this owning record.",
    };
    const correction = {
      id: "m16-completion-owner-correction",
      name: QUALITY_ANSWER_RECORD_TOOL_NAME,
      chunks: [
        JSON.stringify({ type: "dimension", key: parsedDimension.key, record: replacement }),
      ],
    };
    const scoreCorrection = {
      ...scoreCall,
      id: "m16-completion-score-correction",
    };
    let completionCalls = 0;
    const validateCompletion = value.host.validateAnswerRecordCompletion.bind(value.host);
    vi.spyOn(value.host, "validateAnswerRecordCompletion").mockImplementation(async (input) => {
      completionCalls += 1;
      if (completionCalls === 1) {
        return {
          status: "refused",
          code: "evaluation-schema-required",
          location: `$.layers.${layerEntry![0]}.dimensions[${dimensionIndex}].rationale`,
        };
      }
      return await validateCompletion(input);
    });
    const result = await runCaller({
      value,
      artifact,
      id: "quality-record-caller-m16",
      extraTurns: [[correction, scoreCorrection]],
    });
    const step = result.record.steps.find((item) => item.skill === "evaluate-document-quality");
    expect(result.record.status).toBe("succeeded");
    expect(step?.status).toBe("succeeded");
    expect(completionCalls).toBeGreaterThanOrEqual(2);
    const toolMessages = result.bodies
      .flatMap((body) => (body.messages ?? []) as Array<Record<string, unknown>>)
      .filter((message) => message.role === "tool" && typeof message.content === "string");
    const refusal = toolMessages
      .map((message) => JSON.parse(String(message.content)) as Record<string, unknown>)
      .find(
        (receipt) => receipt.status === "refused" && receipt.code === "evaluation-schema-required",
      );
    expect(refusal).toMatchObject({
      status: "refused",
      type: "dimension",
      key: parsedDimension.key,
      location: `$.layers.${layerEntry![0]}.dimensions[${dimensionIndex}].rationale`,
    });
    expect(refusal?.remaining).toEqual([`dimension:${parsedDimension.key}`, "quality-score"]);
    const correctionReceipt = toolMessages.find(
      (message) => message.tool_call_id === correction.id,
    );
    expect(JSON.parse(String(correctionReceipt?.content)).status).toMatch(/admitted|replaced/u);
    expect(step?.answerRecordLedger?.rows).toContainEqual(
      expect.objectContaining({
        type: "dimension",
        key: parsedDimension.key,
        state: "admitted",
        attempt: 1,
      }),
    );
    expect(step?.answerRecordLedger?.rows).toContainEqual(
      expect.objectContaining({ type: "quality-score", state: "admitted", attempt: 1 }),
    );
  });
});
