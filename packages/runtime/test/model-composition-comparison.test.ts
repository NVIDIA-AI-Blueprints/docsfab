// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { chmod, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { createObservableWorkspaceWithoutRequiredChecks } from "./helpers/observable-workspace.js";

import { canonicalDigest } from "../src/content-ir/canonical.js";
import type { AgentHarness } from "../src/execution/contracts.js";
import type { BoundModelExecutionProfile } from "../src/model/configuration.js";
import { modelProfileEvidenceSha256 } from "../src/model/profile-evidence.js";
import {
  MAX_COMPOSITION_COMPARISON_RECORD_BYTES,
  CompositionComparisonError,
  compareCompositionRunRecordFiles as compareCompositionRunRecordFilesStrict,
  loadInstalledModelCompositionAuthority,
  resolveInstalledExecutableComposition,
  type BoundExecutableComposition,
  type CompositionModelLimits,
} from "../src/model-composition/index.js";
import { governProviderTurn } from "../src/model/turn-governor.js";
import {
  handleCompositionCommand,
  parseCompositionCliArguments,
} from "../src/native-compositions/index.js";
import type {
  ModelEvidence,
  ModelProfileEvidence,
  QualityPackEvidenceV1,
  RunRecord,
  SkillEvidence,
} from "../src/records/contracts.js";
import {
  createCompositionExecutionAggregate,
  createCompositionExecutionEvidence,
  type CompositionExecutionEvidenceV1,
} from "../src/records/composition-execution.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import type { WorkflowOutcomeDecodeOptionsV1 } from "../src/workflow-contracts/outcome.js";
import {
  documentationPlanBindingDigest,
  type DocumentationPlanMode,
} from "../src/workflow-execution/plan-binding.js";
import { AuthoringQualityWorkflowOutcomeProjector } from "../src/evaluation-report/authoring-outcome-projector.js";
import { scriptedEditorialProtocol } from "./helpers/editorial-protocol.js";
import {
  inventorySearchCoordinatorFixture,
  preservationSourceObserverFixture,
  verificationFixture,
} from "./helpers/verification.js";
import { temporaryRoots } from "./helpers/temp.js";

const REVISION = "a".repeat(64);
const SOURCE_PATH = "/private/comparison-source";
const temporaryDirectories = temporaryRoots();
const originalExitCode = process.exitCode;
const recordDecodeOptions = new WeakMap<RunRecord, WorkflowOutcomeDecodeOptionsV1>();
const pathDecodeOptions = new Map<string, WorkflowOutcomeDecodeOptionsV1>();

interface FixtureOptions {
  compositionId?: "nvidia-inference-gpt-6-sol-pi" | "anthropic-claude-opus-4.7-pi";
  revision?: string;
  instruction?: string;
  skillVariant?: string;
  contextDigest?: string;
  maxProviderTurns?: number;
  providerTurns?: 1 | 2;
  qualityPack?: QualityPackEvidenceV1;
  workflow?: "update-documentation" | "restructure-documentation";
}

afterEach(async () => {
  process.exitCode = originalExitCode;
  pathDecodeOptions.clear();
});

describe("provider-offline composition record comparison", () => {
  it("compares distinct compositions on one exact fixture without inventing a winner", async () => {
    const records = await comparableRecords();

    const report = await compareRecords(records);

    expect(report).toMatchObject({
      schemaVersion: 1,
      kind: "docsfab-composition-comparison/v1",
      comparable: true,
      mismatchCode: null,
      ranking: {
        winnerCompositionId: null,
        reason: "quality-efficacy-unavailable",
      },
      runs: [
        {
          compositionId: "nvidia-inference-gpt-6-sol-pi",
          usage: { total: 21, turns: 7 },
          tools: { totalCalls: 0, failedCalls: 0 },
          productDisposition: "inconclusive",
          quality: { result: "unavailable", score: null },
        },
        {
          compositionId: "anthropic-claude-opus-4.7-pi",
          usage: { total: 21, turns: 7 },
        },
      ],
    });
    expect(report.comparisonBindingSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.reportSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(report)).toBe(true);
    expect(JSON.stringify(report)).not.toContain(SOURCE_PATH);
  });

  it.each([
    ["workflow-mismatch", { workflow: "restructure-documentation" }],
    ["repository-mismatch", { revision: "b".repeat(64) }],
    ["task-mismatch", { instruction: "A different exact fixture instruction." }],
    ["quality-pack-mismatch", { qualityPack: qualityPack() }],
    ["skill-set-mismatch", { skillVariant: "alternate" }],
    ["context-input-mismatch", { contextDigest: "c".repeat(64) }],
    ["experiment-budget-mismatch", { maxProviderTurns: 3 }],
  ] as const)("returns the closed %s code", async (code, secondOverrides) => {
    const first = await compositionRunRecord();
    const second = await compositionRunRecord({
      compositionId: "anthropic-claude-opus-4.7-pi",
      ...secondOverrides,
    });

    const report = await compareRecords([first, second]);

    expect(report.comparable).toBe(false);
    expect(report.mismatchCode).toBe(code);
    expect(report.comparisonBindingSha256).toBeNull();
    expect(report.ranking.winnerCompositionId).toBeNull();
  });

  it("rejects a duplicate composition even when every fixture binding matches", async () => {
    const first = await compositionRunRecord();
    const second = await compositionRunRecord();

    await expect(compareRecords([first, second])).resolves.toMatchObject({
      comparable: false,
      mismatchCode: "duplicate-composition",
    });
  });

  it("keeps realized turn counts as performance rather than budget identity", async () => {
    const first = await compositionRunRecord();
    const second = await compositionRunRecord({
      compositionId: "anthropic-claude-opus-4.7-pi",
      providerTurns: 2,
    });

    const report = await compareRecords([first, second]);

    expect(report).toMatchObject({
      comparable: true,
      mismatchCode: null,
      runs: [{ usage: { turns: 7 } }, { usage: { turns: 14 } }],
    });
  });

  it("strictly loads bounded leaves and compares files without provider calls", async () => {
    const [first, second] = await comparableRecords();
    const directory = await temporaryDirectory();
    const firstPath = join(directory, "first.json");
    const secondPath = join(directory, "second.json");
    await Promise.all([writeRecord(firstPath, first), writeRecord(secondPath, second)]);

    const report = await compareCompositionRunRecordFiles([firstPath, secondPath]);

    expect(report.comparable).toBe(true);
  });

  it("parses and renders the bounded comparison CLI without model or provider access", async () => {
    const [first, second] = await comparableRecords();
    const directory = await temporaryDirectory();
    const firstPath = join(directory, "first.json");
    const secondPath = join(directory, "second.json");
    await Promise.all([writeRecord(firstPath, first), writeRecord(secondPath, second)]);
    expect(
      parseCompositionCliArguments([
        "compare",
        "--record",
        firstPath,
        "--record",
        secondPath,
        "--json",
      ]),
    ).toEqual({ command: "compare", recordPaths: [firstPath, secondPath], json: true });
    const output: string[] = [];

    await handleCompositionCommand(
      ["compare", "--record", firstPath, "--record", secondPath, "--json"],
      {
        log: (line) => output.push(line),
        comparisonDecodeOptions: fixtureComparisonDecodeOptions,
      },
    );

    expect(JSON.parse(output.join("\n"))).toMatchObject({ comparable: true });
    expect(process.exitCode ?? 0).toBe(0);
    expect(() =>
      parseCompositionCliArguments([
        "compare",
        "--record",
        "relative.json",
        "--record",
        secondPath,
      ]),
    ).toThrow("absolute-json");
  });

  it("rejects credential-shaped content and unknown run-record keys content-free", async () => {
    const directory = await temporaryDirectory();
    const secret = `sk-${"s".repeat(32)}`;
    const secretRecord = await compositionRunRecord({ instruction: secret });
    const secretPath = join(directory, "secret.json");
    const validPath = join(directory, "valid.json");
    await writeRecord(secretPath, secretRecord);
    await writeRecord(
      validPath,
      await compositionRunRecord({
        compositionId: "anthropic-claude-opus-4.7-pi",
      }),
    );

    let secretFailure: unknown;
    try {
      await compareCompositionRunRecordFiles([secretPath, validPath]);
    } catch (error) {
      secretFailure = error;
    }
    expect(secretFailure).toEqual(new CompositionComparisonError("credential-material"));
    expect(String(secretFailure)).not.toContain(secret);

    const extra = structuredClone(await compositionRunRecord()) as RunRecord & { unexpected: true };
    extra.unexpected = true;
    const extraPath = join(directory, "extra.json");
    await writeRecord(extraPath, extra);
    await expect(compareCompositionRunRecordFiles([extraPath, validPath])).rejects.toMatchObject({
      code: "invalid-run-record",
    });
  });

  it.each(["installedManifestSha256", "compositionSha256", "candidateSha256"] as const)(
    "rejects a self-consistent target-supplied %s outside the installed trust root",
    async (field) => {
      const forged = await compositionRunRecord();
      const execution = structuredClone(forged.compositionExecution!);
      const { evidenceSha256: _oldEvidence, ...compositionBody } = {
        ...execution,
        digests: { ...execution.digests, [field]: "0".repeat(64) },
      };
      const tamperedProto = {
        ...compositionBody,
        evidenceSha256: canonicalDigest(compositionBody),
      };
      forged.compositionExecution = tamperedProto;
      forged.compositionExecutionAggregate = createCompositionExecutionAggregate({
        compositionExecution: tamperedProto,
        run: forged,
        workflow: getWorkflow(forged.workflow),
      });
      const valid = await compositionRunRecord({
        compositionId: "anthropic-claude-opus-4.7-pi",
      });

      await expect(compareRecords([forged, valid])).rejects.toMatchObject({
        code: "invalid-run-record",
      });
    },
  );

  it("rejects symlinked and oversized record leaves before parsing", async () => {
    const directory = await temporaryDirectory();
    const recordPath = join(directory, "record.json");
    const linkPath = join(directory, "record-link.json");
    await writeRecord(recordPath, await compositionRunRecord());
    await symlink(recordPath, linkPath);

    const validPath = join(directory, "valid.json");
    await writeRecord(
      validPath,
      await compositionRunRecord({
        compositionId: "anthropic-claude-opus-4.7-pi",
      }),
    );
    await expect(compareCompositionRunRecordFiles([linkPath, validPath])).rejects.toMatchObject({
      code: "unsafe-record-file",
    });

    const oversized = join(directory, "oversized.json");
    await writeFile(oversized, Buffer.alloc(MAX_COMPOSITION_COMPARISON_RECORD_BYTES + 1, 0x20), {
      mode: 0o600,
    });
    await expect(compareCompositionRunRecordFiles([oversized, validPath])).rejects.toMatchObject({
      code: "record-too-large",
    });
  });

  it("rejects a run record whose leaf permissions are not owner-private", async () => {
    const [first, second] = await comparableRecords();
    const directory = await temporaryDirectory();
    const firstPath = join(directory, "first.json");
    const secondPath = join(directory, "second.json");
    await Promise.all([writeRecord(firstPath, first), writeRecord(secondPath, second)]);
    await chmod(firstPath, 0o644);

    await expect(compareCompositionRunRecordFiles([firstPath, secondPath])).rejects.toMatchObject({
      code: "unsafe-record-file",
    });
  });

  it("normalizes missing-leaf OS failures without exposing the path", async () => {
    const directory = await temporaryDirectory();
    const validPath = join(directory, "valid.json");
    const missingPath = join(directory, "private-missing-record.json");
    await writeRecord(
      validPath,
      await compositionRunRecord({
        compositionId: "anthropic-claude-opus-4.7-pi",
      }),
    );

    let failure: unknown;
    try {
      await compareCompositionRunRecordFiles([missingPath, validPath]);
    } catch (error) {
      failure = error;
    }
    expect(failure).toEqual(new CompositionComparisonError("unsafe-record-file"));
    expect(String(failure)).not.toContain(missingPath);
  });

  it("bounds record count before reading any file", async () => {
    await expect(compareCompositionRunRecordFiles([])).rejects.toMatchObject({
      code: "invalid-record-count",
    });
    await expect(
      compareCompositionRunRecordFiles(Array.from({ length: 9 }, () => "/does/not/exist.json")),
    ).rejects.toMatchObject({ code: "invalid-record-count" });
  });
});

async function comparableRecords(): Promise<[RunRecord, RunRecord]> {
  return [
    await compositionRunRecord(),
    await compositionRunRecord({ compositionId: "anthropic-claude-opus-4.7-pi" }),
  ];
}

async function compareRecords(records: readonly RunRecord[]) {
  const directory = await temporaryDirectory();
  const paths = await Promise.all(
    records.map(async (record, index) => {
      const path = join(directory, `record-${index}.json`);
      await writeRecord(path, record);
      return path;
    }),
  );
  return compareCompositionRunRecordFiles(paths);
}

async function compositionRunRecord(options: FixtureOptions = {}): Promise<RunRecord> {
  const compositionId = options.compositionId ?? "nvidia-inference-gpt-6-sol-pi";
  const workflow = options.workflow ?? "update-documentation";
  const revision = options.revision ?? REVISION;
  const maxProviderTurns = options.maxProviderTurns ?? 4;
  const evidence = await compositionEvidence(compositionId, workflow, revision, maxProviderTurns);
  const model = compositionModelEvidence(evidence);
  let clock = Date.parse("2026-08-23T00:00:00.000Z");
  const protocol = scriptedEditorialProtocol(
    harness(model, options.skillVariant ?? "default", maxProviderTurns, options.providerTurns ?? 1),
  );
  const runner = new WorkflowRunner({
    ...protocol,
    hostOperations: {
      runStep: async () => ({ summary: "fixture host operation", outcome: "succeeded" as const }),
    },
    store: { save: async () => undefined },
    repositoryScanner: {
      scan: async () => ({
        ruleSet: "credential-rules-v1",
        status: "passed",
        scannedFiles: 1,
        binaryFiles: 0,
        findings: [],
      }),
    },
    contextPreflight: options.contextDigest
      ? {
          preflight: async () => ({
            status: "ready",
            packetDigest: options.contextDigest!,
            consultedNodeIds: ["node:fixture"],
            ontologyVersion: "fixture-v1",
            effectiveDecisionIds: [],
            measurements: {
              byteLength: 1,
              estimatedTokens: 1,
              latencyMs: 1,
              nodeCount: 1,
              edgeCount: 0,
              pathCount: 1,
            },
            cache: { disposition: "disabled", rebuildAttempted: true },
            packet: { schemaVersion: 1, digest: options.contextDigest! },
          }),
        }
      : {
          preflight: async () => ({
            status: "unnecessary",
            reason: "policy-marked-unnecessary",
          }),
        },
    workflowSearch: inventorySearchCoordinatorFixture,
    sourceObligationObserver: preservationSourceObserverFixture(revision),
    repositoryEvidence: {
      capture: async () => ({
        files: [{ path: "README.md", status: "modified" }],
        patch: {
          sha256: "f".repeat(64),
          byteLength: 42,
          lineCount: 1,
          artifactPath: "/private/state/comparison.patch",
          format: "git-diff",
        },
      }),
    },
    impactPostflight: {
      postflight: async () => ({
        schemaVersion: 1,
        status: "completed",
        analysisDigest: "7".repeat(64),
        changedPaths: ["README.md"],
      }),
    },
    outcomeProjector: new AuthoringQualityWorkflowOutcomeProjector(),
    ...(options.qualityPack ? { qualityPackEvidence: options.qualityPack } : {}),
    id: () => `run-${compositionId}`,
    now: () => new Date((clock += 100)),
  });
  const workspace = await createObservableWorkspaceWithoutRequiredChecks();
  temporaryDirectories.track(workspace.path);
  const record = await runner.run({
    workflow,
    workspacePath: workspace.path,
    repository: { sourcePath: SOURCE_PATH, requestedRevision: "HEAD", revision },
    instruction: options.instruction ?? "Polish one exact documentation fixture.",
    allowWrite: true,
    compositionExecution: evidence,
  });
  expect(record.status, record.error).toBe("succeeded");
  recordDecodeOptions.set(record, protocol.decodeOptions);
  return record;
}

async function compositionEvidence(
  compositionId: NonNullable<FixtureOptions["compositionId"]>,
  workflow: NonNullable<FixtureOptions["workflow"]>,
  revision: string,
  maxProviderTurns: number,
): Promise<CompositionExecutionEvidenceV1> {
  const { authority } = await loadInstalledModelCompositionAuthority();
  const bound = resolveInstalledExecutableComposition({
    authority,
    compositionId,
    workflowId: workflow,
  });
  const configuredLimits = limits(maxProviderTurns);
  return createCompositionExecutionEvidence({
    runId: `run-${compositionId}`,
    bound,
    executionProfile: executionProfile(bound, configuredLimits),
    configuredLimits,
    workflow: { id: bound.workflow.workflowId, sourceSha256: bound.workflow.sourceSha256 },
    repository: {
      identitySha256: createHash("sha256").update(SOURCE_PATH).digest("hex"),
      revision,
    },
  });
}

function limits(maxProviderTurns: number): CompositionModelLimits {
  return {
    contextWindow: 100_000,
    maxInputTokens: 90_000,
    maxOutputTokens: 10_000,
    maxProviderTurns,
    // At or below every compared record's sealed timeout (the GPT-6 Sol hub
    // record seals 1_800_000, Opus 4.7 seals 300_000), so both land on the same
    // effective limit and the pair stays budget-comparable.
    timeoutMs: 300_000,
    maxResponseBytes: 100_000,
  };
}

function executionProfile(
  bound: BoundExecutableComposition,
  configured: CompositionModelLimits,
): BoundModelExecutionProfile {
  const transport = bound.composition.deployment.transport;
  const apiFormat = transport === "anthropic-messages" ? "messages" : "chat_completions";
  return {
    routeId: bound.composition.deployment.routeId,
    providerId: bound.composition.deployment.routeId,
    baseUrl: "https://provider.example.test/v1",
    modelId: bound.composition.model.resolvedId,
    transport,
    apiFormat,
    profile: {
      configuredLimits: {
        contextWindow: configured.contextWindow,
        maxInputTokens: configured.maxInputTokens,
        maxOutputTokens: configured.maxOutputTokens,
      },
      contextWindow: 65_536,
      maxInputTokens: 65_536,
      maxOutputTokens: 8_192,
      effectiveLimitReason: "composition-candidate",
      reasoning: false,
      input: ["text"],
      compatibility: {
        supportsDeveloperRole: true,
        supportsReasoningEffort: false,
        apiFormats: [apiFormat],
      },
      costPerMillionTokens: { input: null, output: null, cacheRead: null, cacheWrite: null },
      metadata: {
        approvedSource: null,
        effectiveDate: null,
        reviewAfter: null,
        status: "unknown",
      },
    },
    requestPolicy: { minimumOutputTokens: 16, reservedContextTokens: 128 },
    compositionPolicy: {
      maxProviderTurns: Math.min(configured.maxProviderTurns, 4),
      timeoutMs: 300_000,
      // Derived, not pinned: this must equal the installed composition's
      // effective limit or the evidence is rejected as `subject-mismatch`.
      maxResponseBytes: configured.maxResponseBytes,
    },
  };
}

function compositionModelEvidence(
  evidence: CompositionExecutionEvidenceV1,
): ModelEvidence & { profile: ModelProfileEvidence } {
  const provider = evidence.deployment.routeId;
  const model = evidence.model.resolvedId;
  const apiFormat =
    evidence.deployment.transport === "anthropic-messages" ? "messages" : "chat_completions";
  const profile: Omit<ModelProfileEvidence, "sha256"> = {
    schemaVersion: 2,
    status: "unknown",
    configuredContextWindow: evidence.limits.configured.contextWindow,
    effectiveContextWindow: evidence.limits.effective.contextWindow,
    configuredMaxInputTokens: evidence.limits.configured.maxInputTokens,
    effectiveMaxInputTokens: evidence.limits.effective.maxInputTokens,
    configuredMaxOutputTokens: evidence.limits.configured.maxOutputTokens,
    effectiveMaxOutputTokens: evidence.limits.effective.maxOutputTokens,
    effectiveLimitReason: "composition-candidate",
    apiFormat,
    reasoning: false,
    input: ["text"],
    compatibility: {
      supportsDeveloperRole: true,
      supportsReasoningEffort: false,
      apiFormats: [apiFormat],
    },
    requestPolicy: { minimumOutputTokens: 16, reservedContextTokens: 128 },
    costPerMillionTokens: { input: null, output: null, cacheRead: null, cacheWrite: null },
    pricing: "unknown",
  };
  return {
    provider,
    model,
    profile: { ...profile, sha256: modelProfileEvidenceSha256({ provider, model, profile }) },
  };
}

function harness(
  model: ModelEvidence & { profile: ModelProfileEvidence },
  skillVariant: string,
  maxProviderTurns: number,
  providerTurns: 1 | 2,
): AgentHarness {
  return {
    inspectSkill: async ({ step }) => skill(step.skill, skillVariant),
    runStep: async (input) => {
      const governed = governProviderTurn({
        context: { messages: [{ role: "user", content: "Perform the offline fixture." }] },
        policy: {
          budget: {
            configuredContextWindow: model.profile.configuredContextWindow,
            effectiveContextWindow: model.profile.effectiveContextWindow,
            configuredMaxInputTokens: model.profile.configuredMaxInputTokens!,
            effectiveMaxInputTokens: model.profile.effectiveMaxInputTokens!,
            configuredMaxOutputTokens: model.profile.configuredMaxOutputTokens,
            effectiveMaxOutputTokens: model.profile.effectiveMaxOutputTokens,
            reservedTokens: model.profile.requestPolicy.reservedContextTokens,
            requiredMinimumOutputTokens: model.profile.requestPolicy.minimumOutputTokens,
          },
          maxProviderTurns,
          maxToolCalls: 12,
          maxCompactions: 8,
          minRecentToolTurns: 1,
        },
        state: { providerTurns: 0, toolCalls: 0, toolResults: 0, compactions: 0 },
        evidenceIdentity: input.evidenceIdentity!,
        pinnedMessageCount: 0,
      });
      const second =
        providerTurns === 2
          ? governProviderTurn({
              context: { messages: [{ role: "user", content: "Perform the offline fixture." }] },
              policy: {
                budget: {
                  configuredContextWindow: model.profile.configuredContextWindow,
                  effectiveContextWindow: model.profile.effectiveContextWindow,
                  configuredMaxInputTokens: model.profile.configuredMaxInputTokens!,
                  effectiveMaxInputTokens: model.profile.effectiveMaxInputTokens!,
                  configuredMaxOutputTokens: model.profile.configuredMaxOutputTokens,
                  effectiveMaxOutputTokens: model.profile.effectiveMaxOutputTokens,
                  reservedTokens: model.profile.requestPolicy.reservedContextTokens,
                  requiredMinimumOutputTokens: model.profile.requestPolicy.minimumOutputTokens,
                },
                maxProviderTurns,
                maxToolCalls: 12,
                maxCompactions: 8,
                minRecentToolTurns: 1,
              },
              state: governed.nextState,
              evidenceIdentity: input.evidenceIdentity!,
              pinnedMessageCount: 0,
            })
          : undefined;
      const turns = [governed.evidence, ...(second ? [second.evidence] : [])];
      const verification = await verificationFixture(input);
      return {
        summary: verification.summary ?? "Completed the provider-offline fixture.",
        ...(input.step.id === "plan-documentation"
          ? {
              planBinding: documentationPlanBinding(
                input.workflow.name === "update-documentation"
                  ? "update"
                  : input.workflow.name === "restructure-documentation"
                    ? "restructure"
                    : "create",
              ),
            }
          : {}),
        model: structuredClone(model),
        skill: skill(input.step.skill, skillVariant),
        ...verification,
        usage: {
          input: 2 * providerTurns,
          output: providerTurns,
          cacheRead: 0,
          cacheWrite: 0,
          total: 3 * providerTurns,
          turns: providerTurns,
        },
        tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
        turns,
      };
    },
  };
}

function documentationPlanBinding(mode: DocumentationPlanMode, pagePath = "README.md") {
  const pages = [{ path: pagePath, disposition: mode }];
  const sourceBindings = [{ pagePath, sources: ["README.md"] }];
  return {
    kind: "docsfab-documentation-plan" as const,
    schemaVersion: 1 as const,
    mode,
    pages,
    sourceBindings,
    digest: documentationPlanBindingDigest({ mode, pages, sourceBindings }),
  };
}

function skill(id: string, variant: string): SkillEvidence {
  return {
    id,
    contentSha256: canonicalDigest({ id, variant }),
    bundleSha256: canonicalDigest({ bundle: id, variant }),
    version: "1.0.0",
    license: "Apache-2.0",
    source: { repository: "skill-catalog", revision: REVISION, path: `skills/${id}/SKILL.md` },
    toolPolicy: { declared: [], granted: [], withheld: [] },
  };
}

function qualityPack(): QualityPackEvidenceV1 {
  return {
    schemaVersion: 1,
    id: "docsfab-default",
    version: "1.0.0",
    manifestSha256: "1".repeat(64),
    bindingSha256: "2".repeat(64),
    skillLockSha256: "3".repeat(64),
    qualityLockSha256: "4".repeat(64),
    qualityBundleSha256: "5".repeat(64),
    barIds: ["first-job"],
  };
}

function temporaryDirectory(): Promise<string> {
  return temporaryDirectories.create("docsfab-comparison-", { realpath: true });
}

async function writeRecord(path: string, record: unknown): Promise<void> {
  const decodeOptions =
    record && typeof record === "object" ? recordDecodeOptions.get(record as RunRecord) : undefined;
  if (decodeOptions) pathDecodeOptions.set(path, decodeOptions);
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

const fixtureComparisonDecodeOptions = {
  resolveWorkflowOutcomeDecodeOptions: async (_record: Readonly<RunRecord>, path: string) =>
    pathDecodeOptions.get(path),
};

function compareCompositionRunRecordFiles(paths: readonly string[]) {
  return compareCompositionRunRecordFilesStrict(paths, fixtureComparisonDecodeOptions);
}
