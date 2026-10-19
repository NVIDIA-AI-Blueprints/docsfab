// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";

import type { ModelEvidence, RunStatus } from "./records/contracts.js";
import type { SecurityScanEffectiveStatus } from "./security/contracts.js";
import type { WorkflowName } from "./workflow-contracts/contracts.js";
import {
  ACCEPTANCE_CHECK_LIMITATIONS_VARIABLE,
  acceptanceCheckLimitationCauses,
  applicableAcceptanceCheckLimitations,
  type AcceptanceCheckLimitation,
  type HostRootOwnership,
} from "./acceptance-check-limitations.js";
import { ACCEPTANCE_OFFLINE_NAMES } from "./config/env-admission.generated.js";
import { assertApprovedJudgeDestination, normalizeApprovedHttpsUrl } from "./judge-destination.js";
import { parseJudgeResultArtifact } from "./judge-result-artifact.js";
import { validModelEvidenceProjection } from "./model/profile-evidence.js";
import {
  isFailureCode,
  readFailureClassification,
  type FailureClassificationV1,
} from "./operator/failure-class.js";
import {
  containsAssignedCredential,
  containsCatalogCredential,
  redactCredentialMaterial,
} from "./security/credential-material.js";
import { isWorkflowName, listWorkflows } from "./workflow-registry/catalog.js";
import { isPlainRecord } from "./shared/primitives.js";

export type AcceptanceStatus = "passed" | "failed" | "skipped";
export type ModelProfileStatus = "current" | "stale" | "unknown";

export interface AcceptanceCommand {
  file: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  /** Host-authored intent used to collect narrowly scoped acceptance diagnostics. */
  diagnosticProfile?: "runtime-check";
}

export interface AcceptanceCommandResult {
  exitCode: number;
  diagnostic?: AcceptanceCommandDiagnostic;
}

export interface AcceptanceCommandDiagnostic {
  termination: "exit" | "signal" | "spawn-error";
  signal?: NodeJS.Signals;
  script?: string;
  testFile?: string;
}

export type AcceptanceExecutor = (command: AcceptanceCommand) => Promise<AcceptanceCommandResult>;

export interface AcceptancePhase {
  id:
    | "clean-install"
    | "check"
    | "build"
    | "catalog"
    | "offline-doctor"
    | "live-doctor"
    | "live-fixture-readiness"
    | "live-self-readiness"
    | "judge-smoke";
  networked: boolean;
  enabled: boolean;
  gate?: string;
  commands: AcceptanceCommand[];
  /** Test files the check phase leaves out on this run, each with its measured cause. */
  limitations?: AcceptanceCheckLimitation[];
}

export interface AcceptancePhaseResult {
  id: AcceptancePhase["id"] | "setup" | "evidence" | "source-integrity" | "workspace-cleanup";
  status: AcceptanceStatus;
  networked: boolean;
  commit: string;
  modelProfileStatus: ModelProfileStatus;
  judgeProfileStatus?: ModelProfileStatus;
  durationMs: number;
  reason?: string;
  diagnostic?: AcceptanceCommandDiagnostic;
}

export interface AcceptanceRunRecordSummary {
  file: string;
  sha256: string;
  id: string;
  workflow: WorkflowName;
  status: RunStatus;
  revision: string;
  scanDisposition?: SecurityScanEffectiveStatus;
  ruleIds: string[];
  models: Array<{ provider: string; model: string; profileSha256?: string }>;
}

export interface AcceptancePlanInput {
  repositoryRoot: string;
  workspaceRoot: string;
  fixtureRoot: string;
  stateDirectory: string;
  evidenceDirectory: string;
  acceptanceId: string;
  revision: string;
  sourceTree: string;
  live: boolean;
  judge: boolean;
  judgeProfileStatus: ModelProfileStatus;
  now: Date;
  offlineEnvironment: NodeJS.ProcessEnv;
  /** Credential-free environment for local Git setup commands. */
  localEnvironment: NodeJS.ProcessEnv;
  /** Policy-model environment; judge configuration is disabled and absent. */
  policyEnvironment: NodeJS.ProcessEnv;
  /** Separately gated judge environment. */
  judgeEnvironment: NodeJS.ProcessEnv;
  offlineCommandPrefix?: string[];
  localCommandPrefix?: string[];
  /** Owner of `/` outside the offline sandbox and inside it, when the sandbox was probed. */
  hostRootOwner?: HostRootOwnership;
}

function command(
  cwd: string,
  environment: NodeJS.ProcessEnv,
  file: string,
  ...args: string[]
): AcceptanceCommand {
  return { file, args, cwd, environment };
}

function offlineCommand(
  input: AcceptancePlanInput,
  file: string,
  ...args: string[]
): AcceptanceCommand {
  const prefix = input.offlineCommandPrefix ?? [];
  return prefix.length > 0
    ? command(
        input.workspaceRoot,
        input.offlineEnvironment,
        prefix[0]!,
        ...prefix.slice(1),
        file,
        ...args,
      )
    : command(input.workspaceRoot, input.offlineEnvironment, file, ...args);
}

function localCommand(
  input: AcceptancePlanInput,
  cwd: string,
  file: string,
  ...args: string[]
): AcceptanceCommand {
  const prefix = input.localCommandPrefix ?? [];
  return prefix.length > 0
    ? command(cwd, input.localEnvironment, prefix[0]!, ...prefix.slice(1), file, ...args)
    : command(cwd, input.localEnvironment, file, ...args);
}

export function createAcceptancePlan(input: AcceptancePlanInput): AcceptancePhase[] {
  const offline = input.offlineEnvironment;
  const policy = input.policyEnvironment;
  const judge = input.judgeEnvironment;
  const cli = ["dist/cli.js"];
  const checkLimitations = applicableAcceptanceCheckLimitations({
    networkDenied: (input.offlineCommandPrefix ?? []).length > 0,
    ...(input.hostRootOwner ? { hostRootOwner: input.hostRootOwner } : {}),
  });
  const checkEnvironment = repositoryCheckEnvironment(offline);
  if (checkLimitations.length > 0) {
    checkEnvironment[ACCEPTANCE_CHECK_LIMITATIONS_VARIABLE] =
      acceptanceCheckLimitationCauses(checkLimitations);
  }
  // Each networked DocsFab command reports a failure as JSON, so the harness can
  // summarize it from structured fields without keeping its raw output.
  const structuredFailure = "--json";
  // The whole-repository credential scan is advisory only: a live self-run
  // needs no scanner exemption even though DocsFab tracks deliberate
  // credential-shaped fixtures.
  const selfArguments = [
    ...cli,
    "run",
    "readiness",
    "--repo",
    input.repositoryRoot,
    "--revision",
    input.revision,
    structuredFailure,
  ];

  return [
    {
      id: "clean-install",
      networked: false,
      enabled: true,
      commands: [
        offlineCommand(
          {
            ...input,
            offlineEnvironment: { ...offline, npm_config_offline: "true" },
          },
          "npm",
          "ci",
          "--offline",
          "--ignore-scripts",
        ),
      ],
    },
    {
      id: "check",
      networked: false,
      enabled: true,
      commands: [
        {
          ...offlineCommand(
            { ...input, offlineEnvironment: checkEnvironment },
            "npm",
            "run",
            "check",
          ),
          diagnosticProfile: "runtime-check",
        },
      ],
      limitations: checkLimitations,
    },
    {
      id: "build",
      networked: false,
      enabled: true,
      commands: [offlineCommand(input, "npm", "run", "build")],
    },
    {
      id: "catalog",
      networked: false,
      enabled: true,
      commands: [
        offlineCommand(input, "node", ...cli, "list"),
        ...listWorkflows().map((workflow) =>
          offlineCommand(input, "node", ...cli, "plan", workflow.name),
        ),
      ],
    },
    {
      id: "offline-doctor",
      networked: false,
      enabled: true,
      commands: [
        offlineCommand(
          {
            ...input,
            offlineEnvironment: {
              ...input.offlineEnvironment,
              DOCSFAB_ACCEPTANCE_EXPORT_DOCTOR: "true",
            },
          },
          "node",
          "dist/acceptance-export-doctor.js",
          "--expected-revision",
          input.revision,
          "--expected-tree",
          input.sourceTree,
        ),
      ],
    },
    {
      id: "live-doctor",
      networked: true,
      enabled: input.live,
      gate: "live provider gate not enabled",
      commands: [
        command(
          input.workspaceRoot,
          { ...policy, DOCSFAB_ACCEPTANCE_EXPORT_DOCTOR: "true" },
          "node",
          "dist/acceptance-export-doctor.js",
          "--expected-revision",
          input.revision,
          "--expected-tree",
          input.sourceTree,
          "--live",
          structuredFailure,
        ),
      ],
    },
    {
      id: "live-fixture-readiness",
      networked: true,
      enabled: input.live,
      gate: "live provider gate not enabled",
      commands: [
        localCommand(input, input.fixtureRoot, "git", "init"),
        localCommand(
          input,
          input.fixtureRoot,
          "git",
          "config",
          "user.email",
          "docsfab@example.test",
        ),
        localCommand(input, input.fixtureRoot, "git", "config", "user.name", "DocsFab Acceptance"),
        localCommand(input, input.fixtureRoot, "git", "config", "commit.gpgsign", "false"),
        localCommand(input, input.fixtureRoot, "git", "add", "."),
        localCommand(input, input.fixtureRoot, "git", "commit", "-m", "acceptance fixture"),
        command(
          input.workspaceRoot,
          policy,
          "node",
          ...cli,
          "run",
          "readiness",
          "--repo",
          input.fixtureRoot,
          "--revision",
          "HEAD",
          structuredFailure,
        ),
      ],
    },
    {
      id: "live-self-readiness",
      networked: true,
      enabled: input.live,
      gate: "live provider gate not enabled",
      commands: [command(input.workspaceRoot, policy, "node", ...selfArguments)],
    },
    {
      id: "judge-smoke",
      networked: true,
      enabled: input.judge,
      gate: "separately approved judge gate not enabled",
      commands: [
        command(
          input.workspaceRoot,
          {
            ...judge,
            DOCSFAB_LIVE_JUDGE_SMOKE: "true",
            DOCSFAB_LIVE_JUDGE_RESULT: `${input.evidenceDirectory}/judge-result.json`,
          },
          "node",
          "dist/acceptance-judge.js",
          "--state-dir",
          input.stateDirectory,
          "--result",
          `${input.evidenceDirectory}/judge-result.json`,
          "--acceptance-id",
          input.acceptanceId,
          "--commit",
          input.revision,
          "--profile-status",
          input.judgeProfileStatus,
          structuredFailure,
        ),
      ],
    },
  ];
}

export async function executeAcceptancePlan(
  phases: readonly AcceptancePhase[],
  executor: AcceptanceExecutor,
  context: {
    commit: string;
    modelProfileStatus: ModelProfileStatus;
    judgeProfileStatus?: ModelProfileStatus;
    now?: () => number;
  },
): Promise<AcceptancePhaseResult[]> {
  const clock = context.now ?? Date.now;
  const results: AcceptancePhaseResult[] = [];
  let priorFailure = false;

  for (const phase of phases) {
    const startedAt = clock();
    const base = {
      id: phase.id,
      networked: phase.networked,
      commit: context.commit,
      modelProfileStatus: context.modelProfileStatus,
      ...(phase.id === "judge-smoke" && context.judgeProfileStatus
        ? { judgeProfileStatus: context.judgeProfileStatus }
        : {}),
    };
    if (!phase.enabled) {
      results.push({
        ...base,
        status: "skipped",
        durationMs: clock() - startedAt,
        reason: phase.gate ?? "phase not enabled",
      });
      continue;
    }
    if (priorFailure) {
      results.push({
        ...base,
        status: "skipped",
        durationMs: clock() - startedAt,
        reason: "prior required phase failed",
      });
      continue;
    }

    let failedCommand: AcceptanceCommandResult | undefined;
    let failedCommandDefinition: AcceptanceCommand | undefined;
    for (const phaseCommand of phase.commands) {
      const result = await executor(phaseCommand);
      if (result.exitCode !== 0) {
        failedCommand = result;
        failedCommandDefinition = phaseCommand;
        break;
      }
    }
    const failed = failedCommand !== undefined;
    priorFailure = failed;
    results.push({
      ...base,
      status: failed ? "failed" : "passed",
      durationMs: clock() - startedAt,
      ...(failed ? { reason: "command exited nonzero" } : {}),
      ...(phase.id === "check" && failedCommand?.diagnostic
        ? {
            diagnostic: await safeCheckDiagnostic(
              failedCommand.diagnostic,
              failedCommandDefinition?.cwd,
            ),
          }
        : {}),
    });
  }
  return results;
}

const SAFE_ACCEPTANCE_CHECK_SCRIPTS = new Set(["check:pins", "check:static", "test"]);

async function safeCheckDiagnostic(
  diagnostic: AcceptanceCommandDiagnostic,
  cwd?: string,
): Promise<AcceptanceCommandDiagnostic> {
  const termination =
    diagnostic.termination === "signal" || diagnostic.termination === "spawn-error"
      ? diagnostic.termination
      : "exit";
  const signal =
    termination === "signal" &&
    typeof diagnostic.signal === "string" &&
    /^SIG[A-Z0-9]+$/u.test(diagnostic.signal)
      ? diagnostic.signal
      : undefined;
  const script =
    typeof diagnostic.script === "string" && SAFE_ACCEPTANCE_CHECK_SCRIPTS.has(diagnostic.script)
      ? diagnostic.script
      : undefined;
  const pathParts = diagnostic.testFile?.split("/");
  let testFile =
    pathParts?.[0] === "test" &&
    pathParts.length > 1 &&
    pathParts.every(
      (part) => part !== "" && part !== "." && part !== ".." && /^[A-Za-z0-9_.-]+$/u.test(part),
    ) &&
    /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(pathParts.at(-1) ?? "")
      ? pathParts.join("/")
      : undefined;
  if (testFile && !cwd) testFile = undefined;
  if (testFile && cwd) {
    try {
      const testRoot = await realpath(resolve(cwd, "test"));
      const candidate = await realpath(resolve(cwd, testFile));
      const relativePath = relative(testRoot, candidate);
      if (
        relativePath === "" ||
        relativePath === ".." ||
        relativePath.startsWith(`..${sep}`) ||
        isAbsolute(relativePath) ||
        !(await stat(candidate)).isFile()
      ) {
        testFile = undefined;
      }
    } catch {
      testFile = undefined;
    }
  }

  return {
    termination,
    ...(signal ? { signal } : {}),
    ...(script ? { script } : {}),
    ...(testFile ? { testFile } : {}),
  };
}

function normalizedApprovedUrl(value: string, label: string): string {
  const result = normalizeApprovedHttpsUrl(value);
  if (result.ok) return result.url;
  switch (result.code) {
    case "invalid-url":
      throw new Error(`${label} must be a valid HTTPS URL.`);
    case "not-https":
      throw new Error(`${label} must use HTTPS.`);
    case "embedded-credentials":
      throw new Error(`${label} must not contain embedded credentials.`);
    case "query-or-fragment":
      throw new Error(`${label} must not contain a query string or fragment.`);
  }
}

export function validateAcceptanceGates(input: {
  live: boolean;
  judge: boolean;
  approvedModelUrl?: string;
  approvedJudgeUrl?: string;
  environment: NodeJS.ProcessEnv;
}): void {
  if (!input.live) {
    if (input.judge) throw new Error("--judge requires --live.");
    return;
  }
  if (input.environment.DOCSFAB_ACCEPTANCE_LIVE !== "true") {
    throw new Error("--live requires DOCSFAB_ACCEPTANCE_LIVE=true.");
  }
  const modelUrl = input.environment.MODEL_BASE_URL?.trim();
  if (!modelUrl || !input.approvedModelUrl) {
    throw new Error("--live requires --approve-model-url exactly matching MODEL_BASE_URL.");
  }
  const normalizedModelUrl = normalizedApprovedUrl(modelUrl, "MODEL_BASE_URL");
  const normalizedApprovedModelUrl = normalizedApprovedUrl(
    input.approvedModelUrl,
    "--approve-model-url",
  );
  if (normalizedModelUrl !== normalizedApprovedModelUrl) {
    throw new Error("--live requires --approve-model-url exactly matching MODEL_BASE_URL.");
  }
  if (!input.judge) return;
  if (input.environment.DOCSFAB_ACCEPTANCE_JUDGE !== "true") {
    throw new Error("--judge requires DOCSFAB_ACCEPTANCE_JUDGE=true.");
  }
  const judgeUrl = input.environment.JUDGE_BASE_URL?.trim();
  if (!judgeUrl || !input.approvedJudgeUrl) {
    throw new Error("--judge requires --approve-judge-url exactly matching JUDGE_BASE_URL.");
  }
  const destination = assertApprovedJudgeDestination({
    configured: judgeUrl,
    environment: judgeUrl,
    approved: input.approvedJudgeUrl,
  });
  if (destination.ok) return;
  if (destination.failure.kind === "invalid") {
    normalizedApprovedUrl(
      destination.failure.field === "approved" ? input.approvedJudgeUrl : judgeUrl,
      destination.failure.field === "approved" ? "--approve-judge-url" : "JUDGE_BASE_URL",
    );
  }
  throw new Error("--judge requires --approve-judge-url exactly matching JUDGE_BASE_URL.");
}

const SAFE_RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SAFE_PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+/~-]{0,255}$/u;
const SAFE_RULE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*){1,15}$/u;
const RUN_STATUSES = new Set<unknown>([
  "queued",
  "running",
  "needs-input",
  "needs-human-decision",
  "succeeded",
  "failed",
]);
const SCAN_DISPOSITIONS = new Set<unknown>([
  "advisory",
  "passed",
  "blocked",
  "failed",
  "authorized",
  "denied",
]);

function safeString(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`Acceptance evidence has an invalid ${label}.`);
  }
  return value;
}

function safeModelId(value: unknown): string {
  const model = safeString(value, SAFE_MODEL_ID, "model identity");
  if (model.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("Acceptance evidence has an invalid model identity.");
  }
  return model;
}

export function summarizeAcceptanceRunRecord(
  value: unknown,
  file: string,
  sha256: string,
): AcceptanceRunRecordSummary {
  if (!isPlainRecord(value)) {
    throw new Error("Acceptance run record must be an object.");
  }
  const record = value;
  const id = safeString(record.id, SAFE_RECORD_ID, "run id");
  const safeFile = safeString(file, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u, "record filename");
  if (safeFile !== `${id}.json`) {
    throw new Error("Acceptance record filename does not match its run id.");
  }
  const digest = safeString(sha256, SAFE_SHA256, "record digest");
  if (typeof record.workflow !== "string" || !isWorkflowName(record.workflow)) {
    throw new Error("Acceptance evidence has an invalid workflow.");
  }
  if (!RUN_STATUSES.has(record.status)) {
    throw new Error("Acceptance evidence has an invalid run status.");
  }
  if (!isPlainRecord(record.repository)) {
    throw new Error("Acceptance evidence has an invalid repository identity.");
  }
  const revision = safeString(record.repository.revision, SAFE_REVISION, "repository revision");
  const scan =
    record.securityScan === undefined
      ? undefined
      : isPlainRecord(record.securityScan)
        ? record.securityScan
        : undefined;
  if (record.securityScan !== undefined && !scan) {
    throw new Error("Acceptance evidence has an invalid security scan.");
  }
  const disposition =
    record.securityScanEffectiveDisposition === undefined
      ? undefined
      : isPlainRecord(record.securityScanEffectiveDisposition)
        ? record.securityScanEffectiveDisposition
        : undefined;
  if (record.securityScanEffectiveDisposition !== undefined && !disposition) {
    throw new Error("Acceptance evidence has an invalid scan disposition.");
  }
  if (disposition && !SCAN_DISPOSITIONS.has(disposition.status)) {
    throw new Error("Acceptance evidence has an invalid scan disposition.");
  }
  const findings =
    scan?.findings === undefined ? [] : Array.isArray(scan.findings) ? scan.findings : undefined;
  if (!findings) {
    throw new Error("Acceptance evidence has invalid scanner findings.");
  }
  if (!Array.isArray(record.models)) {
    throw new Error("Acceptance evidence has invalid model identities.");
  }
  const ruleIds = findings.map((finding) => {
    if (!isPlainRecord(finding)) {
      throw new Error("Acceptance evidence has an invalid scanner rule id.");
    }
    return safeString(finding.ruleId, SAFE_RULE_ID, "scanner rule id");
  });
  const models = record.models.map((model) => {
    if (!isPlainRecord(model)) {
      throw new Error("Acceptance evidence has an invalid model identity.");
    }
    const provider = safeString(model.provider, SAFE_PROVIDER_ID, "model provider identity");
    const modelId = safeModelId(model.model);
    const profile = model.profile;
    if (
      profile !== undefined &&
      !validModelEvidenceProjection({
        provider,
        model: modelId,
        profile: profile as ModelEvidence["profile"],
      })
    ) {
      throw new Error("Acceptance evidence has invalid model profile provenance.");
    }
    const profileSha256 =
      profile === undefined ? undefined : (profile as NonNullable<ModelEvidence["profile"]>).sha256;
    return {
      provider,
      model: modelId,
      ...(profileSha256 ? { profileSha256 } : {}),
    };
  });
  return {
    file: safeFile,
    sha256: digest,
    id,
    workflow: record.workflow as WorkflowName,
    status: record.status as RunStatus,
    revision,
    ...(disposition ? { scanDisposition: disposition.status as SecurityScanEffectiveStatus } : {}),
    ruleIds: [...new Set(ruleIds)].sort(),
    models,
  };
}

export function bindAcceptanceJudgeEvidence(
  value: unknown,
  input: {
    sha256: string;
    acceptanceId: string;
    revision: string;
    judgeProfileStatus: ModelProfileStatus;
    records: AcceptanceRunRecordSummary[];
  },
): unknown | undefined {
  if (
    !SAFE_SHA256.test(input.sha256) ||
    !SAFE_RECORD_ID.test(input.acceptanceId) ||
    !SAFE_REVISION.test(input.revision) ||
    !["current", "stale", "unknown"].includes(input.judgeProfileStatus)
  ) {
    return undefined;
  }
  const expectedInputs = input.records.map((record) => ({
    id: record.id,
    sha256: record.sha256,
  }));
  if (
    expectedInputs.some(
      ({ id, sha256 }) => !SAFE_RECORD_ID.test(id) || !SAFE_SHA256.test(sha256),
    ) ||
    new Set(expectedInputs.map(({ id }) => id)).size !== expectedInputs.length ||
    new Set(expectedInputs.map(({ sha256 }) => sha256)).size !== expectedInputs.length
  ) {
    return undefined;
  }
  expectedInputs.sort((left, right) => left.id.localeCompare(right.id));
  const artifact = parseJudgeResultArtifact(value);
  if (!artifact) return undefined;
  const actualInputs = [...artifact.inputRecords].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  if (
    artifact.acceptanceId !== input.acceptanceId ||
    artifact.testedCommit !== input.revision ||
    artifact.judgeProfileStatus !== input.judgeProfileStatus ||
    artifact.structural.recordCount !== input.records.length ||
    JSON.stringify(actualInputs) !== JSON.stringify(expectedInputs)
  ) {
    return undefined;
  }
  const decided = artifact.judge.status === "passed" || artifact.judge.status === "disagreed";
  return {
    file: "judge-result.json",
    sha256: input.sha256,
    acceptanceId: artifact.acceptanceId,
    testedCommit: artifact.testedCommit,
    judgeProfileStatus: artifact.judgeProfileStatus,
    inputRecords: actualInputs,
    fixture: { name: artifact.fixture.name, version: artifact.fixture.version },
    structural: {
      passed: artifact.structural.passed,
      recordCount: artifact.structural.recordCount,
    },
    judge: {
      status: artifact.judge.status,
      rubric: { id: artifact.judge.rubric.id, version: artifact.judge.rubric.version },
      ...(artifact.judge.model ? { model: artifact.judge.model } : {}),
      ...(decided ? { score: artifact.judge.score } : {}),
    },
  };
}

/**
 * Environment variable names whose values are credential material. Suffix
 * matching covers provider-prefixed keys and CI-injected job credentials.
 */
const CREDENTIAL_ENVIRONMENT_NAME =
  /(?:API_KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIALS?|PRIVATE_KEY)$/u;

function pathsOverlap(left: string, right: string): boolean {
  const forward = relative(left, right);
  const backward = relative(right, left);
  return (
    forward === "" ||
    (!forward.startsWith("..") && !isAbsolute(forward)) ||
    (!backward.startsWith("..") && !isAbsolute(backward))
  );
}

/**
 * Canonicalize a caller-named collectable evidence destination.
 *
 * Collectable evidence is the one acceptance output a caller may place inside
 * the source checkout, because CI platforms such as GitLab collect artifacts
 * only under the project directory. It is not an acceptance output root:
 * private state and raw run records still pass through
 * {@link canonicalizeAcceptanceOutputRoot}, whose outside-repository rule is
 * unchanged. The destination must not traverse symbolic links and must be
 * disjoint from every private root in both directions, so collecting it can
 * never sweep up private state. Nothing is created here.
 */
export async function canonicalizeCollectableEvidenceDestination(input: {
  requestedPath: string;
  privateRoots: readonly string[];
  label: string;
}): Promise<string> {
  const candidate = await canonicalizeUncreatedOutputPath(input.requestedPath, input.label);
  for (const root of input.privateRoots) {
    if (pathsOverlap(candidate, await canonicalizeUncreatedOutputPath(root, input.label))) {
      throw new Error(
        `${input.label} must be disjoint from the private --state-dir and --evidence-dir roots.`,
      );
    }
  }
  return candidate;
}

async function canonicalizeUncreatedOutputPath(
  requestedPath: string,
  label: string,
): Promise<string> {
  const requested = resolve(requestedPath);
  let existing = requested;
  const suffix: string[] = [];
  let canonicalExisting: string | undefined;
  while (canonicalExisting === undefined) {
    try {
      canonicalExisting = await realpath(existing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      suffix.push(basename(existing));
      existing = parent;
    }
  }
  if (canonicalExisting !== existing) {
    throw new Error(`${label} must name a path that does not traverse symbolic links.`);
  }
  return resolve(canonicalExisting, ...suffix.reverse());
}

function serializedContains(serialized: string, value: string): boolean {
  return serialized.includes(value) || serialized.includes(JSON.stringify(value).slice(1, -1));
}

/**
 * Refuse collectable evidence that could disclose a credential value or a
 * private-root location. The caller's environment supplies the credential
 * values to exclude; refusals name the variable, never its value.
 */
export function assertCollectableAcceptanceEvidence(
  value: unknown,
  input: {
    environment: NodeJS.ProcessEnv;
    privateRoots: readonly string[];
    label: string;
  },
): void {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error(`${input.label} evidence could not be serialized as JSON for collection.`);
  }
  for (const [name, raw] of Object.entries(input.environment)) {
    if (!CREDENTIAL_ENVIRONMENT_NAME.test(name.toUpperCase())) continue;
    const secret = raw?.trim();
    if (secret && serializedContains(serialized, secret)) {
      throw new Error(
        `${input.label} evidence would contain the value of ${name}; collectable evidence never carries credential values.`,
      );
    }
  }
  if (containsCatalogCredential(serialized) || containsAssignedCredential(serialized)) {
    throw new Error(
      `${input.label} evidence contains credential-shaped material, so it was not written for collection.`,
    );
  }
  if (input.privateRoots.some((root) => serializedContains(serialized, root))) {
    throw new Error(
      `${input.label} evidence would disclose a private root location, so it was not written for collection.`,
    );
  }
}

/** Written beside `manifest.json` when an offline phase command fails. */
export const ACCEPTANCE_PHASE_OUTPUT_FILE = "phase-output.json";

/** Written beside `manifest.json` when a networked phase command fails. */
export const ACCEPTANCE_NETWORKED_PHASE_FAILURE_FILE = "networked-phase-failure.json";

/**
 * A failed offline phase command and its combined stdout and stderr, so the
 * failure can be diagnosed from collected artifacts alone. Networked
 * phases are not captured here: their output can carry provider detail. See
 * {@link AcceptanceNetworkedPhaseFailure} for what a networked failure keeps.
 */
export interface AcceptancePhaseOutput {
  schemaVersion: 1;
  acceptanceId: string;
  testedCommit: string;
  phase: AcceptancePhase["id"];
  command: string;
  exitCode: number;
  output: string;
}

/** Stands in for a line the collection screen would flag once serialized. */
export const ACCEPTANCE_WITHHELD_LINE = "[line withheld from collection]";

/**
 * Prepare failed phase output for collection. Terminal control sequences go
 * first, because a colour code can split a credential so no pattern matches
 * it. Then credential values named by the caller's environment and every
 * private-root location are replaced, and recognized credential shapes are
 * redacted. Last, a line that the collection screen would still flag in its
 * serialized JSON form, where quotes and line breaks are escaped, is withheld,
 * so one such line cannot block the whole output. The rest is kept.
 */
export function sanitizeAcceptancePhaseOutput(
  text: string,
  input: { environment: NodeJS.ProcessEnv; privateRoots: readonly string[] },
): string {
  let sanitized = stripVTControlCharacters(text);
  for (const [name, raw] of Object.entries(input.environment)) {
    if (!CREDENTIAL_ENVIRONMENT_NAME.test(name.toUpperCase())) continue;
    const secret = raw?.trim();
    if (secret) sanitized = replaceEveryForm(sanitized, secret, `[redacted ${name}]`);
  }
  for (const root of input.privateRoots) {
    sanitized = replaceEveryForm(sanitized, root, "[private root]");
  }
  return withholdSerializedCredentialLines(redactCredentialMaterial(sanitized));
}

function replaceEveryForm(text: string, value: string, replacement: string): string {
  return text
    .replaceAll(value, replacement)
    .replaceAll(JSON.stringify(value).slice(1, -1), replacement);
}

function flaggedForCollection(text: string): boolean {
  const serialized = JSON.stringify(text);
  return containsCatalogCredential(serialized) || containsAssignedCredential(serialized);
}

function withholdSerializedCredentialLines(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => (flaggedForCollection(line) ? ACCEPTANCE_WITHHELD_LINE : line));
  // A serialized line break is `\n`, so a shape can also span two lines.
  for (let index = 1; index < lines.length; index += 1) {
    if (flaggedForCollection(`${lines[index - 1]}\n${lines[index]}`)) {
      lines[index - 1] = ACCEPTANCE_WITHHELD_LINE;
      lines[index] = ACCEPTANCE_WITHHELD_LINE;
    }
  }
  return lines.join("\n");
}

/**
 * A failed networked phase command, summarized from the structured failure
 * report the DocsFab command printed with `--json`. The provider credential is
 * in that command's environment, so its raw output and message are never kept:
 * only the code, the failure class and layer, and the next action and docs
 * reference the report names, each through the phase-output sanitizer.
 */
export interface AcceptanceNetworkedPhaseFailure {
  schemaVersion: 1;
  acceptanceId: string;
  testedCommit: string;
  phase: AcceptancePhase["id"];
  exitCode: number;
  /**
   * `operator-error`: the operator failure envelope on standard error.
   * `run-result`: the run failure in the run result on standard output.
   * `none`: the command printed neither, so no code is known.
   */
  report: "operator-error" | "run-result" | "none";
  code?: string;
  /** The reported failure class, layer, and classified code, each sanitized. */
  failure?: { class: string; layer: string; code: string };
  nextAction?: string;
  docsAnchor?: string;
}

interface ReportedNetworkedFailure {
  report: "operator-error" | "run-result";
  code: string;
  failure?: FailureClassificationV1;
  nextAction?: string;
  docsAnchor?: string;
}

/**
 * Summarize a failed networked phase command from what it printed. The operator
 * failure envelope on standard error comes first, because a thrown failure is
 * the command's final word; then the run-scope failure of a run result on
 * standard output. Every collected string passes through
 * {@link sanitizeAcceptancePhaseOutput}, so a credential value or shape is
 * redacted or withheld, never echoed.
 */
export function summarizeNetworkedPhaseFailure(input: {
  acceptanceId: string;
  testedCommit: string;
  phase: AcceptancePhase["id"];
  exitCode: number;
  stdout: string;
  stderr: string;
  environment: NodeJS.ProcessEnv;
  privateRoots: readonly string[];
}): AcceptanceNetworkedPhaseFailure {
  const reported = reportedOperatorError(input.stderr) ?? reportedRunFailure(input.stdout);
  const sanitize = (text: string): string =>
    sanitizeAcceptancePhaseOutput(text, {
      environment: input.environment,
      privateRoots: input.privateRoots,
    });
  const summary: AcceptanceNetworkedPhaseFailure = {
    schemaVersion: 1,
    acceptanceId: input.acceptanceId,
    testedCommit: input.testedCommit,
    phase: input.phase,
    exitCode: input.exitCode,
    report: reported?.report ?? "none",
  };
  if (!reported) return summary;
  const { code, failure, nextAction, docsAnchor } = reported;
  return {
    ...summary,
    code: sanitize(code),
    ...(failure
      ? {
          failure: {
            class: sanitize(failure.class),
            layer: sanitize(failure.layer),
            code: sanitize(failure.code),
          },
        }
      : {}),
    ...(nextAction !== undefined ? { nextAction: sanitize(nextAction) } : {}),
    ...(docsAnchor !== undefined ? { docsAnchor: sanitize(docsAnchor) } : {}),
  };
}

/** The last operator failure envelope printed on standard error, by its structured fields. */
function reportedOperatorError(stderr: string): ReportedNetworkedFailure | undefined {
  const envelope = lastPrintedJsonObject(stderr, "docsfab-operator-error");
  if (!envelope || envelope.schemaVersion !== 1 || !isFailureCode(envelope.code)) {
    return undefined;
  }
  const failure = readFailureClassification(envelope.failure);
  return {
    report: "operator-error",
    code: envelope.code,
    ...(failure ? { failure } : {}),
    ...(typeof envelope.nextAction === "string" ? { nextAction: envelope.nextAction } : {}),
    ...(typeof envelope.docsAnchor === "string" ? { docsAnchor: envelope.docsAnchor } : {}),
  };
}

/**
 * The run-scope failure of the last run result printed on standard output. A
 * failed run always carries one; step and attempt failures can be retried
 * causes, so they are not the run's code.
 */
function reportedRunFailure(stdout: string): ReportedNetworkedFailure | undefined {
  const result = lastPrintedJsonObject(stdout, "docsfab-run-result");
  if (!result || !Array.isArray(result.failures)) return undefined;
  for (const occurrence of result.failures) {
    if (!isPlainRecord(occurrence) || occurrence.scope !== "run") continue;
    const failure = readFailureClassification({
      class: occurrence.class,
      layer: occurrence.layer,
      code: occurrence.code,
    });
    if (failure) return { report: "run-result", code: failure.code, failure };
  }
  return undefined;
}

/**
 * The last JSON object of `kind` that a command printed whole: a compact
 * object on one line, or an indented object from a line holding only `{`,
 * through lines indented by two spaces, to a line holding only `}`, as
 * DocsFab prints its JSON reports. Any other text is skipped, never read.
 */
function lastPrintedJsonObject(text: string, kind: string): Record<string, unknown> | undefined {
  const lines = text.split(/\r?\n/u);
  let found: Record<string, unknown> | undefined;
  const consider = (candidate: string): void => {
    try {
      const value: unknown = JSON.parse(candidate);
      if (isPlainRecord(value) && value.kind === kind) found = value;
    } catch {
      // Not a printed object; parse errors quote their input, so none is kept.
    }
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line === "{") {
      let end = index + 1;
      while (end < lines.length && lines[end]!.startsWith("  ")) end += 1;
      if (lines[end] === "}") {
        consider(lines.slice(index, end + 1).join("\n"));
        index = end + 1;
      } else {
        index = end;
      }
      continue;
    }
    if (line.startsWith("{") && line.endsWith("}")) consider(line);
    index += 1;
  }
  return found;
}

function assertOutsideRepository(path: string, repositoryRoot: string, label: string): void {
  const relation = relative(repositoryRoot, path);
  if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) {
    throw new Error(`${label} must be outside the source repository.`);
  }
}

export async function canonicalizeAcceptanceOutputRoot(
  requestedPath: string,
  repositoryRoot: string,
  label: string,
  options: { create?: boolean } = {},
): Promise<string> {
  const requested = resolve(requestedPath);
  let existing = requested;
  const suffix: string[] = [];
  while (true) {
    try {
      const canonicalExisting = await realpath(existing);
      if (canonicalExisting !== existing) {
        throw new Error(`${label} must not traverse symbolic links.`);
      }
      const candidate = resolve(canonicalExisting, ...suffix.reverse());
      const canonicalRepository = await realpath(repositoryRoot);
      assertOutsideRepository(candidate, canonicalRepository, label);
      if (options.create === false) return candidate;
      await mkdir(candidate, { recursive: true, mode: 0o700 });
      const canonicalCandidate = await realpath(candidate);
      if (canonicalCandidate !== candidate) {
        throw new Error(`${label} must not resolve through symbolic links.`);
      }
      assertOutsideRepository(canonicalCandidate, canonicalRepository, label);
      return canonicalCandidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      suffix.push(basename(existing));
      existing = parent;
    }
  }
}

export function offlineAcceptanceEnvironment(
  base: NodeJS.ProcessEnv,
  stateDirectory: string,
): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const name of ACCEPTANCE_OFFLINE_NAMES) {
    if (base[name]) scrubbed[name] = base[name];
  }
  return {
    ...scrubbed,
    MODEL_PROVIDER: "acceptance-offline",
    MODEL_BASE_URL: "https://offline.invalid/v1",
    MODEL_ID: "acceptance/offline",
    MODEL_API_FORMAT: "chat_completions",
    MODEL_API_KEY: "offline-placeholder-not-a-credential",
    MODEL_CONTEXT_WINDOW: "8192",
    MODEL_MAX_OUTPUT_TOKENS: "4096",
    MODEL_API_MIN_OUTPUT_TOKENS: "16",
    MODEL_CONTEXT_RESERVE_TOKENS: "4096",
    MODEL_REASONING: "false",
    MODEL_INPUT_TYPES: "text",
    MODEL_SUPPORTS_DEVELOPER_ROLE: "false",
    MODEL_SUPPORTS_REASONING_EFFORT: "false",
    MODEL_COMPATIBLE_API_FORMATS: "chat_completions",
    MODEL_INPUT_COST_PER_MILLION: "unknown",
    MODEL_OUTPUT_COST_PER_MILLION: "unknown",
    MODEL_CACHE_READ_COST_PER_MILLION: "unknown",
    MODEL_CACHE_WRITE_COST_PER_MILLION: "unknown",
    MODEL_PROFILE_APPROVED_SOURCE: "unknown",
    MODEL_PROFILE_EFFECTIVE_DATE: "unknown",
    MODEL_PROFILE_REVIEW_AFTER: "unknown",
    JUDGE_ENABLED: "false",
    DOCSFAB_STATE_DIR: stateDirectory,
  };
}

/**
 * Environment for the `check` phase: the offline environment without the
 * synthesized stub profile and acceptance state directory. The repository's
 * own suite builds every profile it tests, as ordinary CI test jobs do. An
 * ambient MODEL_* value takes precedence over a test fixture's configuration
 * root, and a test writing run records must not reach the acceptance's private
 * state directory.
 */
export function repositoryCheckEnvironment(offline: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const synthesized = offlineAcceptanceEnvironment({}, "");
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(offline)) {
    if (!Object.hasOwn(synthesized, name)) environment[name] = value;
  }
  return environment;
}
