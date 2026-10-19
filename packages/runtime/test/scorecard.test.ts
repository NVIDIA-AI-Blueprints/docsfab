// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { summarizeAcceptanceRunRecord } from "../src/acceptance.js";
import { ACCEPTANCE_CHECK_LIMITATIONS } from "../src/acceptance-check-limitations.js";
import type {
  InferenceFailureCategory,
  ModelEvidence,
  RunRecord,
  TokenUsage,
} from "../src/records/contracts.js";
import type { EvaluationFixture } from "../src/quality-evaluation/contracts.js";
import { governProviderTurn } from "../src/model/turn-governor.js";
import { modelProfileEvidenceSha256 } from "../src/model/profile-evidence.js";
import {
  buildMvpScorecard,
  canonicalJson,
  parseScorecardCampaignDeclaration,
  ScorecardInputError,
  type ScorecardCampaignDeclarationV1,
  type ScorecardRecordLeaf,
} from "../src/scorecard.js";
import {
  assertSanitizedScorecardArtifacts,
  renderMvpScorecardMarkdown,
  serializeMvpScorecard,
} from "../src/scorecard-render.js";

const revision = "a".repeat(40);
const generatorRevision = "b".repeat(40);
const packetDigest = "d".repeat(64);
const dependencySha256 = "1".repeat(64);
const judgeSha256 = "2".repeat(64);

const fixture: EvaluationFixture = {
  version: 1,
  name: "Multi-turn governed live readiness",
  assertions: [
    { type: "run-count", minimum: 5 },
    { type: "workflow", equals: "readiness" },
    { type: "governed-terminal-status" },
    { type: "step-skills", equals: ["doc-context-analyzer"] },
    { type: "governed-skill-evidence" },
    { type: "allowed-tools", tools: ["read", "grep", "find", "ls"] },
    { type: "forbidden-tools", tools: ["edit", "write"] },
    { type: "turn-governance-evidence" },
    { type: "evidence-identity-consistent" },
  ],
};

const profile: NonNullable<ModelEvidence["profile"]> = {
  schemaVersion: 2,
  status: "current",
  configuredContextWindow: 128_000,
  effectiveContextWindow: 128_000,
  configuredMaxInputTokens: 128_000,
  effectiveMaxInputTokens: 128_000,
  configuredMaxOutputTokens: 16_384,
  effectiveMaxOutputTokens: 16_384,
  effectiveLimitReason: "none",
  apiFormat: "chat_completions",
  reasoning: true,
  input: ["text"],
  compatibility: {
    supportsDeveloperRole: true,
    supportsReasoningEffort: true,
    apiFormats: ["chat_completions"],
  },
  requestPolicy: {
    minimumOutputTokens: 16,
    reservedContextTokens: 128,
  },
  costPerMillionTokens: {
    input: 1,
    output: 1,
    cacheRead: 1,
    cacheWrite: 1,
  },
  pricing: "known",
  approvedSourceSha256: "3".repeat(64),
  effectiveDate: "2026-08-01",
  reviewAfter: "2026-09-01",
  sha256: "c".repeat(64),
};

const model: ModelEvidence = {
  provider: "policy-provider",
  model: "policy/model",
  profile,
};
{
  const { sha256: _sha256, ...profileWithoutDigest } = profile;
  profile.sha256 = modelProfileEvidenceSha256({
    provider: model.provider,
    model: model.model,
    profile: profileWithoutDigest,
  });
}

const skill = {
  id: "doc-context-analyzer",
  contentSha256: "4".repeat(64),
  bundleSha256: "5".repeat(64),
  version: "1.0.0",
  license: "Apache-2.0",
  source: {
    repository: "https://example.test/skills.git",
    revision,
    path: "skills/doc-context-analyzer/SKILL.md",
  },
  inputs: [{ name: "repository", description: "Selected repository" }],
  outputs: [{ name: "summary", description: "Readiness summary" }],
  toolPolicy: {
    declared: ["read"],
    granted: ["read"],
    withheld: [],
  },
};

const tools = {
  totalCalls: 1,
  failedCalls: 0,
  byTool: [{ name: "read", calls: 1, failures: 0 }],
};

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function usage(slot: number): TokenUsage {
  const input = 100 + slot;
  const output = 20 + slot;
  const cacheRead = 10;
  const cacheWrite = 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
    turns: 1,
    cost: slot / 100,
  };
}

function evidenceDigest(): string {
  const identity = {
    repositoryRevision: revision,
    contextPacketDigest: packetDigest,
    consultedNodeIds: ["node-a"],
  };
  return sha256(JSON.stringify(identity, Object.keys(identity).sort()));
}

function rehashModelEvidence(value: ModelEvidence): void {
  if (!value.profile) return;
  const { sha256: _sha256, ...profileWithoutDigest } = value.profile;
  value.profile.sha256 = modelProfileEvidenceSha256({
    provider: value.provider,
    model: value.model,
    profile: profileWithoutDigest,
  });
}

function succeededRecord(slot: number): RunRecord {
  const recordUsage = usage(slot);
  const startedAt = new Date(Date.UTC(2026, 7, 4, 0, 0, slot)).toISOString();
  const completedAt = new Date(Date.parse(startedAt) + slot * 100).toISOString();
  const identity = {
    repositoryRevision: revision,
    contextPacketDigest: packetDigest,
    consultedNodeIds: ["node-a"],
  };
  return {
    schemaVersion: 2,
    id: `run-${slot}`,
    workflow: "readiness",
    repository: {
      sourcePath: `/private/repository-${slot}`,
      requestedRevision: "HEAD",
      revision,
    },
    workspace: { strategy: "tracked-export", disposable: true },
    instruction: `PRIVATE_INSTRUCTION_SENTINEL_${slot}`,
    status: "succeeded",
    createdAt: startedAt,
    startedAt,
    completedAt,
    durationMs: slot * 100,
    models: [structuredClone(model)],
    skills: [structuredClone(skill)],
    usage: recordUsage,
    tools: structuredClone(tools),
    steps: [
      {
        id: "assess-readiness",
        title: "Assess repository readiness",
        kind: "inference",
        skill: "doc-context-analyzer",
        mode: "read-only",
        status: "succeeded",
        startedAt,
        completedAt: new Date(Date.parse(startedAt) + slot * 10).toISOString(),
        durationMs: slot * 10,
        model: structuredClone(model),
        skillEvidence: structuredClone(skill),
        usage: recordUsage,
        tools: structuredClone(tools),
        contextPreflight: {
          status: "ready",
          packetDigest,
          consultedNodeIds: ["node-a"],
          ontologyVersion: "scorecard-test-v1",
          effectiveDecisionIds: [],
          measurements: {
            byteLength: 1_000,
            estimatedTokens: 250,
            latencyMs: 1,
            nodeCount: 1,
            edgeCount: 0,
            pathCount: 1,
          },
          cache: { disposition: "disabled", rebuildAttempted: true },
        },
        summary: `PRIVATE_SUMMARY_SENTINEL_${slot}`,
        inference: {
          configuredMaxRetries: 0,
          effectiveMaxRetries: 0,
          baseDelayMs: 1_000,
          maxDelayMs: 2_000,
          retryableCategories: ["timeout"],
          replay: "read-only",
          attempts: [
            {
              attempt: 1,
              outcome: "succeeded",
              retryable: false,
              retryScheduled: false,
              durationMs: slot * 10,
              model: structuredClone(model),
              usage: recordUsage,
              tools: structuredClone(tools),
              identity,
              turns: [
                {
                  contextBudgetSchemaVersion: 2,
                  turn: 1,
                  toolCalls: 1,
                  toolResults: 1,
                  maxProviderTurns: 12,
                  maxToolCalls: 12,
                  compactions: 0,
                  maxCompactions: 8,
                  configuredContextWindow: 128_000,
                  effectiveContextWindow: 128_000,
                  configuredMaxInputTokens: 128_000,
                  effectiveMaxInputTokens: 128_000,
                  configuredMaxOutputTokens: 16_384,
                  effectiveMaxOutputTokens: 16_384,
                  reservedTokens: 128,
                  estimatedInputTokens: 1_000,
                  availableInputTokens: 127_872,
                  availableOutputTokens: 126_872,
                  requiredMinimumOutputTokens: 16,
                  outputTokens: 16_384,
                  decision: "proceed",
                  requestDigest: "6".repeat(64),
                  evidenceDigest: evidenceDigest(),
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

function contextStoppedRecord(
  slot: number,
  stopAt: { contextChars: number; toolCalls: number } = { contextChars: 600_000, toolCalls: 1 },
): RunRecord {
  const record = succeededRecord(slot);
  record.status = "failed";
  record.steps[0]!.status = "failed";
  delete record.steps[0]!.summary;
  const attempt = record.steps[0]!.inference!.attempts[0]!;
  const stop = governProviderTurn({
    context: { messages: [{ role: "user", content: "x".repeat(stopAt.contextChars) }] },
    policy: {
      budget: {
        configuredContextWindow: 128_000,
        effectiveContextWindow: 128_000,
        configuredMaxInputTokens: 128_000,
        effectiveMaxInputTokens: 128_000,
        configuredMaxOutputTokens: 16_384,
        effectiveMaxOutputTokens: 16_384,
        reservedTokens: 128,
        requiredMinimumOutputTokens: 16,
      },
      maxProviderTurns: 12,
      maxToolCalls: 12,
      maxCompactions: 8,
      minRecentToolTurns: 1,
    },
    state: {
      providerTurns: 0,
      toolCalls: stopAt.toolCalls,
      toolResults: stopAt.toolCalls,
      compactions: 0,
    },
    evidenceIdentity: attempt.identity!,
    pinnedMessageCount: 1,
  });
  attempt.outcome = "context-exhausted";
  attempt.retryable = false;
  attempt.retryScheduled = false;
  attempt.turns = [stop.evidence];
  attempt.usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    turns: 0,
    cost: 0,
  };
  record.steps[0]!.usage = structuredClone(attempt.usage);
  record.usage = structuredClone(attempt.usage);
  const called = {
    totalCalls: stopAt.toolCalls,
    failedCalls: 0,
    byTool: [{ name: "read", calls: stopAt.toolCalls, failures: 0 }],
  };
  attempt.tools = structuredClone(called);
  record.steps[0]!.tools = structuredClone(called);
  record.tools = structuredClone(called);
  return record;
}

function scannerBlockedRecord(slot: number): RunRecord {
  const record = succeededRecord(slot);
  record.status = "failed";
  delete record.startedAt;
  record.models = [];
  record.skills = [];
  record.usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    turns: 0,
  };
  record.tools = { totalCalls: 0, failedCalls: 0, byTool: [] };
  record.securityScan = {
    ruleSet: "docsfab-local-v2",
    status: "blocked",
    scannedFiles: 1,
    binaryFiles: 0,
    findings: [{ path: "fixture", ruleId: "credential-assigned-secret" }],
  };
  record.securityScanEffectiveDisposition = { status: "blocked" };
  const step = record.steps[0]!;
  step.status = "pending";
  delete step.startedAt;
  delete step.completedAt;
  delete step.durationMs;
  delete step.model;
  delete step.skillEvidence;
  delete step.usage;
  delete step.tools;
  delete step.inference;
  delete step.summary;
  step.contextPreflight = {
    status: "failed",
    reason: "workflow-stopped-before-step",
  };
  return record;
}

interface CampaignFixture {
  rawDeclaration: Record<string, unknown>;
  declaration: ScorecardCampaignDeclarationV1;
  declarationBytes: Buffer;
  recordLeaves: ScorecardRecordLeaf[];
  records: RunRecord[];
  acceptanceBytes: Buffer;
  input: Parameters<typeof buildMvpScorecard>[0];
}

function campaign(
  options: {
    records?: RunRecord[];
    judge?: Record<string, unknown>;
    dependencyStatus?: "resolved" | "contained" | "failed";
    profileStatus?: "current" | "stale" | "unknown";
    /** Overrides the attested review date; applied with `profileStatus`. */
    profileReviewAfter?: string;
    verificationFailure?: "npm-check" | "npm-build" | "git-diff-check";
    acceptancePassed?: boolean;
  } = {},
): CampaignFixture {
  const records =
    options.records ?? Array.from({ length: 5 }, (_, index) => succeededRecord(index + 1));
  if (options.profileStatus) {
    for (const record of records) {
      record.models[0]!.profile!.status = options.profileStatus;
      record.models[0]!.profile!.effectiveLimitReason =
        options.profileStatus === "current"
          ? "none"
          : options.profileStatus === "stale"
            ? "metadata-stale"
            : "metadata-unknown";
      if (options.profileStatus === "stale") {
        record.models[0]!.profile!.reviewAfter = "2026-08-03";
        record.models[0]!.profile!.pricing = "unknown";
        record.models[0]!.profile!.costPerMillionTokens.cacheWrite = null;
      } else if (options.profileStatus === "unknown") {
        delete record.models[0]!.profile!.approvedSourceSha256;
        delete record.models[0]!.profile!.effectiveDate;
        delete record.models[0]!.profile!.reviewAfter;
        record.models[0]!.profile!.pricing = "unknown";
        record.models[0]!.profile!.costPerMillionTokens.cacheWrite = null;
      }
      if (options.profileReviewAfter) {
        record.models[0]!.profile!.reviewAfter = options.profileReviewAfter;
      }
      if (options.profileStatus !== "current") {
        record.models[0]!.profile!.effectiveContextWindow = 8_192;
        record.models[0]!.profile!.effectiveMaxInputTokens = 8_192;
        record.models[0]!.profile!.effectiveMaxOutputTokens = 4_096;
        delete record.usage.cost;
      }
      rehashModelEvidence(record.models[0]!);
      for (const step of record.steps) {
        if (step.model?.profile) {
          step.model.profile = structuredClone(record.models[0]!.profile!);
          rehashModelEvidence(step.model);
        }
        if (options.profileStatus !== "current" && step.usage) delete step.usage.cost;
        for (const attempt of step.inference?.attempts ?? []) {
          attempt.model!.profile = structuredClone(record.models[0]!.profile!);
          rehashModelEvidence(attempt.model!);
          if (options.profileStatus !== "current" && attempt.usage) delete attempt.usage.cost;
          for (const turn of attempt.turns ?? []) {
            turn.effectiveContextWindow = attempt.model!.profile!.effectiveContextWindow;
            turn.effectiveMaxInputTokens = attempt.model!.profile!.effectiveMaxInputTokens;
            turn.availableInputTokens = Math.max(
              0,
              Number(turn.effectiveMaxInputTokens) - turn.reservedTokens,
            );
            turn.effectiveMaxOutputTokens = attempt.model!.profile!.effectiveMaxOutputTokens;
            turn.availableOutputTokens = Math.max(
              0,
              turn.effectiveContextWindow - turn.estimatedInputTokens - turn.reservedTokens,
            );
            if (turn.outputTokens !== undefined) {
              turn.outputTokens = Math.min(
                turn.outputTokens,
                turn.effectiveMaxOutputTokens,
                turn.availableOutputTokens,
              );
            }
          }
        }
      }
    }
  }
  const recordLeaves = records.map((record) => {
    const bytes = Buffer.from(JSON.stringify(record));
    return { file: `${record.id}.json`, bytes };
  });
  const rawDeclaration = {
    schemaVersion: 1,
    campaignId: "wave-3-mvp",
    evaluatedAt: "2026-08-04T12:00:00.000Z",
    testedCommit: revision,
    records: recordLeaves.map((leaf, index) => ({
      slot: index + 1,
      file: leaf.file,
      id: records[index]!.id,
      sha256: sha256(leaf.bytes),
    })),
    judge: options.judge ?? {
      status: "passed",
      rubric: { id: "docsfab.semantic-evidence-quality", version: 1 },
      model: { provider: "judge-provider", model: "judge/model" },
      score: 0.9,
      evidenceSha256: judgeSha256,
    },
    remainingWork: [
      {
        issue: 28,
        scope: "issue-28-dogfood",
        owner: "docsfab-maintainers",
        reason: "product-validation",
      },
      {
        issue: 7,
        scope: "shared-service",
        owner: "docsfab-maintainers",
        reason: "external-governance",
      },
    ],
  };
  let judgeBytes: Buffer | undefined;
  if (rawDeclaration.judge.status !== "skipped") {
    const judgeArtifact = {
      schemaVersion: 1,
      campaignId: rawDeclaration.campaignId,
      testedCommit: revision,
      inputRecords: rawDeclaration.records.map(({ id, sha256: recordSha256 }) => ({
        id,
        sha256: recordSha256,
      })),
      fixture: { name: fixture.name, version: 1 },
      structural: { passed: true, recordCount: 5 },
      judge: {
        status: rawDeclaration.judge.status,
        rubric: rawDeclaration.judge.rubric,
        model: rawDeclaration.judge.model,
        ...(rawDeclaration.judge.status === "passed" || rawDeclaration.judge.status === "disagreed"
          ? { score: rawDeclaration.judge.score }
          : {}),
      },
    };
    judgeBytes = Buffer.from(JSON.stringify(judgeArtifact));
    rawDeclaration.judge.evidenceSha256 = sha256(judgeBytes);
  }
  const declaration = parseScorecardCampaignDeclaration(rawDeclaration);
  const declarationBytes = Buffer.from(canonicalJson(rawDeclaration));
  const profileStatus = options.profileStatus ?? "current";
  const acceptancePassed = options.acceptancePassed ?? true;
  const acceptanceJudge = declaration.judge.status === "skipped" ? undefined : declaration.judge;
  const acceptanceJudgeEnabled = acceptanceJudge !== undefined;
  const acceptancePhaseIds = [
    "clean-install",
    "check",
    "build",
    "catalog",
    "offline-doctor",
    "live-doctor",
    "live-fixture-readiness",
    "live-self-readiness",
    "judge-smoke",
    "source-integrity",
    "workspace-cleanup",
  ];
  const acceptanceRecords = [
    summarizeAcceptanceRunRecord(
      {
        id: "fixture-run",
        workflow: "readiness",
        status: "succeeded",
        repository: { revision: "9".repeat(40) },
        securityScan: { findings: [] },
        securityScanEffectiveDisposition: { status: "advisory" },
        models: [structuredClone(records[0]!.models[0]!)],
      },
      "fixture-run.json",
      "8".repeat(64),
    ),
    summarizeAcceptanceRunRecord(
      {
        id: "self-run",
        workflow: "readiness",
        status: "succeeded",
        repository: { revision },
        securityScan: {
          findings: [{ ruleId: "credential-assigned-secret" }],
        },
        securityScanEffectiveDisposition: { status: "advisory" },
        models: [structuredClone(records[0]!.models[0]!)],
      },
      "self-run.json",
      "a".repeat(64),
    ),
  ];
  const acceptanceRaw = {
    schemaVersion: 1,
    acceptanceId: "acceptance-test",
    testedCommit: revision,
    generatedAt: "2026-08-04T11:00:00.000Z",
    passed: acceptancePassed,
    gates: { live: true, judge: acceptanceJudgeEnabled },
    modelProfiles: {
      policy: profileStatus,
      ...(acceptanceJudgeEnabled ? { judge: "current" } : {}),
    },
    phases: acceptancePhaseIds.map((id) => ({
      id,
      status:
        id === "judge-smoke"
          ? acceptanceJudgeEnabled
            ? "passed"
            : "skipped"
          : !acceptancePassed && id === "check"
            ? "failed"
            : "passed",
      networked: [
        "live-doctor",
        "live-fixture-readiness",
        "live-self-readiness",
        "judge-smoke",
      ].includes(id),
      commit: revision,
      modelProfileStatus: profileStatus,
      durationMs: 1,
      ...(id === "judge-smoke" ? { reason: "judge gate not enabled" } : {}),
    })),
    records: acceptanceRecords,
    ...(acceptanceJudge
      ? {
          judge: {
            file: "judge-result.json",
            sha256: judgeSha256,
            acceptanceId: "acceptance-test",
            testedCommit: revision,
            judgeProfileStatus: "current",
            inputRecords: [
              { id: "fixture-run", sha256: "8".repeat(64) },
              { id: "self-run", sha256: "a".repeat(64) },
            ],
            fixture: { name: "MVP live readiness acceptance", version: 1 },
            structural: { passed: true, recordCount: 2 },
            judge: {
              status: "passed",
              rubric: acceptanceJudge.rubric,
              model: acceptanceJudge.model,
              score: 0.9,
            },
          },
        }
      : {}),
    rawRecordDirectory: "operator-selected acceptance directory",
    ...(!acceptancePassed ? { error: "acceptance runner failed" } : {}),
  };
  const acceptanceBytes = Buffer.from(JSON.stringify(acceptanceRaw));
  const dependencyStatus = options.dependencyStatus ?? "resolved";
  const verification = ["npm-check", "npm-build", "git-diff-check"].map((id) => ({
    id: id as "npm-check" | "npm-build" | "git-diff-check",
    passed: id !== options.verificationFailure,
  }));
  const input = {
    declarationBytes,
    recordLeaves,
    fixtureBytes: Buffer.from(JSON.stringify(fixture)),
    acceptanceBytes,
    ...(judgeBytes ? { judgeBytes } : {}),
    dependency: {
      advisoryId: "GHSA-mh99-v99m-4gvg" as const,
      status: dependencyStatus,
      owner: "docsfab-maintainers" as const,
      ...(dependencyStatus === "contained" ? { reviewOn: "2026-08-17" } : {}),
      packageStateSha256: dependencySha256,
    },
    verification,
    generatorRevision,
  };
  return {
    rawDeclaration,
    declaration,
    declarationBytes,
    recordLeaves,
    records,
    acceptanceBytes,
    input,
  };
}

function buildCampaign(value: CampaignFixture) {
  value.recordLeaves = value.records.map((record) => ({
    file: `${record.id}.json`,
    bytes: Buffer.from(JSON.stringify(record)),
  }));
  const declarations = value.rawDeclaration.records as Array<Record<string, unknown>>;
  for (const [index, leaf] of value.recordLeaves.entries()) {
    declarations[index]!.sha256 = sha256(leaf.bytes);
  }
  const declaredJudge = value.rawDeclaration.judge as Record<string, unknown>;
  if (declaredJudge.status !== "skipped" && value.input.judgeBytes) {
    const artifact = JSON.parse(value.input.judgeBytes.toString("utf8")) as Record<string, unknown>;
    artifact.inputRecords = declarations.map(({ id, sha256: recordSha256 }) => ({
      id,
      sha256: recordSha256,
    }));
    const judgeBytes = Buffer.from(JSON.stringify(artifact));
    declaredJudge.evidenceSha256 = sha256(judgeBytes);
    value.input = { ...value.input, judgeBytes };
  }
  value.declarationBytes = Buffer.from(canonicalJson(value.rawDeclaration));
  value.input = {
    ...value.input,
    declarationBytes: value.declarationBytes,
    recordLeaves: value.recordLeaves,
  };
  return buildMvpScorecard(value.input);
}

function expectInputError(operation: () => unknown, code: ScorecardInputError["code"]): void {
  let error: unknown;
  try {
    operation();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ScorecardInputError);
  expect(error).toMatchObject({ code });
}

describe("MVP stabilization scorecard", () => {
  it("parses and builds an exact five-run campaign with reproducible aggregates", () => {
    const value = campaign();
    const scorecard = buildCampaign(value);

    expect(scorecard.decision).toBe("ready for internal MVP dogfood");
    expect(scorecard.campaign).toMatchObject({
      testedCommit: revision,
      sampleSize: 5,
    });
    expect(scorecard.reliability).toMatchObject({
      sampleSize: 5,
      successes: 5,
      failures: 0,
      observedReliability: { numerator: 5, denominator: 5, percentage: 100 },
      latencyMs: {
        minimum: 100,
        median: 300,
        maximum: 500,
        sum: 1_500,
        mean: 300,
      },
      attempts: 5,
      retries: 0,
    });
    expect(scorecard.reliability.usage).toEqual({
      input: 515,
      output: 115,
      cacheRead: 50,
      cacheWrite: 0,
      total: 680,
      turns: 5,
      cost: 0.15,
    });
    expect(scorecard.runs.map((run) => run.slot)).toEqual([1, 2, 3, 4, 5]);
    expect(scorecard.runs.every((run) => run.structuralPassed)).toBe(true);
  });

  it("emits all three closed decisions from deterministic gate ceilings", () => {
    expect(buildCampaign(campaign()).decision).toBe("ready for internal MVP dogfood");
    expect(buildCampaign(campaign({ dependencyStatus: "contained" })).decision).toBe(
      "ready with contained limitations",
    );
    expect(buildCampaign(campaign({ verificationFailure: "npm-build" })).decision).toBe(
      "not ready",
    );
  });

  it("keeps the observed reliability denominator fixed at five", () => {
    const records = Array.from({ length: 5 }, (_, index) => succeededRecord(index + 1));
    records[4] = contextStoppedRecord(5);
    const scorecard = buildCampaign(campaign({ records }));

    expect(scorecard.reliability.observedReliability).toEqual({
      numerator: 4,
      denominator: 5,
      percentage: 80,
    });
  });

  it("accepts an explained context stop structurally but fails reliability readiness", () => {
    const records = Array.from({ length: 5 }, (_, index) => succeededRecord(index + 1));
    records[4] = contextStoppedRecord(5);
    const scorecard = buildCampaign(campaign({ records }));

    expect(scorecard.structural.passed).toBe(true);
    expect(scorecard.runs[4]).toMatchObject({
      structuralPassed: true,
      successClass: "explained-context-stop",
      failureClass: "context-exhausted",
    });
    expect(scorecard.reliability.terminalFailures["context-exhausted"]).toBe(1);
    expect(scorecard.gates.fiveRunCampaign).toBe("failed");
    expect(scorecard.decision).toBe("not ready");
    const json = serializeMvpScorecard(scorecard);
    const markdown = renderMvpScorecardMarkdown(scorecard);
    expect(() => assertSanitizedScorecardArtifacts(json, markdown)).not.toThrow();
  });

  it("does not credit a governor stop at the tool-call ceiling as an explained context stop", () => {
    const records = Array.from({ length: 5 }, (_, index) => succeededRecord(index + 1));
    records[4] = contextStoppedRecord(5, { contextChars: 10, toolCalls: 13 });
    expect(records[4]!.steps[0]!.inference!.attempts[0]!.turns!.at(-1)).toMatchObject({
      decision: "stop",
      reason: "tool-call-limit",
    });
    const scorecard = buildCampaign(campaign({ records }));

    expect(scorecard.runs[4]).toMatchObject({
      successClass: "failed",
      failureClass: "context-exhausted",
    });
  });

  it("keeps a zero-attempt scanner stop as a policy failure in the denominator", () => {
    const records = Array.from({ length: 5 }, (_, index) => succeededRecord(index + 1));
    records[4] = scannerBlockedRecord(5);
    const scorecard = buildCampaign(campaign({ records }));

    expect(scorecard.runs[4]).toMatchObject({
      successClass: "failed",
      failureClass: "policy-security-blocked",
      attempts: 0,
    });
    expect(scorecard.reliability.observedReliability).toEqual({
      numerator: 4,
      denominator: 5,
      percentage: 80,
    });
    expect(scorecard.decision).toBe("not ready");
  });

  it.each([
    [
      "policy-security-denied",
      (record: RunRecord) => {
        record.securityScanAuthorization = {
          status: "denied",
          overrides: [
            {
              ruleId: "credential-assigned-secret",
              revision,
              reason: "Reviewed scorecard test denial",
              expiresAt: "2026-08-17T00:00:00.000Z",
              decision: "rejected",
              findingCount: 1,
              rejectionRuleId: "override.reason-invalid",
            },
          ],
        };
        record.securityScanEffectiveDisposition = { status: "denied" };
      },
    ],
    [
      "policy-scanner-failed",
      (record: RunRecord) => {
        record.securityScan!.status = "failed";
        record.securityScanEffectiveDisposition = { status: "failed" };
      },
    ],
    [
      "policy-context-preflight",
      (record: RunRecord) => {
        record.securityScan!.status = "passed";
        record.securityScan!.findings = [];
        record.securityScanEffectiveDisposition = { status: "passed" };
      },
    ],
  ] as const)("publishes an authentic zero-attempt %s failure", (failureClass, mutate) => {
    const records = Array.from({ length: 5 }, (_, index) => succeededRecord(index + 1));
    const localStop = scannerBlockedRecord(5);
    mutate(localStop);
    records[4] = localStop;

    const scorecard = buildCampaign(campaign({ records }));

    expect(scorecard.runs[4]).toMatchObject({
      successClass: "failed",
      failureClass,
      attempts: 0,
    });
  });

  it("rejects a substituted weaker structural fixture", () => {
    const value = campaign();
    value.input.fixtureBytes = Buffer.from(
      JSON.stringify({
        version: 1,
        name: fixture.name,
        assertions: [{ type: "run-count", minimum: 1 }],
      }),
    );
    expectInputError(() => buildMvpScorecard(value.input), "structural-evaluation-failed");
  });

  it("rejects acceptance bytes without the required phase and live-record proof", () => {
    const value = campaign();
    const acceptance = JSON.parse(value.acceptanceBytes.toString("utf8"));
    acceptance.phases = [];
    value.input.acceptanceBytes = Buffer.from(JSON.stringify(acceptance));
    expectInputError(() => buildMvpScorecard(value.input), "invalid-acceptance");
  });

  it("rejects acceptance evidence with a forged network phase or future timestamp", () => {
    const networked = campaign();
    const networkedAcceptance = JSON.parse(networked.acceptanceBytes.toString("utf8"));
    networkedAcceptance.phases.find((phase: { id: string }) => phase.id === "check").networked =
      true;
    networked.input.acceptanceBytes = Buffer.from(JSON.stringify(networkedAcceptance));
    expectInputError(() => buildMvpScorecard(networked.input), "invalid-acceptance");

    const future = campaign();
    const futureAcceptance = JSON.parse(future.acceptanceBytes.toString("utf8"));
    futureAcceptance.generatedAt = "2026-08-05T00:00:00.000Z";
    future.input.acceptanceBytes = Buffer.from(JSON.stringify(futureAcceptance));
    expectInputError(() => buildMvpScorecard(future.input), "invalid-provenance");
  });

  it("accepts recorded check limitations only when their measurement selects them", () => {
    const withLimitations = (checkLimitations: unknown) => {
      const value = campaign();
      const acceptance = JSON.parse(value.acceptanceBytes.toString("utf8"));
      acceptance.checkLimitations = checkLimitations;
      value.input.acceptanceBytes = Buffer.from(JSON.stringify(acceptance));
      return value.input;
    };
    const measured = {
      networkDenied: true,
      hostRootOwner: { outside: 0, inside: 65534 },
      excluded: [...ACCEPTANCE_CHECK_LIMITATIONS],
    };

    expect(buildMvpScorecard(withLimitations(measured)).decision).toBe(
      "ready for internal MVP dogfood",
    );
    // The same exclusions from a sandbox that showed the host owner of / are forged.
    expectInputError(
      () =>
        buildMvpScorecard(
          withLimitations({ ...measured, hostRootOwner: { outside: 0, inside: 0 } }),
        ),
      "invalid-acceptance",
    );
  });

  it("binds a non-skipped judge to a separate five-record artifact", () => {
    const value = campaign();
    const raw = structuredClone(value.rawDeclaration);
    (raw.judge as Record<string, unknown>).score = 0.1;
    value.input.declarationBytes = Buffer.from(canonicalJson(raw));
    expectInputError(() => buildMvpScorecard(value.input), "invalid-acceptance");
  });

  it("treats a bound judge error monotonically as not ready", () => {
    const value = campaign({
      judge: {
        status: "error",
        rubric: { id: "docsfab.semantic-evidence-quality", version: 1 },
        model: { provider: "judge-provider", model: "judge/model" },
        evidenceSha256: judgeSha256,
      },
    });
    expect(buildCampaign(value).decision).toBe("not ready");
  });

  it.each([
    [
      "duplicate digest",
      (raw: Record<string, unknown>) => {
        const records = raw.records as Array<Record<string, unknown>>;
        records[1]!.sha256 = records[0]!.sha256;
      },
    ],
    [
      "duplicate id",
      (raw: Record<string, unknown>) => {
        const records = raw.records as Array<Record<string, unknown>>;
        records[1]!.id = records[0]!.id;
        records[1]!.file = records[0]!.file;
      },
    ],
    [
      "uppercase campaign id",
      (raw: Record<string, unknown>) => {
        raw.campaignId = "Wave-3-Mvp";
      },
    ],
    [
      "uppercase record sha256",
      (raw: Record<string, unknown>) => {
        const records = raw.records as Array<Record<string, unknown>>;
        records[0]!.sha256 = "A".repeat(64);
      },
    ],
  ])("rejects a campaign declaration with %s", (_label, mutate) => {
    const raw = structuredClone(campaign().rawDeclaration);
    mutate(raw);
    expectInputError(() => parseScorecardCampaignDeclaration(raw), "invalid-campaign");
  });

  it("rejects duplicate acquisition timestamps and post-evaluation records", () => {
    const duplicate = campaign();
    duplicate.records[1]!.createdAt = duplicate.records[0]!.createdAt;
    expectInputError(() => buildCampaign(duplicate), "invalid-provenance");

    const future = campaign();
    future.records[0]!.completedAt = "2026-08-05T00:00:00.000Z";
    future.records[0]!.durationMs =
      Date.parse(future.records[0]!.completedAt) - Date.parse(future.records[0]!.startedAt!);
    expectInputError(() => buildCampaign(future), "invalid-provenance");
  });

  it("rejects duplicate JSON keys before interpreting evidence", () => {
    const value = campaign({
      judge: {
        status: "skipped",
        owner: "docsfab-maintainers",
        issue: 5,
        reason: "judge-evidence-pending",
        reviewOn: "2026-08-17",
      },
    });
    const original = value.recordLeaves[0]!.bytes.toString("utf8");
    const bytes = Buffer.from(`{"schemaVersion":1,${original.slice(1)}`);
    value.recordLeaves[0] = { ...value.recordLeaves[0]!, bytes };
    const declarations = value.rawDeclaration.records as Array<Record<string, unknown>>;
    declarations[0]!.sha256 = sha256(bytes);
    value.input = {
      ...value.input,
      recordLeaves: value.recordLeaves,
      declarationBytes: Buffer.from(canonicalJson(value.rawDeclaration)),
    };

    expectInputError(() => buildMvpScorecard(value.input), "invalid-record");
  });

  it("rejects a v2 turn-budget discriminator downgrade", () => {
    const records = Array.from({ length: 5 }, (_, index) => succeededRecord(index + 1));
    delete records[0]!.steps[0]!.inference!.attempts[0]!.turns![0]!.contextBudgetSchemaVersion;

    expectInputError(() => buildCampaign(campaign({ records })), "invalid-record");
  });

  it("rejects #34 acceptance from a different policy model", () => {
    const value = campaign();
    const acceptance = JSON.parse(value.acceptanceBytes.toString("utf8"));
    acceptance.records[0].models[0].model = "different/model";
    acceptance.records[1].models[0].model = "different/model";
    value.input.acceptanceBytes = Buffer.from(JSON.stringify(acceptance));

    expectInputError(() => buildMvpScorecard(value.input), "invalid-provenance");
  });

  it.each([
    [
      "record revision",
      (value: CampaignFixture) => {
        value.records[1]!.repository.revision = "7".repeat(40);
      },
    ],
    [
      "record model",
      (value: CampaignFixture) => {
        value.records[1]!.models[0]!.model = "different/model";
      },
    ],
    [
      "profile",
      (value: CampaignFixture) => {
        value.records[1]!.models[0]!.profile!.sha256 = "8".repeat(64);
        value.records[1]!.steps[0]!.inference!.attempts[0]!.model!.profile!.sha256 = "8".repeat(64);
      },
    ],
    [
      "attempt revision",
      (value: CampaignFixture) => {
        value.records[1]!.steps[0]!.inference!.attempts[0]!.identity!.repositoryRevision =
          "9".repeat(40);
      },
    ],
    [
      "attempt model",
      (value: CampaignFixture) => {
        value.records[1]!.steps[0]!.inference!.attempts[0]!.model!.provider = "different-provider";
      },
    ],
  ])("rejects a %s provenance mismatch", (_label, mutate) => {
    const value = campaign();
    mutate(value);
    expectInputError(() => buildCampaign(value), "invalid-record");
  });

  it.each([
    [
      "run usage total",
      (value: CampaignFixture) => {
        value.records[0]!.usage.total += 1;
      },
    ],
    [
      "negative retry backoff",
      (value: CampaignFixture) => {
        const attempt = value.records[0]!.steps[0]!.inference!.attempts[0]!;
        attempt.retryScheduled = true;
        attempt.backoffMs = -1;
      },
    ],
    [
      "step aggregate usage",
      (value: CampaignFixture) => {
        const current = value.records[0]!.steps[0]!.usage!;
        value.records[0]!.steps[0]!.usage = {
          ...current,
          input: current.input + 1,
          total: current.total + 1,
        };
      },
    ],
  ])("rejects invalid arithmetic in %s", (_label, mutate) => {
    const value = campaign();
    mutate(value);
    expectInputError(() => buildCampaign(value), "invalid-record");
  });

  it("normalizes floating retry costs at the shared twelve-decimal boundary", () => {
    const value = campaign();
    const first = value.records[0]!;
    const rawCost = 0.1 + 0.2;
    first.steps[0]!.inference!.attempts[0]!.usage!.cost = rawCost;
    first.steps[0]!.usage!.cost = rawCost;
    first.usage.cost = rawCost;

    const scorecard = buildCampaign(value);

    expect(scorecard.runs[0]!.usage.cost).toBe(0.3);
    expect(scorecard.reliability.usage.cost).toBe(0.44);
  });

  it("preserves sub-micro campaign cost without renderer-scale drift", () => {
    const value = campaign();
    value.records.forEach((record) => {
      record.steps[0]!.inference!.attempts[0]!.usage!.cost = 0.0000001;
      record.steps[0]!.usage!.cost = 0.0000001;
      record.usage.cost = 0.0000001;
    });

    expect(buildCampaign(value).reliability.usage.cost).toBe(0.0000005);
  });

  it("reconciles retry recovery, incidents, attempts, and scheduled backoff", () => {
    const value = campaign();
    const record = value.records[0]!;
    const step = record.steps[0]!;
    const succeeded = structuredClone(step.inference!.attempts[0]!);
    succeeded.attempt = 2;
    const timedOut = structuredClone(succeeded);
    timedOut.attempt = 1;
    timedOut.outcome = "timeout";
    timedOut.retryable = true;
    timedOut.retryScheduled = true;
    timedOut.backoffMs = 100;
    timedOut.usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      turns: 1,
      cost: 0,
    };
    timedOut.tools = { totalCalls: 0, failedCalls: 0, byTool: [] };
    timedOut.turns!.forEach((turn) => {
      turn.toolCalls = 0;
      turn.toolResults = 0;
    });
    step.inference = {
      ...step.inference!,
      configuredMaxRetries: 1,
      effectiveMaxRetries: 1,
      baseDelayMs: 100,
      maxDelayMs: 100,
      attempts: [timedOut, succeeded],
    };
    step.durationMs = 120;
    step.completedAt = new Date(Date.parse(step.startedAt!) + 120).toISOString();
    step.usage!.turns = 2;
    record.usage.turns = 2;
    record.durationMs = 120;
    record.completedAt = new Date(Date.parse(record.startedAt!) + 120).toISOString();

    const scorecard = buildCampaign(value);

    expect(scorecard.reliability).toMatchObject({
      firstAttemptSuccesses: 4,
      recoveredRuns: 1,
      attempts: 6,
      retries: 1,
      scheduledBackoffMs: 100,
      incidents: { timeout: 1 },
    });
  });

  it.each([
    ["acceptance", campaign({ acceptancePassed: false })],
    ["dependency", campaign({ dependencyStatus: "failed" })],
    ["npm check", campaign({ verificationFailure: "npm-check" })],
    ["npm build", campaign({ verificationFailure: "npm-build" })],
    ["git diff check", campaign({ verificationFailure: "git-diff-check" })],
    // A legacy record that ran under the stale projection.
    ["profile provenance", campaign({ profileStatus: "stale" })],
  ])("turns a failed %s gate into not ready", (_label, value) => {
    expect(buildCampaign(value).decision).toBe("not ready");
  });

  it("scores current records evaluated after their review date", () => {
    const value = campaign({ profileStatus: "current", profileReviewAfter: "2026-08-03" });
    expect(value.declaration.evaluatedAt.slice(0, 10) > "2026-08-03").toBe(true);
    const scorecard = buildCampaign(value);
    expect(scorecard.gates.modelProfileProvenance).toBe("passed");
    expect(scorecard.decision).toBe(buildCampaign(campaign()).decision);
    expect(scorecard.decision).not.toBe("not ready");
  });

  it("still refuses a contained dependency whose review date has passed", () => {
    // Adjacent condition: only the model profile review date is advisory; the
    // dependency containment review date keeps its refusal.
    const value = campaign({ dependencyStatus: "contained" });
    value.input = {
      ...value.input,
      dependency: { ...value.input.dependency, reviewOn: "2026-08-03" },
    };
    expectInputError(() => buildCampaign(value), "invalid-dependency");
  });

  it("is byte-deterministic when private record leaves arrive in another order", () => {
    const value = campaign();
    const forward = buildCampaign(value);
    const reversed = buildMvpScorecard({
      ...value.input,
      recordLeaves: [...value.recordLeaves].reverse(),
    });

    expect(canonicalJson(reversed)).toBe(canonicalJson(forward));
  });

  it("does not project free text, host paths, or raw errors into committed output", () => {
    const value = campaign();
    const serialized = canonicalJson(buildCampaign(value));

    for (const sentinel of [
      "PRIVATE_INSTRUCTION_SENTINEL",
      "PRIVATE_SUMMARY_SENTINEL",
      "/private/repository-",
      "requestedRevision",
      "sourcePath",
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
    expect(serialized).toContain("operator-private");
  });

  it.each([
    "blank-response",
    "malformed-response",
    "timeout",
    "throttled",
    "provider-transient",
    "provider-terminal",
    "invalid-request",
  ] as const)("keeps the %s terminal failure class distinct", (failure) => {
    const records = Array.from({ length: 5 }, (_, index) => succeededRecord(index + 1));
    const failed = records[4]!;
    failed.status = "failed";
    failed.steps[0]!.status = "failed";
    const attempt = failed.steps[0]!.inference!.attempts[0]!;
    attempt.outcome = failure as InferenceFailureCategory;
    attempt.retryable = false;
    attempt.retryScheduled = false;
    const scorecard = buildCampaign(campaign({ records }));

    expect(scorecard.runs[4]!.failureClass).toBe(failure);
    expect(scorecard.reliability.terminalFailures[failure]).toBe(1);
    expect(scorecard.decision).toBe("not ready");
  });
});
