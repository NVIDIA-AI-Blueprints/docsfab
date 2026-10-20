// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DurableArtifactStore } from "../src/artifacts/store.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import { OUTPUT_RECORD_CONTRACTS } from "../src/contracts/model-output.js";
import type { AgentHarness, HarnessStepInput, RunRequest } from "../src/execution/contracts.js";
import { InferenceStepError } from "../src/execution/contracts.js";
import { createQualityAnswerRecordAdmission } from "../src/harness/quality-answer-record-admission.js";
import { planDocumentationQualityAnswerRecords } from "../src/harness/answer-record-plan.js";
import type { HostMintedValues } from "../src/harness/answer-record-fill.js";
import type { QualityValidatorHost } from "../src/evaluation-report/quality-validator-host.js";
import type { RunRecord, RunStore, StepRunRecord } from "../src/records/contracts.js";
import { FileRunStore } from "../src/records/file-store.js";
import { loadAnswerRecordContinuation } from "../src/cli/run/answer-record-continuation.js";
import type { RunRequestWithPublishProjection } from "../src/cli/run/request.js";
import { answerRecordContinuationPrefixSha256 } from "../src/records/composition-execution.js";
import { sourceObligationObserverFixture, verificationFixture } from "./helpers/verification.js";
import { readyContextPreflight } from "./helpers.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import { internalOnly } from "./helpers/internal-path.js";

type CanonicalRow = {
  readonly fixture: string;
  readonly group: number;
  readonly type: string;
  readonly key?: string;
  readonly record: unknown;
};

const roots: string[] = [];
const restoreCallbacks: Array<() => void> = [];
const runnerCorpusAssets = internalOnly(
  [
    "packages/runtime/docs/internal/evidence/answer-record-corpus-2026-10/corpus.json",
    "packages/quality/profiles/docsfab-documentation-quality/profile.json",
  ],
  "the runner continuation cases use the internal canonical answer-record corpus and quality profile omitted from public export",
);
const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const declaration = OUTPUT_RECORD_CONTRACTS["quality-evaluation"];

afterEach(async () => {
  for (const restore of restoreCallbacks.splice(0)) restore();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class MemoryRunStore implements RunStore {
  readonly records: RunRecord[] = [];
  readonly events: string[] = [];

  constructor(
    private readonly failChildPointerSaveAt?: number,
    private readonly backingStore?: RunStore,
    private readonly childRunId = "child-run",
  ) {}

  async save(record: RunRecord): Promise<void> {
    const pointer = record.steps.find(
      (step) => step.id === "evaluate-document-quality",
    )?.answerRecordCheckpoint;
    if (
      this.failChildPointerSaveAt !== undefined &&
      record.id === this.childRunId &&
      pointer?.sequence === this.failChildPointerSaveAt
    ) {
      this.events.push("child-pointer-save-failed");
      throw new Error("injected child checkpoint pointer save failure");
    }
    await this.backingStore?.save(record);
    this.records.push(structuredClone(record));
    if (record.id === this.childRunId && pointer) {
      this.events.push("child-pointer-saved");
    }
  }

  latest(id: string): RunRecord | undefined {
    return this.records.filter((record) => record.id === id).at(-1);
  }
}

function makeSelection(profile: Record<string, unknown>, revision: string) {
  return {
    profile,
    receipt: {
      selectionSha256: digestA,
      profileId: "docsfab-documentation-quality",
      profileVersion: "1",
      profileModel: "fixture-profile",
      repositoryRevision: revision,
      targetScope: "individual-page",
    },
    evaluationTarget: [{ path: "docs/quickstart.md" }],
    discoveryLimitations: [],
  };
}

async function loadCanonicalFixture() {
  const corpus = JSON.parse(
    await readFile(
      new URL(
        "../docs/internal/evidence/answer-record-corpus-2026-10/corpus.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { records: CanonicalRow[] };
  const rows = corpus.records.filter((row) => row.fixture === "a");
  expect(rows).toHaveLength(43);
  expect(
    Object.fromEntries(
      [...new Set(rows.map((row) => row.type))].map((type) => [
        type,
        rows.filter((row) => row.type === type).length,
      ]),
    ),
  ).toEqual({
    "target-judgment": 1,
    dimension: 33,
    finding: 4,
    "layer-note": 3,
    "evaluation-note": 1,
    "quality-score": 1,
  });
  return rows;
}

function checkpointRows(rows: readonly CanonicalRow[]) {
  return rows
    .filter((row) => !(row.type === "dimension" && row.key === "visual-explanation"))
    .slice(0, 20);
}

function admissionPlan(profile: Record<string, unknown>) {
  const applicability = profile.applicability as Record<string, unknown>;
  const docSet = applicability.documentation_set as Record<string, unknown>;
  const requiredDimensionsByLayer = docSet.required_dimensions_by_layer as Record<string, string[]>;
  const constraints = profile.constraints as { required: string[]; conditional: string[] };
  return planDocumentationQualityAnswerRecords({
    requiredDimensionsByLayer,
    requiredConstraints: constraints.required,
    conditionalConstraints: constraints.conditional,
  });
}

function fakeHost(input: {
  store: DurableArtifactStore;
  profile: Record<string, unknown>;
  revision: string;
}) {
  const plan = admissionPlan(input.profile);
  const dimensionsByLayer = (input.profile.applicability as Record<string, unknown>)
    .documentation_set as Record<string, unknown>;
  const requiredDimensionIds = Object.values(
    dimensionsByLayer.required_dimensions_by_layer as Record<string, string[]>,
  ).flat();
  const constraints = input.profile.constraints as { required: string[]; conditional: string[] };
  const host = {
    answerRecordsTestInjectionEnabled: true,
    async createAnswerRecordSession(
      sessionInput: Parameters<QualityValidatorHost["createAnswerRecordSession"]>[0],
    ) {
      const logicalRunId = sessionInput.logicalRunId ?? sessionInput.runId;
      const session = createQualityAnswerRecordAdmission({
        store: input.store,
        declaration,
        plan,
        bindings: {
          runId: logicalRunId,
          stepId: sessionInput.stepId,
          attempt: sessionInput.attempt,
          declarationSha256: canonicalDigest(declaration),
          schemaSha256s: {
            ...Object.fromEntries(
              Object.keys(declaration.canonical.members).map((name) => [name, digestA]),
            ),
            qualityPolicy: digestB,
          },
          profilePayloadSha256: digestA,
          selectionSha256: digestA,
          referenceSourceSha256s: sessionInput.referenceSourceSha256s,
          evaluatorIdentitySha256: sessionInput.evaluatorIdentitySha256,
          compositionSha256: sessionInput.compositionSha256,
          answerPathCapabilitySha256: sessionInput.answerPathCapabilitySha256,
        },
        ...(sessionInput.sourceRunId ? { sourceRunId: sessionInput.sourceRunId } : {}),
        ...(sessionInput.restoreSourceRunId
          ? { restoreSourceRunId: sessionInput.restoreSourceRunId }
          : {}),
        hostMinted: {
          "run.step-attempt-id": `${logicalRunId}:${sessionInput.stepId}:${sessionInput.attempt}`,
          "contract.evaluation-version": "1.0",
          "host.clock-at-assembly": () => "2026-10-09T12:00:00.000Z",
          "selection-receipt.profileModel": "fixture-profile",
          "selection-receipt.profile": { id: "docsfab-documentation-quality", version: "1" },
          "evaluate-step-evidence": () => ({
            provider_id: sessionInput.evaluatorProviderId(),
            provider_type: "agent",
            independent_of_authors: false,
            independence_evidence: "Fixture host binding.",
          }),
          "selection-receipt.scopeType": "individual-page",
          "quality-evaluation-target": () => ["docs/quickstart.md"],
          "selection-receipt.repositoryRevision": input.revision,
          "workflow.finding-owner": "documentation-owner",
          "workflow.finding-status": "open",
        } as HostMintedValues,
        references: sessionInput.references,
        referenceIds: sessionInput.referenceIds,
        renderReference: sessionInput.renderReference,
        derive: async () => ({ status: "open", open: ["fixture remains incomplete"] }),
        recordNarrowing: {
          profilePayloadSha256: digestA,
          selectionSha256: digestA,
          qualityPolicySha256: digestB,
          requiredDimensionIds: [...requiredDimensionIds, ...constraints.required],
          hardGateIds: input.profile.hard_gates as string[],
          confidenceAnchors: [0.25, 0.5, 0.75],
          d3ResidualDecisions: ["no-shortfall"],
          qualityEvaluationTargetPaths: ["docs/quickstart.md"],
        },
        validateRecords: async (candidates) =>
          candidates.map(({ toolCallId }) => ({
            toolCallId,
            status: "valid" as const,
          })),
        validateCompletion: async () => ({ status: "valid" as const }),
        ...(sessionInput.onCheckpoint ? { onCheckpoint: sessionInput.onCheckpoint } : {}),
      });
      if (sessionInput.restoreCheckpoint) {
        try {
          await session.restoreCheckpoint(sessionInput.restoreCheckpoint);
        } catch (error) {
          const rejection =
            error && typeof error === "object" && "rejection" in error
              ? {
                  rejection: (error as { rejection: unknown }).rejection,
                  stack: error instanceof Error ? error.stack : undefined,
                }
              : error instanceof Error
                ? { name: error.name, message: error.message }
                : String(error);
          throw new Error(`Test restore seam rejected checkpoint: ${JSON.stringify(rejection)}`);
        }
      }
      return session;
    },
  };
  return host;
}

function makeHarness(input: {
  readonly evaluator: (
    stepInput: HarnessStepInput,
    attemptNumber: number,
  ) => ReturnType<AgentHarness["runStep"]>;
}) {
  const calls: HarnessStepInput[] = [];
  const harness: AgentHarness = {
    qualityAnswerRecordRouteBindingSha256: () => digestB,
    qualityAnswerRecordProviderId: () => "fixture-provider",
    async runStep(stepInput) {
      calls.push(stepInput);
      if (stepInput.step.id === "evaluate-document-quality") {
        const attemptNumber = stepInput.inferenceAttempt ?? 1;
        return input.evaluator(stepInput, attemptNumber);
      }
      return {
        summary:
          stepInput.step.skill === "review-documentation"
            ? JSON.stringify({ verdict: "pass", issues: [] })
            : `fixture completed ${stepInput.step.skill}`,
        ...(await verificationFixture(stepInput)),
        ...(stepInput.step.mode === "read-only" &&
        (stepInput.step.kind ?? "inference") === "evaluate"
          ? { editorialAssessmentProposal: { stepId: stepInput.step.id } }
          : {}),
        model: { provider: "hosted", model: "fixture-model" },
        skill: { id: stepInput.step.skill, contentSha256: digestA },
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, turns: 1 },
        tools: { totalCalls: 1, failedCalls: 0, byTool: [{ name: "read", calls: 1, failures: 0 }] },
      };
    },
  };
  return { harness, calls };
}

function timeoutForRetry(): InferenceStepError {
  return new InferenceStepError(
    "Fixture interrupted at the evaluator deadline.",
    "timeout",
    true,
    undefined,
    undefined,
    { condition: "attempt-deadline" },
  );
}

function prefixFor(record: RunRecord): readonly StepRunRecord[] {
  const index = record.steps.findIndex((step) => step.id === "evaluate-document-quality");
  if (index < 0) throw new Error("The source run has no quality evaluator step.");
  return record.steps.slice(0, index);
}

describe("answer-record continuation runner F5 checkpoint journey", () => {
  it("counts inherited and resumed tool totals once after evaluator completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "answer-record-continuation-tool-totals-"));
    roots.push(root);
    const workspacePath = join(root, "workspace");
    await mkdir(join(workspacePath, "docs"), { recursive: true });
    await writeFile(join(workspacePath, "README.md"), "# Fixture\n");
    await writeFile(join(workspacePath, "docs/guide.md"), "# Guide\n\nFixture documentation.\n");
    await writeFile(
      join(workspacePath, "docs/quickstart.md"),
      "# Quickstart\n\nFixture documentation.\n",
    );
    const tools = {
      totalCalls: 2,
      failedCalls: 1,
      byTool: [{ name: "read", calls: 2, failures: 1 }],
      failureCategories: [{ category: "expected-missing-probe" as const, count: 1 }],
    };
    const harness = makeHarness({
      evaluator: async () => ({
        summary: "Fixture evaluator completed.",
        model: { provider: "hosted", model: "fixture-model" },
        skill: { id: "evaluate-document-quality", contentSha256: digestA },
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, turns: 1 },
        tools,
      }),
    });
    const common = {
      hostOperations: {
        runStep: async (input: HarnessStepInput) => ({ summary: input.step.skill }),
      },
      repositoryScanner: {
        scan: async () => ({
          ruleSet: "test",
          status: "passed" as const,
          scannedFiles: 1,
          binaryFiles: 0,
          findings: [],
        }),
      },
      contextPreflight: readyContextPreflight,
      repositoryEvidence: { capture: async () => ({ files: [] }) },
      workflowSearch: new LocalWorkflowSearchCoordinator(),
      sourceObligationObserver: sourceObligationObserverFixture,
      retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableCategories: [] },
    };
    const request = {
      workflow: "review-documentation",
      instruction: "Review the fixture documentation.",
      workspacePath,
      repository: {
        sourcePath: workspacePath,
        requestedRevision: "HEAD",
        revision: "a".repeat(40),
      },
      allowWrite: false,
    } as RunRequest;
    const sourceStore = new MemoryRunStore();
    const sourceRecord = await new WorkflowRunner({
      ...common,
      harness: harness.harness,
      store: sourceStore,
      id: () => "continuation-source",
    }).run(request);
    expect(sourceRecord.steps.find((step) => step.id === "evaluate-document-quality")?.status).toBe(
      "succeeded",
    );
    const prefix = prefixFor(sourceRecord);
    const sourceStepsBefore = structuredClone(prefix);
    const resumeStepIndex = sourceRecord.steps.findIndex(
      (step) => step.id === "evaluate-document-quality",
    );
    const receipt = {
      schemaVersion: 1 as const,
      kind: "docsfab-answer-record-continuation-receipt" as const,
      sourceRunId: sourceRecord.id,
      sourceRunRecordSha256: digestA,
      checkpointSha256: digestB,
      checkpointSequence: 1,
      checkpointAttempt: 1,
      logicalRunId: sourceRecord.id,
      inheritedPrefixSha256: answerRecordContinuationPrefixSha256(prefix),
    };
    const childStore = new MemoryRunStore();
    const childRecord = await new WorkflowRunner({
      ...common,
      harness: harness.harness,
      store: childStore,
      id: () => "continuation-child",
      answerRecordContinuation: {
        logicalRunId: sourceRecord.id,
        sourceRunId: sourceRecord.id,
        checkpoint: { record: {} as never, sha256: digestB },
        resumeStepId: "evaluate-document-quality",
        completedPrefix: prefix,
      },
    }).run({
      ...request,
      runId: "continuation-child",
      answerRecordContinuationReceipt: receipt,
    });

    expect(childRecord.steps.find((step) => step.id === "evaluate-document-quality")?.status).toBe(
      "succeeded",
    );
    const readCallsInSteps = childRecord.steps.reduce(
      (total, step) =>
        total + (step.tools?.byTool.find((entry) => entry.name === "read")?.calls ?? 0),
      0,
    );
    const inheritedReadCalls = prefix.reduce(
      (total, step) =>
        total + (step.tools?.byTool.find((entry) => entry.name === "read")?.calls ?? 0),
      0,
    );
    const resumedReadCalls = tools.byTool[0]!.calls;
    expect(inheritedReadCalls).toBeGreaterThan(0);
    expect(readCallsInSteps).toBe(inheritedReadCalls + resumedReadCalls);
    expect(childRecord.tools.byTool).toContainEqual({
      name: "read",
      calls: inheritedReadCalls + resumedReadCalls,
      failures: 1,
    });
    expect(childRecord.tools.failureCategories).toEqual([
      { category: "expected-missing-probe", count: 1 },
    ]);
    expect(childRecord.tools.failedCalls).toBe(1);
    expect(childRecord.tools.totalCalls).toBe(readCallsInSteps);
    const childPrefix = childRecord.steps.slice(0, resumeStepIndex);
    expect(childPrefix.map(({ inheritedFrom: _source, ...step }) => step)).toEqual(
      sourceStepsBefore,
    );
    expect(childPrefix.map((step) => step.inheritedFrom)).toEqual(
      prefix.map((step) => ({
        sourceRunId: sourceRecord.id,
        sourceRunRecordSha256: digestA,
        sourceStepId: step.id,
      })),
    );
    expect(sourceRecord.steps.slice(0, resumeStepIndex)).toEqual(sourceStepsBefore);
    // Provider usage belongs to this child attempt; the inherited step usage is
    // preserved, but is not charged again to the continuation's run total.
    expect(childRecord.usage?.turns).toBe(1);
  });

  it.skipIf(runnerCorpusAssets.skip)(
    runnerCorpusAssets.title(
      "retries the interrupted evaluator with 20 exact committed rows and exposes the 23 remaining canonical submissions",
    ),
    async () => {
      const root = await mkdtemp(join(tmpdir(), "answer-record-runner-f5-"));
      roots.push(root);
      const workspacePath = join(root, "workspace");
      await mkdir(join(workspacePath, "docs"), { recursive: true });
      await writeFile(join(workspacePath, "README.md"), "# Fixture\n");
      await writeFile(join(workspacePath, "docs/guide.md"), "# Guide\n\nFixture documentation.\n");
      await writeFile(
        join(workspacePath, "docs/quickstart.md"),
        "# Quickstart\n\nFixture documentation.\n",
      );
      const profile = JSON.parse(
        await readFile(
          new URL(
            "../quality/profiles/docsfab-documentation-quality/profile.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ) as Record<string, unknown>;
      const rows = await loadCanonicalFixture();
      const artifactStore = new DurableArtifactStore(join(root, "artifacts"));
      await artifactStore.initialize();
      const host = fakeHost({ store: artifactStore, profile, revision: "a".repeat(40) });
      const sourceStore = new MemoryRunStore();
      const sourceEvaluatorInputs: HarnessStepInput[] = [];
      const source = makeHarness({
        evaluator: async (stepInput, attemptNumber) => {
          sourceEvaluatorInputs.push(stepInput);
          if (attemptNumber === 1) {
            const capability = stepInput.qualityAnswerRecords!;
            const visualRow = rows.find(
              ({ type, key }) => type === "dimension" && key === "visual-explanation",
            )!;
            expect((visualRow.record as { assessment: string }).assessment).toBe("not-applicable");
            const visualCall = {
              toolCallId: "source-visual-explanation-na",
              rawArguments: JSON.stringify({
                type: visualRow.type,
                key: visualRow.key,
                record: visualRow.record,
              }),
            };
            await capability.prepareBatch({
              batchId: "source-reject-required-na",
              toolCalls: [visualCall],
              authorizedToolCallIds: [visualCall.toolCallId],
            });
            expect(capability.receipt(visualCall.toolCallId)).toMatchObject({
              status: "refused",
              code: "answer-record-shape",
              type: "dimension",
              key: "visual-explanation",
            });
            await capability.settle({
              batchId: "source-reject-required-na",
              toolCallIds: [visualCall.toolCallId],
              authorizedToolCallIds: [visualCall.toolCallId],
              successfulToolCallIds: [],
            });
            const firstTwenty = checkpointRows(rows);
            const calls = firstTwenty.map((row, index) => ({
              toolCallId: `source-row-${index + 1}`,
              rawArguments: JSON.stringify({
                type: row.type,
                ...(row.key !== undefined ? { key: row.key } : {}),
                record: row.record,
              }),
            }));
            const authorizedToolCallIds = calls.map(({ toolCallId }) => toolCallId);
            await capability.prepareBatch({
              batchId: "source-prefix-20",
              toolCalls: calls,
              authorizedToolCallIds,
            });
            const receipts = calls.map(({ toolCallId }) => capability.receipt(toolCallId));
            const rejectedReceipts = receipts.filter(({ status }) => status !== "admitted");
            if (rejectedReceipts.length > 0) {
              throw new Error(
                `Canonical admission refusals: ${JSON.stringify(
                  rejectedReceipts.map(({ status, code, type, key, location }) => ({
                    status,
                    code,
                    type,
                    key,
                    location,
                  })),
                )}`,
              );
            }
            expect(
              receipts.map(({ status }) => status),
              JSON.stringify(
                receipts.map(({ status, code, type, key, location }) => ({
                  status,
                  code,
                  type,
                  key,
                  location,
                })),
              ),
            ).toEqual(Array.from({ length: 20 }, () => "admitted"));
            await capability.settle({
              batchId: "source-prefix-20",
              toolCallIds: authorizedToolCallIds,
              authorizedToolCallIds,
              successfulToolCallIds: authorizedToolCallIds,
            });
            const persisted = sourceStore
              .latest("source-run")
              ?.steps.find((step) => step.id === "evaluate-document-quality");
            if (
              persisted?.answerRecordCheckpoint?.sequence !== 2 ||
              persisted.answerRecordCheckpoint.attempt !== 1 ||
              persisted.answerRecordLedger?.rows.length !== 20
            ) {
              throw new Error(
                `Unexpected source checkpoint projection: ${JSON.stringify({
                  pointer: persisted?.answerRecordCheckpoint,
                  rowCount: persisted?.answerRecordLedger?.rows.length,
                })}`,
              );
            }
          } else {
            expect(stepInput.qualityAnswerRecordReplay).toHaveLength(20);
            expect(stepInput.qualityAnswerRecordReplay!.map((pair) => pair.sourceAttempt)).toEqual(
              Array.from({ length: 20 }, () => 1),
            );
            expect(
              stepInput.qualityAnswerRecordReplay!.map((pair) => [pair.type, pair.key]),
            ).toEqual(checkpointRows(rows).map((row) => [row.type, row.key ?? "singleton"]));
            expect(stepInput.qualityAnswerRecordReplay!.map((pair) => pair.record)).toEqual(
              checkpointRows(rows).map((row) => row.record),
            );
            expect(stepInput.qualityAnswerRecordRemainingKeys).toEqual(
              stepInput.qualityAnswerRecordProgress!().remainingKeys,
            );
            expect(stepInput.qualityAnswerRecordProgress!().completedKeys).toHaveLength(20);
            expect(rows.length - stepInput.qualityAnswerRecordReplay!.length).toBe(23);
            expect(
              stepInput.qualityAnswerRecordReplay!.map((pair) => pair.toolCallId),
            ).not.toContain("source-row-1");
            throw timeoutForRetry();
          }
          throw timeoutForRetry();
        },
      });
      const sourceRunner = new WorkflowRunner({
        harness: source.harness,
        hostOperations: { runStep: async (input) => ({ summary: `host ${input.step.skill}` }) },
        store: sourceStore,
        repositoryScanner: {
          scan: async () => ({
            ruleSet: "test",
            status: "passed",
            scannedFiles: 1,
            binaryFiles: 0,
            findings: [],
          }),
        },
        contextPreflight: readyContextPreflight,
        repositoryEvidence: { capture: async () => ({ files: [] }) },
        workflowSearch: new LocalWorkflowSearchCoordinator(),
        sourceObligationObserver: sourceObligationObserverFixture,
        retryPolicy: {
          maxRetries: 1,
          maxTimeoutRetries: 1,
          baseDelayMs: 0,
          maxDelayMs: 0,
          retryableCategories: ["timeout"],
        },
        retrySleep: async () => {},
        qualityValidation: {
          selection: makeSelection(profile, "a".repeat(40)) as never,
          host: host as never,
        },
        id: () => "source-run",
      });
      const sourceRecord = await sourceRunner.run({
        workflow: "review-documentation",
        workspacePath,
        repository: {
          sourcePath: "/tmp/f5-source",
          requestedRevision: "HEAD",
          revision: "a".repeat(40),
        },
        allowWrite: false,
      });

      expect(
        sourceEvaluatorInputs,
        JSON.stringify({
          status: sourceRecord.status,
          error: sourceRecord.error,
          steps: sourceRecord.steps.map((step) => ({
            id: step.id,
            status: step.status,
            error: step.error,
            failure: step.failure,
          })),
        }),
      ).toHaveLength(2);
      expect(sourceRecord.status).toBe("failed");
      expect(prefixFor(sourceRecord).every((step) => step.status === "succeeded")).toBe(true);
      const sourceEvaluator = sourceRecord.steps.find(
        (step) => step.id === "evaluate-document-quality",
      )!;
      expect(sourceEvaluator.answerRecordCheckpoint).toMatchObject({ sequence: 2, attempt: 2 });
      expect(sourceEvaluator.answerRecordLedger?.rows).toHaveLength(20);
      expect(sourceEvaluator.inference?.attempts).toHaveLength(2);
      expect(sourceEvaluator.inference?.attempts[1]).not.toHaveProperty("usage");
      expect(sourceEvaluator.inference?.attempts[1]).not.toHaveProperty("tools");
      expect(sourceEvaluator.inference?.attempts[1]).not.toHaveProperty("answerSubmission");
    },
    testTimeoutMs(30_000),
  );

  it.skipIf(runnerCorpusAssets.skip)(
    runnerCorpusAssets.title(
      "publishes the child checkpoint before retry and stops before provider work when publication fails",
    ),
    async () => {
      // The first case above exercises both the initial evaluator deadline and
      // the runner's real in-process retry. This case focuses on the child
      // process boundary and the durability ordering before its first provider call.
      const root = await mkdtemp(join(tmpdir(), "answer-record-runner-child-"));
      roots.push(root);
      const workspacePath = join(root, "workspace");
      await mkdir(join(workspacePath, "docs"), { recursive: true });
      await writeFile(join(workspacePath, "README.md"), "# Fixture\n");
      await writeFile(join(workspacePath, "docs/guide.md"), "# Guide\n\nFixture documentation.\n");
      await writeFile(
        join(workspacePath, "docs/quickstart.md"),
        "# Quickstart\n\nFixture documentation.\n",
      );
      const profile = JSON.parse(
        await readFile(
          new URL(
            "../quality/profiles/docsfab-documentation-quality/profile.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ) as Record<string, unknown>;
      const rows = await loadCanonicalFixture();
      const artifactStore = new DurableArtifactStore(join(root, "artifacts"));
      await artifactStore.initialize();
      const host = fakeHost({ store: artifactStore, profile, revision: "a".repeat(40) });
      const stateDirectory = join(root, "state");
      const sourceStore = new FileRunStore(stateDirectory);
      const source = makeHarness({
        evaluator: async (stepInput) => {
          const visualRow = rows.find(
            ({ type, key }) => type === "dimension" && key === "visual-explanation",
          )!;
          expect((visualRow.record as { assessment: string }).assessment).toBe("not-applicable");
          const visualCall = {
            toolCallId: "source-visual-explanation-na",
            rawArguments: JSON.stringify({
              type: visualRow.type,
              key: visualRow.key,
              record: visualRow.record,
            }),
          };
          await stepInput.qualityAnswerRecords!.prepareBatch({
            batchId: "source-reject-required-na",
            toolCalls: [visualCall],
            authorizedToolCallIds: [visualCall.toolCallId],
          });
          expect(stepInput.qualityAnswerRecords!.receipt(visualCall.toolCallId)).toMatchObject({
            status: "refused",
            code: "answer-record-shape",
            type: "dimension",
            key: "visual-explanation",
          });
          await stepInput.qualityAnswerRecords!.settle({
            batchId: "source-reject-required-na",
            toolCallIds: [visualCall.toolCallId],
            authorizedToolCallIds: [visualCall.toolCallId],
            successfulToolCallIds: [],
          });
          const calls = checkpointRows(rows).map((row, index) => ({
            toolCallId: `source-row-${index + 1}`,
            rawArguments: JSON.stringify({
              type: row.type,
              ...(row.key ? { key: row.key } : {}),
              record: row.record,
            }),
          }));
          const ids = calls.map(({ toolCallId }) => toolCallId);
          await stepInput.qualityAnswerRecords!.prepareBatch({
            batchId: "source-prefix-20",
            toolCalls: calls,
            authorizedToolCallIds: ids,
          });
          const receipts = ids.map((toolCallId) =>
            stepInput.qualityAnswerRecords!.receipt(toolCallId),
          );
          const rejectedReceipts = receipts.filter(({ status }) => status !== "admitted");
          if (rejectedReceipts.length > 0) {
            throw new Error(
              `Canonical admission refusals: ${JSON.stringify(
                rejectedReceipts.map(({ status, code, type, key, location }) => ({
                  status,
                  code,
                  type,
                  key,
                  location,
                })),
              )}`,
            );
          }
          expect(
            receipts.map(({ status }) => status),
            JSON.stringify(
              receipts.map(({ status, code, type, key, location }) => ({
                status,
                code,
                type,
                key,
                location,
              })),
            ),
          ).toEqual(Array.from({ length: 20 }, () => "admitted"));
          await stepInput.qualityAnswerRecords!.settle({
            batchId: "source-prefix-20",
            toolCallIds: ids,
            authorizedToolCallIds: ids,
            successfulToolCallIds: ids,
          });
          throw timeoutForRetry();
        },
      });
      const sharedRunnerOptions = {
        hostOperations: {
          runStep: async (input: HarnessStepInput) => ({ summary: `host ${input.step.skill}` }),
        },
        repositoryScanner: {
          scan: async () => ({
            ruleSet: "test",
            status: "passed" as const,
            scannedFiles: 1,
            binaryFiles: 0,
            findings: [],
          }),
        },
        contextPreflight: readyContextPreflight,
        repositoryEvidence: { capture: async () => ({ files: [] }) },
        workflowSearch: new LocalWorkflowSearchCoordinator(),
        sourceObligationObserver: sourceObligationObserverFixture,
        retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableCategories: [] },
        qualityValidation: {
          selection: makeSelection(profile, "a".repeat(40)) as never,
          host: host as never,
        },
      };
      const sourceRecord = await new WorkflowRunner({
        ...sharedRunnerOptions,
        harness: source.harness,
        store: sourceStore,
        id: () => "source-run",
      }).run({
        workflow: "review-documentation",
        instruction: "Review the fixture documentation.",
        requestIntent: {
          schemaVersion: 1,
          admission: {
            outcome: "offline",
            code: null,
            location: null,
            reason: "pi-offline",
            boundary: null,
            calls: [],
            clippedTitles: 0,
          },
          intent: null,
        },
        workspacePath,
        repository: {
          sourcePath: workspacePath,
          requestedRevision: "HEAD",
          revision: "a".repeat(40),
        },
        allowWrite: false,
      });
      const sourceStep = sourceRecord.steps.find(
        (step) => step.id === "evaluate-document-quality",
      )!;
      expect(sourceStep.answerRecordLedger?.rows).toHaveLength(20);
      const continuationRequest = {
        workflow: "review-documentation",
        repositoryPath: workspacePath,
        resumeFrom: sourceRecord.id,
        allowWrite: false,
      } as RunRequestWithPublishProjection;
      const loadedContinuation = await loadAnswerRecordContinuation(continuationRequest, {
        stateDirectory,
      } as import("../src/config/runtime-loader.js").DocsFabConfig);
      if (!loadedContinuation) throw new Error("Expected the source checkpoint to load.");
      const receipt = loadedContinuation.request.answerRecordContinuationReceipt!;
      const continuation = loadedContinuation.answerRecordContinuation;
      const childRunId = loadedContinuation.request.runId!;

      const inheritedObserverIndex = continuation.completedPrefix.findIndex(
        (step) =>
          step.searchParticipation?.planId === "documentation-audit-discovery" &&
          step.searchParticipation.searchMode === "observe",
      );
      expect(inheritedObserverIndex).toBeGreaterThanOrEqual(0);
      const inheritedObserver = continuation.completedPrefix[inheritedObserverIndex]!;
      expect(inheritedObserver.searchEvidence).toBeDefined();
      expect(inheritedObserver.searchParticipation).toMatchObject({
        planId: "documentation-audit-discovery",
        searchMode: "observe",
        observedByStepId: inheritedObserver.id,
      });

      const corruptInheritedEvidence = (
        kind: "missing" | "malformed" | "substituted",
      ): { continuation: typeof continuation; receipt: typeof receipt } => {
        const completedPrefix = structuredClone(continuation.completedPrefix);
        const observer = completedPrefix[inheritedObserverIndex]!;
        if (kind === "missing") {
          delete observer.searchEvidence;
        } else if (kind === "malformed") {
          observer.searchEvidence = {
            ...observer.searchEvidence!,
            evidenceSha256: digestB,
          };
        } else {
          const { evidenceSha256: _priorDigest, ...body } = observer.searchEvidence!;
          const substitutedBody = { ...body, planId: "substituted-search-plan" };
          const substitutedEvidence = {
            ...substitutedBody,
            evidenceSha256: canonicalDigest(substitutedBody),
          };
          observer.searchEvidence = substitutedEvidence;
          observer.searchParticipation = {
            ...observer.searchParticipation!,
            searchEvidenceSha256: substitutedEvidence.evidenceSha256,
          };
        }
        return {
          continuation: { ...continuation, completedPrefix },
          receipt: {
            ...receipt,
            inheritedPrefixSha256: answerRecordContinuationPrefixSha256(completedPrefix),
          },
        };
      };

      for (const invalidKind of ["missing", "malformed", "substituted"] as const) {
        const invalid = corruptInheritedEvidence(invalidKind);
        const childStore = new MemoryRunStore();
        let claimCalls = 0;
        let providerCalls = 0;
        const childCheckpointPublications: number[] = [];
        const child = makeHarness({
          evaluator: async () => {
            providerCalls += 1;
            throw timeoutForRetry();
          },
        });
        const invalidRunner = new WorkflowRunner({
          ...sharedRunnerOptions,
          harness: child.harness,
          store: childStore,
          answerRecordContinuation: invalid.continuation,
          claimAnswerRecordContinuation: async () => {
            claimCalls += 1;
          },
          publishAnswerRecordProgress: async (record) => {
            const pointer = record.steps.find(
              (step) => step.id === "evaluate-document-quality",
            )?.answerRecordCheckpoint;
            if (pointer) childCheckpointPublications.push(pointer.sequence);
          },
          id: () => `invalid-${invalidKind}-child`,
        });
        let invalidResult: RunRecord | undefined;
        let refusal: unknown;
        try {
          invalidResult = await invalidRunner.run({
            workflow: "review-documentation",
            workspacePath,
            repository: {
              sourcePath: "/tmp/f5-source",
              requestedRevision: "HEAD",
              revision: "a".repeat(40),
            },
            allowWrite: false,
            answerRecordContinuationReceipt: invalid.receipt,
          });
        } catch (error) {
          refusal = error;
        }
        expect(
          refusal !== undefined || invalidResult?.status === "failed",
          `${invalidKind} inherited search evidence must refuse continuation`,
        ).toBe(true);
        expect(claimCalls, `${invalidKind} evidence must refuse before claim`).toBe(0);
        expect(providerCalls, `${invalidKind} evidence must refuse before provider`).toBe(0);
        expect(
          childCheckpointPublications,
          `${invalidKind} evidence must refuse before child checkpoint publication`,
        ).toEqual([]);
        const diagnosticRecord = childStore.latest(`invalid-${invalidKind}-child`);
        const diagnosticStep = diagnosticRecord?.steps.find(
          (step) => step.id === "evaluate-document-quality",
        );
        expect(diagnosticStep?.answerRecordCheckpoint).toBeUndefined();
        expect(diagnosticStep?.answerRecordLedger).toBeUndefined();
      }

      const childCheckpointSequence = sourceStep.answerRecordCheckpoint!.sequence + 1;
      let orphanedChildRecord: RunRecord | undefined;
      for (const failPublication of [false, true]) {
        const childFileStore = new FileRunStore(stateDirectory);
        const childStore = new MemoryRunStore(
          failPublication ? childCheckpointSequence : undefined,
          failPublication ? undefined : childFileStore,
          childRunId,
        );
        const events = childStore.events;
        let providerCalls = 0;
        const child = makeHarness({
          evaluator: async (stepInput) => {
            providerCalls += 1;
            expect(stepInput.qualityAnswerRecordReplay).toHaveLength(20);
            expect(stepInput.qualityAnswerRecordReplay!.map((pair) => pair.sourceAttempt)).toEqual(
              Array.from({ length: 20 }, () => 1),
            );
            expect(rows.length - stepInput.qualityAnswerRecordReplay!.length).toBe(23);
            throw timeoutForRetry();
          },
        });
        const publishEvents: string[] = [];
        const runner = new WorkflowRunner({
          ...sharedRunnerOptions,
          harness: child.harness,
          store: childStore,
          answerRecordContinuation: continuation,
          claimAnswerRecordContinuation: async (record) => {
            publishEvents.push("claim");
            if (!failPublication) {
              await loadedContinuation.claimAnswerRecordContinuation(record);
            }
          },
          publishAnswerRecordProgress: async (record) => {
            const pointer = record.steps.find(
              (step) => step.id === "evaluate-document-quality",
            )?.answerRecordCheckpoint;
            publishEvents.push(`published-${pointer?.sequence ?? "none"}`);
            childStore.events.push(`published-${pointer?.sequence ?? "none"}`);
          },
          id: () => childRunId,
        });
        const childRecord = await runner.run({
          workflow: "review-documentation",
          instruction: loadedContinuation.request.instruction,
          requestIntent: loadedContinuation.requestIntent,
          workspacePath,
          repository: {
            sourcePath: workspacePath,
            requestedRevision: "HEAD",
            revision: "a".repeat(40),
          },
          allowWrite: false,
          answerRecordContinuationReceipt: receipt,
        });
        const childStep = childRecord.steps.find(
          (step) => step.id === "evaluate-document-quality",
        )!;
        if (failPublication) {
          expect(providerCalls).toBe(0);
          expect(events).toContain("child-pointer-save-failed");
          expect(
            childStore
              .latest(childRunId)
              ?.steps.find((step) => step.id === "evaluate-document-quality"),
          ).not.toHaveProperty("answerRecordCheckpoint");
        } else {
          expect(
            providerCalls,
            JSON.stringify({
              childStatus: childRecord.status,
              childError: childRecord.error,
              childSteps: childRecord.steps.map((step) => ({
                id: step.id,
                status: step.status,
                error: step.error,
                failure: step.failure,
              })),
              events,
              publishEvents,
            }),
          ).toBe(1);
          expect(childRecord.id).toBe(childRunId);
          expect(childRecord.answerRecordContinuation?.logicalRunId).toBe("source-run");
          expect(childStep.answerRecordCheckpoint).toMatchObject({
            sequence: childCheckpointSequence,
            attempt: 1,
          });
          expect(childStep.answerRecordLedger?.rows).toHaveLength(20);
          const publishedChildPointer = `published-${childCheckpointSequence}`;
          expect(publishEvents).toContain(publishedChildPointer);
          expect(events.indexOf("child-pointer-saved")).toBeLessThan(
            events.indexOf(publishedChildPointer),
          );
          orphanedChildRecord = childRecord;
        }
      }
      await expect(
        loadAnswerRecordContinuation(continuationRequest, { stateDirectory } as never),
      ).rejects.toThrow(childRunId);

      if (!orphanedChildRecord) throw new Error("Expected the runner child fixture to persist.");
      const orphanedSource = structuredClone(orphanedChildRecord);
      orphanedSource.status = "running";
      delete orphanedSource.completedAt;
      delete orphanedSource.durationMs;
      delete orphanedSource.error;
      delete orphanedSource.failure;
      const orphanedTarget = orphanedSource.steps.find(
        (step) => step.id === "evaluate-document-quality",
      )!;
      orphanedTarget.status = "running";
      delete orphanedTarget.error;
      delete orphanedTarget.failure;
      delete orphanedTarget.durationMs;
      await rm(join(stateDirectory, `${orphanedSource.id}.json`));
      await new FileRunStore(stateDirectory).save(orphanedSource);
      const orphanSourceBefore = await new FileRunStore(stateDirectory).getWithDigest(
        orphanedSource.id,
      );
      const orphanRequest = {
        workflow: "review-documentation",
        repositoryPath: workspacePath,
        resumeFrom: orphanedSource.id,
        allowWrite: false,
      } as RunRequestWithPublishProjection;
      const originalKill = process.kill;
      const killSpy = vi.spyOn(process, "kill").mockImplementation(((
        pid: number,
        signal?: number | NodeJS.Signals,
      ) => {
        if (pid === process.pid && signal === 0) {
          throw Object.assign(new Error("simulated exited owner"), { code: "ESRCH" });
        }
        return originalKill(pid, signal);
      }) as typeof process.kill);
      restoreCallbacks.push(() => killSpy.mockRestore());
      const orphanContinuation = await loadAnswerRecordContinuation(orphanRequest, {
        stateDirectory,
      } as import("../src/config/runtime-loader.js").DocsFabConfig);
      if (!orphanContinuation) throw new Error("Expected the same-host orphan to load.");
      expect(orphanContinuation.request.answerRecordContinuationReceipt?.recoveryBasis).toBe(
        "same-host-owner-process-exited",
      );
      expect(orphanContinuation.answerRecordContinuation.completedPrefix).toEqual(
        orphanedSource.steps.slice(
          0,
          orphanedSource.steps.findIndex((step) => step.id === "evaluate-document-quality"),
        ),
      );

      const recovery = makeHarness({
        evaluator: async (stepInput, attemptNumber) => {
          expect(stepInput.qualityAnswerRecordReplay).toHaveLength(attemptNumber === 1 ? 20 : 21);
          if (attemptNumber === 1) {
            const next = rows.filter(
              (row) => !(row.type === "dimension" && row.key === "visual-explanation"),
            )[20]!;
            const call = {
              toolCallId: "orphan-recovery-row-21",
              rawArguments: JSON.stringify({
                type: next.type,
                ...(next.key !== undefined ? { key: next.key } : {}),
                record: next.record,
              }),
            };
            const capability = stepInput.qualityAnswerRecords!;
            await capability.prepareBatch({
              batchId: "orphan-recovery-child-row",
              toolCalls: [call],
              authorizedToolCallIds: [call.toolCallId],
            });
            expect(capability.receipt(call.toolCallId).status).toBe("admitted");
            await capability.settle({
              batchId: "orphan-recovery-child-row",
              toolCallIds: [call.toolCallId],
              authorizedToolCallIds: [call.toolCallId],
              successfulToolCallIds: [call.toolCallId],
            });
          } else {
            expect(stepInput.qualityAnswerRecordReplay!.map((pair) => pair.sourceAttempt)).toEqual([
              ...Array.from({ length: 20 }, () => 1),
              1,
            ]);
          }
          throw timeoutForRetry();
        },
      });
      const recoveredChildStore = new MemoryRunStore(
        undefined,
        new FileRunStore(stateDirectory),
        orphanContinuation.request.runId!,
      );
      const recoveredChild = await new WorkflowRunner({
        ...sharedRunnerOptions,
        retryPolicy: {
          maxRetries: 1,
          maxTimeoutRetries: 1,
          baseDelayMs: 0,
          maxDelayMs: 0,
          retryableCategories: ["timeout"],
        },
        harness: recovery.harness,
        store: recoveredChildStore,
        answerRecordContinuation: orphanContinuation.answerRecordContinuation,
        claimAnswerRecordContinuation: orphanContinuation.claimAnswerRecordContinuation,
        id: () => orphanContinuation.request.runId!,
      }).run({
        workflow: "review-documentation",
        instruction: orphanContinuation.request.instruction,
        requestIntent: orphanContinuation.requestIntent,
        workspacePath,
        repository: {
          sourcePath: workspacePath,
          requestedRevision: "HEAD",
          revision: "a".repeat(40),
        },
        allowWrite: false,
        answerRecordContinuationReceipt: orphanContinuation.request.answerRecordContinuationReceipt,
      });
      expect(recoveredChild.id).not.toBe(orphanedSource.id);
      expect(recoveredChild.answerRecordContinuation?.recoveryBasis).toBe(
        "same-host-owner-process-exited",
      );
      expect(
        recovery.calls.map((input) => input.step.id),
        JSON.stringify({
          status: recoveredChild.status,
          error: recoveredChild.error,
          steps: recoveredChild.steps.map((step) => ({
            id: step.id,
            status: step.status,
            error: step.error,
            failure: step.failure,
          })),
        }),
      ).toEqual(["evaluate-document-quality", "evaluate-document-quality"]);
      expect(
        recovery.calls,
        JSON.stringify({
          status: recoveredChild.status,
          error: recoveredChild.error,
          steps: recoveredChild.steps.map((step) => ({
            id: step.id,
            status: step.status,
            error: step.error,
            failure: step.failure,
          })),
        }),
      ).toHaveLength(2);
      const retriedPointer = recoveredChildStore
        .latest(recoveredChild.id)
        ?.steps.find((step) => step.id === "evaluate-document-quality")?.answerRecordCheckpoint;
      expect(
        retriedPointer,
        JSON.stringify({
          retriedPointer,
          status: recoveredChild.status,
          error: recoveredChild.error,
        }),
      ).toMatchObject({ attempt: 2 });
      expect(retriedPointer!.sequence).toBeGreaterThan(sourceStep.answerRecordCheckpoint!.sequence);
      expect(recoveredChildStore.latest(recoveredChild.id)?.status).toBe("failed");
      const orphanSourceAfter = await new FileRunStore(stateDirectory).getWithDigest(
        orphanedSource.id,
      );
      const orphanSourceRecord = orphanSourceAfter.record as RunRecord;
      expect(orphanSourceAfter.sha256).toBe(orphanSourceBefore.sha256);
      expect(orphanSourceAfter.record).toEqual(orphanSourceBefore.record);
      expect(orphanSourceRecord.status).toBe("running");
      expect(orphanSourceRecord.usage).toEqual(orphanedSource.usage);
    },
    testTimeoutMs(30_000),
  );
});
