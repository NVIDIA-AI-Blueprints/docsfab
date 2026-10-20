// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  openAcceptanceJsonExclusive,
  readAcceptanceJsonLeaves,
  type AcceptanceEvidenceWriteOptions,
  type AcceptanceJsonLeaf,
} from "./acceptance-evidence.js";
import { pinPrivateOperatorEvidenceDirectory } from "./operator/private-state.js";
import { loadModelEndpointForInspection } from "./config/runtime-loader.js";
import { assertApprovedJudgeDestination } from "./judge-destination.js";
import { bindJudgeResultEnvelope, parseJudgeResultArtifact } from "./judge-result-artifact.js";
import type { ModelEndpointConfig } from "./model/configuration.js";
import type { EvaluationJudge, JudgeResult } from "./quality-evaluation/contracts.js";
import { DOCSFAB_SEMANTIC_EVIDENCE_QUALITY_ID } from "./quality-evaluation/rubric-identifiers.js";
import { ConfiguredEvaluationJudge } from "./quality-evaluation/semantic.js";
import { evaluateRuns, loadEvaluationFixture } from "./quality-evaluation/structural.js";
import { detectCredentialRuleIdsInValue } from "./security/repository-scanner.js";
import {
  parseScorecardAcceptanceEvidence,
  parseScorecardCampaignDeclaration,
} from "./scorecard.js";
import { parseScorecardRunRecord } from "./scorecard-record.js";
import { authorizeSecurityScan } from "./security/scan-override.js";
import { resolveSecurityScanEffectiveDisposition } from "./security/scan-disposition.js";
import { sha256 as digest } from "./content-ir/canonical.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = join(
  projectRoot,
  "test/fixtures/runtime-evaluation/fixtures/turn-governance-live-readiness.json",
);
const RESULT_FILE = "judge-result.json";
const SECURITY_SCAN_POLICY = {
  authorizeSecurityScan,
  resolveSecurityScanEffectiveDisposition,
} as const;

export class CampaignJudgeError extends Error {
  constructor(public readonly code: string) {
    super(`Campaign judge failed (${code}).`);
    this.name = "CampaignJudgeError";
  }
}

export interface CampaignJudgeCliResult {
  exitCode: number;
  deterministicPassed: boolean;
  judgeStatus: "passed" | "disagreed" | "error" | "skipped";
  reason?: "structural-evaluation-failed";
  evidenceSha256?: string;
  declarationJudge?: {
    status: "passed" | "disagreed" | "error";
    rubric: { id: typeof DOCSFAB_SEMANTIC_EVIDENCE_QUALITY_ID; version: 1 };
    model: { provider: string; model: string };
    score?: number;
    evidenceSha256: string;
  };
}

export interface CampaignJudgeDependencies {
  environment: NodeJS.ProcessEnv;
  loadJudgeConfiguration(): ModelEndpointConfig;
  createJudge(config: ModelEndpointConfig): EvaluationJudge;
  publicationOptions: AcceptanceEvidenceWriteOptions;
}

interface CampaignJudgeOptions {
  stateDirectory: string;
  campaignDirectory: string;
  acceptanceDirectory: string;
  approvedJudgeUrl: string;
  judge: boolean;
}

export function parseCampaignJudgeOptions(args: string[]): CampaignJudgeOptions {
  const values = new Map<string, string>();
  let judge = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--judge") {
      if (judge) fail("duplicate-option");
      judge = true;
      continue;
    }
    if (
      !["--state-dir", "--campaign-dir", "--acceptance-dir", "--approve-judge-url"].includes(
        argument,
      )
    )
      fail("unknown-option");
    const value = args[index + 1];
    if (!value || value.startsWith("--") || values.has(argument)) fail("invalid-option");
    values.set(argument, value);
    index += 1;
  }
  const stateDirectory = values.get("--state-dir");
  const campaignDirectory = values.get("--campaign-dir");
  const acceptanceDirectory = values.get("--acceptance-dir");
  const approvedJudgeUrl = values.get("--approve-judge-url");
  if (!stateDirectory || !campaignDirectory || !acceptanceDirectory || !approvedJudgeUrl) {
    fail("missing-option");
  }
  const options = {
    stateDirectory: resolve(stateDirectory),
    campaignDirectory: resolve(campaignDirectory),
    acceptanceDirectory: resolve(acceptanceDirectory),
    approvedJudgeUrl,
    judge,
  };
  assertSeparateDirectories(options);
  return options;
}

export function validateCampaignJudgeGate(input: {
  enabled: boolean;
  approvedJudgeUrl: string;
  environment: NodeJS.ProcessEnv;
  judgeConfig?: ModelEndpointConfig;
}): ModelEndpointConfig {
  if (!input.enabled || input.environment.DOCSFAB_CAMPAIGN_JUDGE !== "true") {
    fail("judge-not-authorized");
  }
  if (!input.judgeConfig || input.environment.JUDGE_ENABLED !== "true") {
    fail("judge-not-configured");
  }
  const destination = assertApprovedJudgeDestination({
    configured: input.judgeConfig.baseUrl,
    environment: input.environment.JUDGE_BASE_URL,
    approved: input.approvedJudgeUrl,
  });
  if (!destination.ok) {
    fail("judge-destination-not-approved");
  }
  if (input.judgeConfig.profile.metadata.status !== "current") {
    fail("judge-profile-not-current");
  }
  return input.judgeConfig;
}

/** Run the exact five-record semantic campaign without changing deterministic disposition. */
export async function runCampaignJudgeCli(
  args: string[],
  dependencies: Partial<CampaignJudgeDependencies> = {},
): Promise<CampaignJudgeCliResult> {
  const options = parseCampaignJudgeOptions(args);
  const environment = dependencies.environment ?? process.env;
  if (!options.judge || environment.DOCSFAB_CAMPAIGN_JUDGE !== "true") {
    fail("judge-not-authorized");
  }
  const judgeConfiguration = (
    dependencies.loadJudgeConfiguration ?? (() => loadModelEndpointForInspection("judge"))
  )();
  const judgeConfig = validateCampaignJudgeGate({
    enabled: options.judge,
    approvedJudgeUrl: options.approvedJudgeUrl,
    environment,
    judgeConfig: judgeConfiguration,
  });
  const judge = (dependencies.createJudge ?? ((config) => new ConfiguredEvaluationJudge(config)))(
    judgeConfig,
  );
  if (
    judge.identity.provider !== judgeConfig.providerId ||
    judge.identity.model !== judgeConfig.modelId
  )
    fail("judge-identity-mismatch");

  const state = await pinPrivateOperatorEvidenceDirectory(options.stateDirectory);
  const campaign = await pinPrivateOperatorEvidenceDirectory(options.campaignDirectory);
  const acceptance = await pinPrivateOperatorEvidenceDirectory(options.acceptanceDirectory);
  const [recordLeaves, campaignLeaves, acceptanceLeaves] = await Promise.all([
    readAcceptanceJsonLeaves(state),
    readAcceptanceJsonLeaves(campaign),
    readAcceptanceJsonLeaves(acceptance),
  ]);
  if (recordLeaves.length !== 5) fail("invalid-record-set");
  if (files(campaignLeaves) !== "campaign.json") fail("invalid-campaign");
  if (files(acceptanceLeaves) !== "judge-result.json\nmanifest.json") fail("invalid-acceptance");

  const campaignLeaf = campaignLeaves[0]!;
  const declaration = parseScorecardCampaignDeclaration(campaignLeaf.value);
  if (declaration.judge.status !== "skipped") fail("invalid-campaign");
  const manifestLeaf = acceptanceLeaves.find((leaf) => leaf.file === "manifest.json")!;
  const acceptanceJudgeLeaf = acceptanceLeaves.find((leaf) => leaf.file === RESULT_FILE)!;
  const accepted = parseScorecardAcceptanceEvidence(manifestLeaf.value, digest(manifestLeaf.bytes));
  if (
    !accepted.passed ||
    !accepted.live ||
    !accepted.judge ||
    accepted.judge.status === "error" ||
    accepted.testedCommit !== declaration.testedCommit ||
    accepted.judge.model.provider !== judge.identity.provider ||
    accepted.judge.model.model !== judge.identity.model ||
    !acceptanceJudgeArtifactMatches(
      manifestLeaf.value,
      acceptanceJudgeLeaf.value,
      digest(acceptanceJudgeLeaf.bytes),
    )
  ) {
    fail("acceptance-judge-mismatch");
  }

  const byFile = new Map(recordLeaves.map((leaf) => [leaf.file, leaf]));
  const ordered = declaration.records.map((declared) => {
    const leaf = byFile.get(declared.file);
    if (!leaf || digest(leaf.bytes) !== declared.sha256) fail("invalid-record-set");
    const record = parseScorecardRunRecord(leaf.value);
    if (record.id !== declared.id || record.repository.revision !== declaration.testedCommit) {
      fail("invalid-record-set");
    }
    return { declared, leaf, record };
  });
  if (new Set(ordered.map(({ leaf }) => leaf.file)).size !== 5) fail("invalid-record-set");

  const fixture = await loadEvaluationFixture(fixturePath);
  const evaluated = await evaluateRuns({
    fixture,
    records: ordered.map(({ record }) => record),
    judge,
    workflowOutcomeDecodeOptions: () => SECURITY_SCAN_POLICY,
  });
  if (!evaluated.structural.passed || evaluated.judge?.status === "skipped") {
    return {
      exitCode: 1,
      deterministicPassed: false,
      judgeStatus: "skipped",
      reason: "structural-evaluation-failed",
    };
  }
  const artifact = campaignArtifact(
    declaration.campaignId,
    declaration.testedCommit,
    ordered.map(({ declared }) => ({ id: declared.id, sha256: declared.sha256 })),
    fixture,
    evaluated.judge,
  );
  if (detectCredentialRuleIdsInValue(artifact).length > 0) fail("unsafe-artifact");

  // A judge request can be slow; require every private input to remain byte-identical
  // before the exclusive result publication.
  await Promise.all([
    assertLeavesUnchanged(state, recordLeaves),
    assertLeavesUnchanged(campaign, campaignLeaves),
    assertLeavesUnchanged(acceptance, acceptanceLeaves),
  ]);
  const publication = await openAcceptanceJsonExclusive(
    campaign,
    RESULT_FILE,
    artifact,
    dependencies.publicationOptions,
  );
  try {
    await Promise.all([
      assertLeavesUnchanged(state, recordLeaves),
      assertLeavesUnchanged(acceptance, acceptanceLeaves),
      assertCampaignPublished(campaign, campaignLeaves, artifact),
    ]);
    await publication.assertStable();
    await publication.close();
  } catch (error) {
    await publication.invalidate();
    throw error;
  }
  const evidenceSha256 = digest(serializedArtifact(artifact));
  const declarationJudge = { ...artifact.judge, evidenceSha256 };
  return {
    // The command successfully captured an advisory result. Only deterministic
    // structural failure makes this invocation unsuccessful.
    exitCode: 0,
    deterministicPassed: true,
    judgeStatus: artifact.judge.status,
    evidenceSha256,
    declarationJudge,
  };
}

async function assertCampaignPublished(
  directory: Awaited<ReturnType<typeof pinPrivateOperatorEvidenceDirectory>>,
  original: AcceptanceJsonLeaf[],
  artifact: unknown,
): Promise<void> {
  const actual = await readAcceptanceJsonLeaves(directory);
  if (files(actual) !== "campaign.json\njudge-result.json") fail("input-changed");
  const campaign = actual.find((leaf) => leaf.file === "campaign.json");
  const result = actual.find((leaf) => leaf.file === RESULT_FILE);
  if (
    !campaign ||
    !result ||
    campaign.file !== original[0]?.file ||
    digest(campaign.bytes) !== digest(original[0]!.bytes) ||
    digest(result.bytes) !== digest(serializedArtifact(artifact))
  ) {
    fail("input-changed");
  }
}

function campaignArtifact(
  campaignId: string,
  testedCommit: string,
  inputRecords: Array<{ id: string; sha256: string }>,
  fixture: { name: string; version: 1 },
  judge: JudgeResult | undefined,
) {
  const bound = bindJudgeResultEnvelope(judge);
  if (!bound.ok) fail(bound.code);
  return {
    schemaVersion: 1 as const,
    campaignId,
    testedCommit,
    inputRecords,
    fixture: { name: fixture.name, version: fixture.version },
    structural: { passed: true as const, recordCount: 5 as const },
    judge: {
      ...bound.envelope,
      rubric: { id: DOCSFAB_SEMANTIC_EVIDENCE_QUALITY_ID, version: 1 as const },
    },
  };
}

async function assertLeavesUnchanged(
  directory: Awaited<ReturnType<typeof pinPrivateOperatorEvidenceDirectory>>,
  expected: AcceptanceJsonLeaf[],
): Promise<void> {
  const actual = await readAcceptanceJsonLeaves(directory);
  if (
    actual.length !== expected.length ||
    actual.some(
      (leaf, index) =>
        leaf.file !== expected[index]?.file ||
        digest(leaf.bytes) !== digest(expected[index]!.bytes),
    )
  )
    fail("input-changed");
}

function acceptanceJudgeArtifactMatches(
  manifestValue: unknown,
  artifactValue: unknown,
  artifactSha256: string,
): boolean {
  const manifest = plainObject(manifestValue);
  const embedded = manifest && plainObject(manifest.judge);
  const artifact = exactAcceptanceJudgeArtifact(artifactValue);
  if (
    !embedded ||
    !artifact ||
    embedded.file !== RESULT_FILE ||
    embedded.sha256 !== artifactSha256 ||
    Object.keys(embedded).sort().join("\n") !==
      [
        "acceptanceId",
        "file",
        "fixture",
        "inputRecords",
        "judge",
        "judgeProfileStatus",
        "sha256",
        "structural",
        "testedCommit",
      ]
        .sort()
        .join("\n")
  ) {
    return false;
  }
  const { schemaVersion: _schemaVersion, ...artifactEvidence } = artifact;
  const { file: _file, sha256: _sha256, ...manifestEvidence } = embedded;
  return canonical(artifactEvidence) === canonical(manifestEvidence);
}

function exactAcceptanceJudgeArtifact(value: unknown) {
  return parseJudgeResultArtifact(value, "campaign-acceptance");
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
    ? (value as Record<string, unknown>)
    : undefined;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = plainObject(value);
  if (!object) return "";
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
}

function serializedArtifact(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function assertSeparateDirectories(options: CampaignJudgeOptions): void {
  const paths = [options.stateDirectory, options.campaignDirectory, options.acceptanceDirectory];
  if (new Set(paths).size !== paths.length) fail("overlapping-inputs");
  for (const [index, left] of paths.entries()) {
    for (const right of paths.slice(index + 1)) {
      if (left.startsWith(`${right}/`) || right.startsWith(`${left}/`)) fail("overlapping-inputs");
    }
  }
}

function files(leaves: AcceptanceJsonLeaf[]): string {
  return leaves
    .map((leaf) => leaf.file)
    .sort()
    .join("\n");
}

function fail(code: string): never {
  throw new CampaignJudgeError(code);
}
