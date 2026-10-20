// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelEndpointConfig } from "../src/model/configuration.js";
import type { ModelEvidence, RunRecord } from "../src/records/contracts.js";
import { modelProfileEvidenceSha256 } from "../src/model/profile-evidence.js";

export const testedCommit = "a".repeat(40);
const packetDigest = "c".repeat(64);

export const judgeConfig: ModelEndpointConfig = {
  providerId: "judge-provider",
  baseUrl: "https://judge.example.test/v1",
  modelId: "judge/model",
  apiFormat: "chat_completions",
  api: "openai-completions",
  apiKey: "unused-test-secret",
  requestPolicy: { minimumOutputTokens: 16, reservedContextTokens: 128 },
  profile: {
    configuredLimits: {
      contextWindow: 128_000,
      maxInputTokens: 128_000,
      maxOutputTokens: 16_384,
    },
    contextWindow: 128_000,
    maxInputTokens: 128_000,
    maxOutputTokens: 16_384,
    effectiveLimitReason: "none",
    reasoning: false,
    input: ["text"],
    compatibility: {
      supportsDeveloperRole: true,
      supportsReasoningEffort: false,
      apiFormats: ["chat_completions"],
    },
    costPerMillionTokens: {
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
    },
    metadata: {
      approvedSource: "https://metadata.example.test/judge",
      effectiveDate: "2026-08-01",
      reviewAfter: "2026-09-01",
      status: "current",
    },
  },
};

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function modelEvidence(): ModelEvidence {
  const provider = "policy-provider";
  const model = "policy/model";
  const profile = {
    schemaVersion: 1 as const,
    status: "current" as const,
    configuredContextWindow: 128_000,
    effectiveContextWindow: 128_000,
    configuredMaxOutputTokens: 16_384,
    effectiveMaxOutputTokens: 16_384,
    effectiveLimitReason: "none" as const,
    apiFormat: "chat_completions" as const,
    reasoning: false,
    input: ["text" as const],
    compatibility: {
      supportsDeveloperRole: true,
      supportsReasoningEffort: false,
      apiFormats: ["chat_completions" as const],
    },
    requestPolicy: { minimumOutputTokens: 16, reservedContextTokens: 128 },
    costPerMillionTokens: { input: null, output: null, cacheRead: null, cacheWrite: null },
    pricing: "unknown" as const,
    approvedSourceSha256: "d".repeat(64),
    effectiveDate: "2026-08-01",
    reviewAfter: "2026-09-01",
  };
  return {
    provider,
    model,
    profile: { ...profile, sha256: modelProfileEvidenceSha256({ provider, model, profile }) },
  };
}

export function campaignRecord(slot: number, structuralFailure = false): RunRecord {
  const startedAt = new Date(Date.UTC(2026, 7, 4, 0, 0, slot)).toISOString();
  const completedAt = new Date(Date.parse(startedAt) + slot * 100).toISOString();
  const identity = {
    repositoryRevision: testedCommit,
    contextPacketDigest: packetDigest,
    consultedNodeIds: ["node-a"],
  };
  const evidenceDigest = sha256(JSON.stringify(identity, Object.keys(identity).sort()));
  const model = modelEvidence();
  const tools = { totalCalls: 0, failedCalls: 0, byTool: [] };
  const usage = {
    input: slot,
    output: slot,
    cacheRead: 0,
    cacheWrite: 0,
    total: slot * 2,
    turns: 1,
  };
  const skill = {
    id: "doc-context-analyzer",
    contentSha256: "f".repeat(64),
    bundleSha256: "1".repeat(64),
    version: "1.0.0",
    license: "Apache-2.0",
    source: {
      repository: "https://example.test/skills.git",
      revision: testedCommit,
      path: "skills/doc-context-analyzer/SKILL.md",
    },
    inputs: [{ name: "repository", description: "Selected repository" }],
    outputs: [{ name: "summary", description: "Readiness summary" }],
    toolPolicy: { declared: ["read"], granted: ["read"], withheld: [] },
  };
  return {
    schemaVersion: 2,
    id: `run-${slot}`,
    workflow: "readiness",
    repository: {
      sourcePath: `/PRIVATE_HOST_PATH_SENTINEL/${slot}`,
      requestedRevision: "HEAD",
      revision: testedCommit,
    },
    workspace: { strategy: "tracked-export", disposable: true },
    instruction: "PRIVATE_INSTRUCTION_SENTINEL",
    status: "succeeded",
    createdAt: startedAt,
    startedAt,
    completedAt,
    durationMs: slot * 100,
    models: [structuredClone(model)],
    skills: structuralFailure ? [] : [structuredClone(skill)],
    usage: structuredClone(usage),
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
        model: structuredClone(model),
        ...(structuralFailure ? {} : { skillEvidence: structuredClone(skill) }),
        tools: structuredClone(tools),
        usage: structuredClone(usage),
        durationMs: slot * 10,
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
        summary: "PRIVATE_SUMMARY_SENTINEL api_key=abcdefghijklmnopqrstuvwx",
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
              tools: structuredClone(tools),
              usage: structuredClone(usage),
              identity,
              turns: [
                {
                  turn: 1,
                  toolCalls: 0,
                  toolResults: 0,
                  maxProviderTurns: 12,
                  maxToolCalls: 12,
                  compactions: 0,
                  maxCompactions: 8,
                  configuredContextWindow: 128_000,
                  effectiveContextWindow: 128_000,
                  configuredMaxOutputTokens: 16_384,
                  effectiveMaxOutputTokens: 16_384,
                  reservedTokens: 128,
                  estimatedInputTokens: 1_000,
                  availableOutputTokens: 126_872,
                  requiredMinimumOutputTokens: 16,
                  outputTokens: 16_384,
                  decision: "proceed",
                  requestDigest: "2".repeat(64),
                  evidenceDigest,
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

const phaseIds = [
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
] as const;

function acceptanceManifest(judgeSha256: string, model = judgeConfig.modelId): unknown {
  return {
    schemaVersion: 1,
    acceptanceId: "acceptance-scorecard",
    testedCommit,
    generatedAt: "2026-08-04T11:00:00.000Z",
    passed: true,
    gates: { live: true, judge: true },
    modelProfiles: { policy: "current", judge: "current" },
    phases: phaseIds.map((id) => ({
      id,
      status: "passed",
      networked: [
        "live-doctor",
        "live-fixture-readiness",
        "live-self-readiness",
        "judge-smoke",
      ].includes(id),
      commit: testedCommit,
      modelProfileStatus: "current",
      durationMs: 1,
    })),
    records: [
      {
        file: "acceptance-fixture.json",
        sha256: "4".repeat(64),
        id: "acceptance-fixture",
        workflow: "readiness",
        status: "succeeded",
        revision: "5".repeat(40),
        scanDisposition: "advisory",
        ruleIds: [],
        models: [
          {
            provider: "policy-provider",
            model: "policy/model",
            profileSha256: modelEvidence().profile!.sha256,
          },
        ],
      },
      {
        file: "acceptance-self.json",
        sha256: "6".repeat(64),
        id: "acceptance-self",
        workflow: "readiness",
        status: "succeeded",
        revision: testedCommit,
        scanDisposition: "advisory",
        ruleIds: ["credential.private-key"],
        models: [
          {
            provider: "policy-provider",
            model: "policy/model",
            profileSha256: modelEvidence().profile!.sha256,
          },
        ],
      },
    ],
    judge: {
      file: "judge-result.json",
      sha256: judgeSha256,
      acceptanceId: "acceptance-scorecard",
      testedCommit,
      judgeProfileStatus: "current",
      inputRecords: [
        { id: "acceptance-fixture", sha256: "4".repeat(64) },
        { id: "acceptance-self", sha256: "6".repeat(64) },
      ],
      fixture: { name: "MVP live readiness acceptance", version: 1 },
      structural: { passed: true, recordCount: 2 },
      judge: {
        status: "passed",
        rubric: { id: "docsfab.semantic-evidence-quality", version: 1 },
        model: { provider: judgeConfig.providerId, model },
        score: 0.9,
      },
    },
    rawRecordDirectory: "operator-selected acceptance directory",
  };
}

export interface CampaignInputs {
  root: string;
  stateDirectory: string;
  campaignDirectory: string;
  acceptanceDirectory: string;
  declaration: Record<string, unknown>;
  args: string[];
}

export async function createCampaignInputs(
  input: { structuralFailure?: boolean; acceptanceModel?: string } = {},
): Promise<CampaignInputs> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-campaign-judge-test-"));
  const stateDirectory = join(root, "records");
  const campaignDirectory = join(root, "campaign");
  const acceptanceDirectory = join(root, "acceptance");
  await Promise.all(
    [stateDirectory, campaignDirectory, acceptanceDirectory].map((directory) =>
      mkdir(directory, { mode: 0o700 }),
    ),
  );
  const records = [];
  for (let slot = 1; slot <= 5; slot += 1) {
    const record = campaignRecord(slot, input.structuralFailure === true && slot === 5);
    const file = `${record.id}.json`;
    const bytes = await writePrivateJson(stateDirectory, file, record);
    records.push({ slot, file, id: record.id, sha256: sha256(bytes) });
  }
  const acceptanceJudge = {
    schemaVersion: 1,
    acceptanceId: "acceptance-scorecard",
    testedCommit,
    judgeProfileStatus: "current",
    inputRecords: [
      { id: "acceptance-fixture", sha256: "4".repeat(64) },
      { id: "acceptance-self", sha256: "6".repeat(64) },
    ],
    fixture: { name: "MVP live readiness acceptance", version: 1 },
    structural: { passed: true, recordCount: 2 },
    judge: {
      status: "passed",
      rubric: { id: "docsfab.semantic-evidence-quality", version: 1 },
      model: {
        provider: judgeConfig.providerId,
        model: input.acceptanceModel ?? judgeConfig.modelId,
      },
      score: 0.9,
    },
  };
  const acceptanceJudgeBytes = await writePrivateJson(
    acceptanceDirectory,
    "judge-result.json",
    acceptanceJudge,
  );
  await writePrivateJson(
    acceptanceDirectory,
    "manifest.json",
    acceptanceManifest(digest(acceptanceJudgeBytes), input.acceptanceModel),
  );
  const declaration: Record<string, unknown> = {
    schemaVersion: 1,
    campaignId: "mvp-stabilization-01",
    evaluatedAt: "2026-08-04T12:00:00.000Z",
    testedCommit,
    records,
    judge: {
      status: "skipped",
      owner: "docsfab-maintainers",
      issue: 5,
      reason: "judge-evidence-pending",
      reviewOn: "2026-08-17",
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
  await writePrivateJson(campaignDirectory, "campaign.json", declaration);
  return {
    root,
    stateDirectory,
    campaignDirectory,
    acceptanceDirectory,
    declaration,
    args: [
      "--state-dir",
      stateDirectory,
      "--campaign-dir",
      campaignDirectory,
      "--acceptance-dir",
      acceptanceDirectory,
      "--judge",
      "--approve-judge-url",
      judgeConfig.baseUrl,
    ],
  };
}

export async function writePrivateJson(
  directory: string,
  file: string,
  value: unknown,
): Promise<Buffer> {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  await writeFile(join(directory, file), bytes, { mode: 0o600 });
  return bytes;
}

export function digest(bytes: Buffer): string {
  return sha256(bytes);
}
