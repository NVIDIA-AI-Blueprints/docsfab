// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";

import { createObservableWorkspaceWithoutRequiredChecks } from "./helpers/observable-workspace.js";
import {
  asCompositionRecord,
  compositionEvidenceFor,
  compositionModelEvidence,
} from "./helpers/composition-record.js";
import { scriptedEditorialProtocol } from "./helpers/editorial-protocol.js";
import {
  inventorySearchCoordinatorFixture,
  preservationSourceObserverFixture,
  verificationFixture,
} from "./helpers/verification.js";

import { canonicalDigest } from "../src/content-ir/canonical.js";
import {
  decodeSuccessfulPublicationRunRecord,
  PublicationRunRecordDecodeError,
} from "../src/delivery/run-record.js";
import type { AgentHarness } from "../src/execution/contracts.js";
import { decodeModelEvidence } from "../src/execution/inference-evidence.js";
import { decodeSkillEvidence } from "../src/scorecard-record.js";
import { governProviderTurn } from "../src/model/turn-governor.js";
import {
  CompositionComparisonError,
  compareCompositionRunRecordFiles,
} from "../src/model-composition/comparison.js";
import type { RunRecord, SkillEvidence, StepRunRecord } from "../src/records/contracts.js";
import {
  answerRecordContinuationPrefixSha256,
  RunRecordCompositionError,
  verifyRunRecordComposition,
} from "../src/records/composition-execution.js";
import { AuthoringQualityWorkflowOutcomeProjector } from "../src/evaluation-report/authoring-outcome-projector.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { createDocumentationPlanBinding } from "../src/workflow-execution/plan-binding.js";

const roots: string[] = [];
const sourcePath = "/private/answer-record-boundary-fixture";
const revision = "a".repeat(40);
const digestA = "a".repeat(64);
const digestB = "b".repeat(64);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      const { rm } = await import("node:fs/promises");
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("answer-record continuation record boundaries", () => {
  it("admits a successful child and accounts only for its physical suffix", async () => {
    const { source, decodeOptions } = await succeededCompositionRun();
    for (const step of source.steps) {
      if (step.model)
        expect(() => decodeModelEvidence(step.model), `${step.id} model`).not.toThrow();
      if (step.skillEvidence) {
        expect(() => decodeSkillEvidence(step.skillEvidence), `${step.id} skill`).not.toThrow();
      }
    }
    // Keep a positive control at the exact strict reader boundary. This pins
    // whether a failure below is caused by the continuation projection or by
    // the ordinary source fixture itself.
    expect(() => decodeSuccessfulPublicationRunRecord(source, decodeOptions)).not.toThrow();
    const child = await continuationChild(source);

    expect(decodeChild(child, decodeOptions)).toEqual(child);
    expect(() => verifyRunRecordComposition(child, getWorkflow(child.workflow))).not.toThrow();
    expect(child.compositionExecutionAggregate).toBeUndefined();

    const inherited = child.steps.filter((step) => step.inheritedFrom !== undefined);
    const physical = child.steps.filter((step) => step.inheritedFrom === undefined);
    expect(inherited).toHaveLength(child.steps.length - 1);
    expect(physical.map((step) => step.id)).toEqual(["evaluate-document-quality"]);
    expect(child.usage).toEqual(
      physical.reduce((sum, step) => addUsage(sum, step.usage), emptyUsage()),
    );
    expect(child.tools).toEqual(
      physical.reduce((sum, step) => addTools(sum, step.tools), emptyTools()),
    );
    expect(child.models).toEqual(physical.flatMap((step) => (step.model ? [step.model] : [])));
    expect(child.skills).toEqual(
      physical.flatMap((step) => (step.skillEvidence ? [step.skillEvidence] : [])),
    );

    const doubleCountedInheritedCosts = structuredClone(child);
    doubleCountedInheritedCosts.usage = sumUsage(doubleCountedInheritedCosts.steps);
    doubleCountedInheritedCosts.tools = sumTools(doubleCountedInheritedCosts.steps);
    expect(() =>
      decodeSuccessfulPublicationRunRecord(doubleCountedInheritedCosts, decodeOptions),
    ).toThrow(PublicationRunRecordDecodeError);
  });

  it("does not admit an ordinary succeeded composition run without its aggregate", async () => {
    const { source, decodeOptions } = await succeededCompositionRun();
    const missingAggregate = structuredClone(source);
    delete missingAggregate.compositionExecutionAggregate;

    expect(() =>
      verifyRunRecordComposition(missingAggregate, getWorkflow(source.workflow)),
    ).toThrow(expect.objectContaining({ code: "composition-aggregate-missing" }));
    expect(() => decodeSuccessfulPublicationRunRecord(missingAggregate, decodeOptions)).toThrow(
      PublicationRunRecordDecodeError,
    );
  });

  it("rejects altered inherited content and altered receipt data", async () => {
    const { source, decodeOptions } = await succeededCompositionRun();
    const child = await continuationChild(source);
    const changedPrefix = structuredClone(child);
    changedPrefix.steps[0]!.summary = `${changedPrefix.steps[0]!.summary} changed`;
    expect(() => decodeSuccessfulPublicationRunRecord(changedPrefix, decodeOptions)).toThrow(
      PublicationRunRecordDecodeError,
    );

    const changedReceipt = structuredClone(child);
    changedReceipt.answerRecordContinuation = {
      ...changedReceipt.answerRecordContinuation!,
      sourceRunRecordSha256: digestB,
    };
    expect(() => decodeSuccessfulPublicationRunRecord(changedReceipt, decodeOptions)).toThrow(
      PublicationRunRecordDecodeError,
    );
  });

  it("refuses continuation children as fresh composition-comparison qualification", async () => {
    const { source, decodeOptions } = await succeededCompositionRun();
    const child = await continuationChild(source);
    expect(() => decodeChild(child, decodeOptions)).not.toThrow();

    const directory = await temporaryDirectory();
    const childPath = `${directory}/child.json`;
    const sourcePath = `${directory}/source.json`;
    await writeRecord(childPath, child);
    await writeRecord(sourcePath, source);
    const options = {
      resolveWorkflowOutcomeDecodeOptions: async (_record: Readonly<RunRecord>) => decodeOptions,
    };

    await expect(
      compareCompositionRunRecordFiles([sourcePath, sourcePath], options),
    ).resolves.toMatchObject({
      comparable: false,
      mismatchCode: "duplicate-composition",
    });
    const comparisonError = await compareCompositionRunRecordFiles(
      [childPath, sourcePath],
      options,
    ).catch((error: unknown) => error);
    expect(comparisonError).toBeInstanceOf(CompositionComparisonError);
    expect((comparisonError as CompositionComparisonError).code).toBe("invalid-run-record");
  });
});

async function succeededCompositionRun(): Promise<{
  source: RunRecord;
  decodeOptions: ReturnType<typeof scriptedEditorialProtocol>["decodeOptions"];
}> {
  const workspace = await createObservableWorkspaceWithoutRequiredChecks();
  roots.push(workspace.path);
  let clock = Date.parse("2026-09-01T00:00:00.000Z");
  const compositionExecution = await compositionEvidenceFor({
    runId: "continuation-boundary-source",
    workflow: "update-documentation",
    sourcePath,
    revision,
  });
  const model = compositionModelEvidence(compositionExecution);
  const skill = (id: string): SkillEvidence => ({
    id,
    contentSha256: canonicalDigest({ id }),
    bundleSha256: canonicalDigest({ bundle: id }),
    version: "1.0.0",
    license: "Apache-2.0",
    source: { repository: "skill-catalog", revision, path: `skills/${id}/SKILL.md` },
    toolPolicy: { declared: [], granted: [], withheld: [] },
  });
  const harness: AgentHarness = {
    inspectSkill: async ({ step }) => skill(step.skill),
    runStep: async (input) => ({
      summary:
        input.step.skill === "review-documentation"
          ? JSON.stringify({ verdict: "pass", issues: [] })
          : `completed ${input.step.skill}`,
      ...(input.step.id === "plan-documentation"
        ? {
            planBinding: createDocumentationPlanBinding({
              mode: "update",
              pages: [{ path: "README.md", disposition: "update" }],
              sourceBindings: [{ pagePath: "README.md", sources: ["README.md"] }],
            }),
          }
        : {}),
      ...(await verificationFixture(input)),
      ...(input.step.mode === "read-only" && (input.step.kind ?? "inference") === "evaluate"
        ? { editorialAssessmentProposal: {} }
        : {}),
      model,
      skill: skill(input.step.skill),
      usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, total: 3, turns: 1 },
      tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
      turns: [
        governProviderTurn({
          context: {
            messages: [{ role: "user", content: "Run the continuation boundary fixture." }],
          },
          policy: {
            budget: {
              configuredContextWindow: model.profile!.configuredContextWindow,
              effectiveContextWindow: model.profile!.effectiveContextWindow,
              configuredMaxInputTokens: model.profile!.configuredMaxInputTokens!,
              effectiveMaxInputTokens: model.profile!.effectiveMaxInputTokens!,
              configuredMaxOutputTokens: model.profile!.configuredMaxOutputTokens,
              effectiveMaxOutputTokens: model.profile!.effectiveMaxOutputTokens,
              reservedTokens: model.profile!.requestPolicy.reservedContextTokens,
              requiredMinimumOutputTokens: model.profile!.requestPolicy.minimumOutputTokens,
            },
            maxProviderTurns: 1,
            maxToolCalls: 1,
            maxCompactions: 0,
            minRecentToolTurns: 1,
          },
          state: { providerTurns: 0, toolCalls: 0, toolResults: 0, compactions: 0 },
          evidenceIdentity: input.evidenceIdentity!,
          pinnedMessageCount: 0,
        }).evidence,
      ],
    }),
  };
  const protocol = scriptedEditorialProtocol(harness);
  const runner = new WorkflowRunner({
    ...protocol,
    hostOperations: {
      runStep: async () => ({ summary: "fixture host operation", outcome: "succeeded" as const }),
    },
    store: { save: async () => undefined },
    repositoryScanner: {
      scan: async () => ({
        ruleSet: "fixture",
        status: "passed" as const,
        scannedFiles: 1,
        binaryFiles: 0,
        findings: [],
      }),
    },
    contextPreflight: {
      preflight: async () => ({
        status: "unnecessary" as const,
        reason: "policy-marked-unnecessary" as const,
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
          artifactPath: "/private/state/answer-record-boundary.patch",
          format: "git-diff" as const,
        },
      }),
    },
    impactPostflight: {
      postflight: async () => ({
        schemaVersion: 1 as const,
        status: "completed" as const,
        analysisDigest: digestB,
        changedPaths: ["README.md"],
      }),
    },
    outcomeProjector: new AuthoringQualityWorkflowOutcomeProjector(),
    id: () => "continuation-boundary-source",
    now: () => new Date((clock += 100)),
  });
  const run = await runner.run({
    workflow: "update-documentation",
    workspacePath: workspace.path,
    repository: { sourcePath, requestedRevision: "HEAD", revision },
    instruction: "Polish one exact documentation fixture.",
    allowWrite: true,
    compositionExecution,
  });
  expect(run.status, run.error).toBe("succeeded");
  return { source: run, decodeOptions: protocol.decodeOptions };
}

async function continuationChild(source: RunRecord): Promise<RunRecord> {
  const sourceDigest = canonicalDigest(source);
  const childId = "continuation-boundary-child";
  const child = structuredClone(source);
  child.id = childId;
  child.workflowOutcome = undefined;
  const composed = await asCompositionRecord(child);
  const evaluatorIndex = composed.steps.findIndex(
    (step) => step.id === "evaluate-document-quality",
  );
  expect(evaluatorIndex).toBeGreaterThan(0);
  const inheritedPrefix = composed.steps.slice(0, evaluatorIndex);
  for (const step of inheritedPrefix) {
    step.inheritedFrom = {
      sourceRunId: source.id,
      sourceRunRecordSha256: sourceDigest,
      sourceStepId: step.id,
    };
  }
  const evaluator = composed.steps[evaluatorIndex]!;
  const sourcePointer = { sha256: digestA, sequence: 1, attempt: 1 };
  const childPointer = { sha256: digestB, sequence: 2, attempt: 1 };
  evaluator.answerRecordCheckpoint = childPointer;
  evaluator.answerRecordLedger = {
    schemaVersion: 1,
    kind: "docsfab-answer-record-ledger-index",
    contractId: "quality-evaluation",
    bindingsSha256: digestA,
    rows: [],
    checkpoint: childPointer,
    progress: {
      admittedRowCount: 0,
      releasedRowCount: 0,
      remainingKeyCount: 0,
      refusalEventCount: 0,
      complete: true,
      checkpointSequence: 2,
      logicalRunId: source.id,
      sourceRunId: childId,
      sourceAttemptHighWater: 1,
    },
  };
  composed.usage = sumUsage([evaluator]);
  composed.tools = sumTools([evaluator]);
  composed.models = evaluator.model ? [evaluator.model] : [];
  composed.skills = evaluator.skillEvidence ? [evaluator.skillEvidence] : [];
  delete composed.compositionExecutionAggregate;
  composed.answerRecordContinuation = {
    schemaVersion: 1,
    kind: "docsfab-answer-record-continuation-receipt",
    sourceRunId: source.id,
    sourceRunRecordSha256: sourceDigest,
    checkpointSha256: sourcePointer.sha256,
    checkpointSequence: sourcePointer.sequence,
    checkpointAttempt: sourcePointer.attempt,
    logicalRunId: source.id,
    inheritedPrefixSha256: answerRecordContinuationPrefixSha256(inheritedPrefix),
  };
  expect(composed.steps.every((step) => step.status === "succeeded")).toBe(true);
  return composed;
}

function emptyUsage(): RunRecord["usage"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 };
}

function addUsage(total: RunRecord["usage"], usage: StepRunRecord["usage"]): RunRecord["usage"] {
  if (!usage) return total;
  return {
    input: total.input + usage.input,
    output: total.output + usage.output,
    cacheRead: total.cacheRead + usage.cacheRead,
    cacheWrite: total.cacheWrite + usage.cacheWrite,
    total: total.total + usage.total,
    turns: total.turns + usage.turns,
  };
}

function emptyTools(): RunRecord["tools"] {
  return { totalCalls: 0, failedCalls: 0, byTool: [] };
}

function addTools(total: RunRecord["tools"], tools: StepRunRecord["tools"]): RunRecord["tools"] {
  if (!tools) return total;
  return {
    totalCalls: total.totalCalls + tools.totalCalls,
    failedCalls: total.failedCalls + tools.failedCalls,
    byTool: tools.byTool,
  };
}

function sumUsage(steps: readonly StepRunRecord[]): RunRecord["usage"] {
  return steps.reduce((sum, step) => addUsage(sum, step.usage), emptyUsage());
}

function sumTools(steps: readonly StepRunRecord[]): RunRecord["tools"] {
  const byTool = new Map<string, { name: string; calls: number; failures: number }>();
  for (const step of steps) {
    for (const tool of step.tools?.byTool ?? []) {
      const prior = byTool.get(tool.name) ?? { name: tool.name, calls: 0, failures: 0 };
      prior.calls += tool.calls;
      prior.failures += tool.failures;
      byTool.set(tool.name, prior);
    }
  }
  return {
    totalCalls: [...byTool.values()].reduce((sum, item) => sum + item.calls, 0),
    failedCalls: [...byTool.values()].reduce((sum, item) => sum + item.failures, 0),
    byTool: [...byTool.values()],
  };
}

async function temporaryDirectory(): Promise<string> {
  const { mkdtemp, realpath } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "answer-record-boundary-"));
  const canonicalDirectory = await realpath(directory);
  roots.push(canonicalDirectory);
  return canonicalDirectory;
}

async function writeRecord(path: string, record: unknown): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

function decodeChild(
  child: RunRecord,
  options: ReturnType<typeof scriptedEditorialProtocol>["decodeOptions"],
): RunRecord {
  try {
    return decodeSuccessfulPublicationRunRecord(child, options);
  } catch (error) {
    const causes: unknown[] = [];
    let cause: unknown = error;
    while (cause && typeof cause === "object" && causes.length < 4) {
      const item = cause as {
        name?: unknown;
        code?: unknown;
        reason?: unknown;
        message?: unknown;
        cause?: unknown;
      };
      causes.push({ name: item.name, code: item.code, reason: item.reason, message: item.message });
      cause = item.cause;
    }
    const detail = causes.length > 0 ? causes : String(error);
    throw new Error(`Continuation child strict decode failed: ${JSON.stringify(detail)}`, {
      cause: error,
    });
  }
}
