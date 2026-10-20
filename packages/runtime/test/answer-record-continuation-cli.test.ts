// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DurableArtifactStore, opaqueRecordDigest } from "../src/artifacts/store.js";
import { canonicalDigest, createContractKit } from "../src/contract-kit/index.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import type { RunRequestWithPublishProjection } from "../src/cli/run/request.js";
import type { EditorialDecisionArtifactReferenceV3 } from "../src/artifacts/contracts.js";
import { loadAnswerRecordContinuation } from "../src/cli/run/answer-record-continuation.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import type {
  AnswerRecordContinuationCheckpointV1,
  AnswerRecordContinuationReceiptV1,
  RunRecord,
  StepRunRecord,
} from "../src/records/contracts.js";
import { FileRunStore } from "../src/records/file-store.js";
import { AnswerRecordContinuationClaimStore } from "../src/records/answer-record-continuation-store.js";
import { OUTPUT_RECORD_CONTRACTS } from "../src/contracts/model-output.generated.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { isWorkflowManifestV2, workflowSelectedPath } from "../src/workflow-contracts/contracts.js";
import {
  answerRecordContinuationPrefixSha256,
  createWorkflowBranchCoverageV1,
} from "../src/records/composition-execution.js";
import { recordedIntent } from "./helpers/first-pass-intent.js";

const sha = (letter: string): string => letter.repeat(64);

describe("answer-record continuation CLI admission", () => {
  let root: string;
  let repositoryPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "docsfab-answer-resume-"));
    repositoryPath = join(root, "repository");
    await mkdir(repositoryPath);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("continues a succeeded evaluator only for a model-correctable refusal after outcome mismatch", async () => {
    for (const rejection of [
      {
        validator: "technical-trace",
        code: "technical-trace-missing-fact-id",
        location: "$.findings",
        issueCount: 4,
      },
      {
        validator: "evaluation",
        code: "evaluation-schema-required",
        location: "$.evaluation",
        issueCount: 1,
      },
    ] as const) {
      const stateDirectory = join(root, "state", rejection.validator);
      const source = await createStoppedSource({
        stateDirectory,
        repositoryPath,
        artifacts: new DurableArtifactStore(join(root, "state", "artifacts")),
        evaluatorStatus: "succeeded",
        qualityValidationRejection: rejection,
        completedOutcomeRefusal: true,
      });
      const request = parseRunArguments([
        "update-documentation",
        "--repo",
        repositoryPath,
        "--resume-from",
        source.id,
        "--allow-write",
      ]) as RunRequestWithPublishProjection;

      await expect(
        loadAnswerRecordContinuation(request, { stateDirectory } as DocsFabConfig),
      ).resolves.toMatchObject({
        source: { id: source.id, status: "failed" },
        answerRecordContinuation: { resumeStepId: "evaluate-document-quality" },
      });
    }
  });

  it("recovers an authenticated legacy index after an evidenced copied checkpoint pointer", async () => {
    const stateDirectory = join(root, "state");
    const source = await createStoppedSource({
      stateDirectory,
      repositoryPath,
      artifacts: new DurableArtifactStore(join(root, "artifacts")),
      evaluatorStatus: "succeeded",
      qualityValidationRejection: {
        validator: "technical-trace",
        code: "technical-trace-missing-fact-id",
        location: "$.findings",
        issueCount: 4,
      },
      completedOutcomeRefusal: true,
      legacyLedgerIndex: true,
      checkpointAttempt: 2,
      checkpointSourceAttemptHighWater: 1,
      legacyAnswerRows: [
        { key: "singleton", state: "admitted", attempt: 1 },
        { key: "released-earlier", state: "released", attempt: 1 },
      ],
      legacyHistoricalReAdmitTombstone: true,
      evaluatorAttempts: [
        { attempt: 1, outcome: "malformed-response" },
        { attempt: 2, outcome: "succeeded" },
      ],
    });
    const sourceDigest = (await new FileRunStore(stateDirectory).getWithDigest(source.id)).sha256;
    const request = parseRunArguments([
      "update-documentation",
      "--repo",
      repositoryPath,
      "--resume-from",
      source.id,
      "--allow-write",
    ]) as RunRequestWithPublishProjection;

    const loaded = await loadAnswerRecordContinuation(request, { stateDirectory } as DocsFabConfig);

    expect(loaded?.answerRecordContinuation.checkpoint.record.sourceAttemptHighWater).toBe(1);
    expect(loaded?.request.answerRecordContinuationReceipt?.checkpointAttempt).toBe(2);
    expect((await new FileRunStore(stateDirectory).getWithDigest(source.id)).sha256).toBe(
      sourceDigest,
    );
    await expect(
      new AnswerRecordContinuationClaimStore(join(root, "answer-record-continuations")).inspect({
        sourceRunId: source.id,
        sourceRunRecordSha256: sourceDigest,
        checkpointSha256: loaded!.answerRecordContinuation.checkpoint.sha256,
        checkpointSequence: 1,
        checkpointAttempt: 2,
        logicalRunId: source.id,
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    "admitted-digest",
    "admitted-attempt",
    "missing-row",
    "extra-row",
    "bad-release-seal",
    "bad-release-bindings",
    "missing-release-tombstone",
    "present-pointer-mismatch",
  ] as const)("refuses legacy ledger projection with %s", async (legacyMutation) => {
    const stateDirectory = join(root, "state");
    const source = await createStoppedSource({
      stateDirectory,
      repositoryPath,
      artifacts: new DurableArtifactStore(join(root, "artifacts")),
      evaluatorStatus: "succeeded",
      qualityValidationRejection: {
        validator: "technical-trace",
        code: "technical-trace-missing-fact-id",
        location: "$.findings",
        issueCount: 4,
      },
      completedOutcomeRefusal: true,
      legacyLedgerIndex: true,
      checkpointAttempt: 2,
      checkpointSourceAttemptHighWater: 1,
      evaluatorAttempts: [
        { attempt: 1, outcome: "malformed-response" },
        { attempt: 2, outcome: "succeeded" },
      ],
      legacyAnswerRows: [
        { key: "singleton", state: "admitted", attempt: 1 },
        { key: "released-earlier", state: "released", attempt: 1 },
      ],
      legacyHistoricalReAdmitTombstone: true,
      legacyMutation,
    });
    const request = parseRunArguments([
      "update-documentation",
      "--repo",
      repositoryPath,
      "--resume-from",
      source.id,
      "--allow-write",
    ]) as RunRequestWithPublishProjection;

    await expect(
      loadAnswerRecordContinuation(request, { stateDirectory } as DocsFabConfig),
    ).rejects.toThrow(/checkpoint-(?:pointer|ledger)-mismatch/u);
  });

  it.each([
    ["missing the pointer attempt", [{ attempt: 1, outcome: "succeeded" }]],
    [
      "ending in a failed attempt",
      [
        { attempt: 1, outcome: "malformed-response" },
        { attempt: 2, outcome: "provider-transient" },
      ],
    ],
    [
      "with a nonsequential attempt number",
      [
        { attempt: 1, outcome: "malformed-response" },
        { attempt: 3, outcome: "succeeded" },
      ],
    ],
  ] as const)("refuses copied legacy pointer evidence %s", async (_label, evaluatorAttempts) => {
    const stateDirectory = join(root, "state");
    const source = await createStoppedSource({
      stateDirectory,
      repositoryPath,
      artifacts: new DurableArtifactStore(join(root, "artifacts")),
      evaluatorStatus: "succeeded",
      qualityValidationRejection: {
        validator: "technical-trace",
        code: "technical-trace-missing-fact-id",
        location: "$.findings",
        issueCount: 4,
      },
      completedOutcomeRefusal: true,
      legacyLedgerIndex: true,
      checkpointAttempt: 2,
      checkpointSourceAttemptHighWater: 1,
      evaluatorAttempts,
    });
    const request = parseRunArguments([
      "update-documentation",
      "--repo",
      repositoryPath,
      "--resume-from",
      source.id,
      "--allow-write",
    ]) as RunRequestWithPublishProjection;

    await expect(
      loadAnswerRecordContinuation(request, { stateDirectory } as DocsFabConfig),
    ).rejects.toThrow(/checkpoint-binding-mismatch/u);
  });

  it.each([
    ["a successful workflow", { sourceStatus: "succeeded" as const }],
    ["no typed quality rejection", { qualityValidationRejection: undefined }],
    ["an admitted quality validation product", { qualityArtifactValidation: { status: "passed" } }],
    ["an evaluator output product", { evaluatorOutputArtifact: true }],
    ["an evaluator step output product", { evaluatorStepOutputArtifact: true }],
    [
      "an unrelated workflow failure",
      {
        completedOutcomeRefusal: false,
        sourceFailure: { class: "infrastructure", layer: "workflow", code: "provider-error" },
      },
    ],
    [
      "a host-fault quality rejection",
      {
        qualityValidationRejection: {
          validator: "technical-trace",
          code: "technical-trace-integrity-failed",
          location: "$",
          issueCount: 1,
        },
      },
    ],
  ] as const)("refuses a succeeded evaluator continuation for %s", async (_label, override) => {
    const stateDirectory = join(root, "state");
    const source = await createStoppedSource({
      stateDirectory,
      repositoryPath,
      artifacts: new DurableArtifactStore(join(root, "artifacts")),
      evaluatorStatus: "succeeded",
      qualityValidationRejection: {
        validator: "technical-trace",
        code: "technical-trace-missing-fact-id",
        location: "$.findings",
        issueCount: 4,
      },
      completedOutcomeRefusal: true,
      ...override,
    });
    const request = parseRunArguments([
      "update-documentation",
      "--repo",
      repositoryPath,
      "--resume-from",
      source.id,
      "--allow-write",
    ]) as RunRequestWithPublishProjection;

    const refusalCode = await loadAnswerRecordContinuation(request, {
      stateDirectory,
    } as DocsFabConfig).then(
      () => "resolved",
      (error: unknown) => {
        if (!(error instanceof Error)) return "non-error-rejection";
        return (
          error.message.match(
            /^The selected answer-record continuation was refused \(([^)]+)\)\./u,
          )?.[1] ?? "unrecognized-refusal"
        );
      },
    );
    expect(refusalCode).toBe(
      _label === "a successful workflow" ? "selected-run-ineligible" : "selected-step-ineligible",
    );
  });

  it("loads only the selected committed checkpoint and creates a fresh physical child", async () => {
    const stateDirectory = join(root, "state");
    const artifacts = new DurableArtifactStore(join(root, "artifacts"));
    const source = await createStoppedSource({ stateDirectory, repositoryPath, artifacts });
    const request = parseRunArguments([
      "update-documentation",
      "--repo",
      repositoryPath,
      "--resume-from",
      source.id,
      "--allow-write",
    ]) as RunRequestWithPublishProjection;
    const loaded = await loadAnswerRecordContinuation(request, {
      stateDirectory,
    } as DocsFabConfig);

    expect(loaded).toBeDefined();
    expect(loaded!.request.runId).not.toBe(source.id);
    expect(loaded!.request.revision).toBe(source.repository.revision);
    expect(loaded!.request.instruction).toBe(source.instruction);
    expect(loaded!.request.answerRecordContinuationReceipt).toMatchObject({
      sourceRunId: source.id,
      sourceRunRecordSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      checkpointSha256: source.steps.find((step) => step.id === "evaluate-document-quality")
        ?.answerRecordCheckpoint?.sha256,
      logicalRunId: source.id,
    });
    const path = workflowSelectedPath(getWorkflow("update-documentation"), "author").steps;
    const targetIndex = path.findIndex((step) => step.id === "evaluate-document-quality");
    expect(loaded!.answerRecordContinuation.resumeStepId).toBe("evaluate-document-quality");
    expect(loaded!.answerRecordContinuation.selectedPathId).toBe("author");
    expect(loaded!.answerRecordContinuation.selectionEvidence?.workflowBranchCoverage).toEqual(
      source.workflowBranchCoverage,
    );
    expect(loaded!.answerRecordContinuation.sourceArtifacts).toEqual(source.artifacts);
    expect(loaded!.answerRecordContinuation.completedPrefix.map((step) => step.id)).toEqual(
      path.slice(0, targetIndex).map((step) => step.id),
    );
    expect(loaded!.request.answerRecordContinuationReceipt?.inheritedPrefixSha256).toBe(
      answerRecordContinuationPrefixSha256(loaded!.answerRecordContinuation.completedPrefix),
    );
    const { recordSha256, ...checkpointBody } = loaded!.answerRecordContinuation.checkpoint.record;
    expect(recordSha256).toBe(canonicalDigest(checkpointBody));
    expect(checkpointBody.sourceRunId).toBe(source.id);
    expect(loaded!.requestIntent).toEqual(source.requestIntent);
    await expect(
      new AnswerRecordContinuationClaimStore(join(root, "answer-record-continuations")).inspect({
        sourceRunId: source.id,
        sourceRunRecordSha256: loaded!.sourceRunRecordSha256,
        checkpointSha256: loaded!.answerRecordContinuation.checkpoint.sha256,
        checkpointSequence: 1,
        checkpointAttempt: 1,
        logicalRunId: source.id,
      }),
    ).resolves.toBeUndefined();
  });

  it("does not treat an authenticated complete marker alone as terminal", async () => {
    const stateDirectory = join(root, "state");
    const source = await createStoppedSource({
      stateDirectory,
      repositoryPath,
      artifacts: new DurableArtifactStore(join(root, "artifacts")),
      // This CLI boundary fixture isolates marker-based eligibility. A
      // separate admission test verifies that restoration does not restore
      // whole-artifact validation or report readiness.
      checkpointComplete: true,
    });
    const request = parseRunArguments([
      "update-documentation",
      "--repo",
      repositoryPath,
      "--resume-from",
      source.id,
      "--allow-write",
    ]) as RunRequestWithPublishProjection;

    const loaded = await loadAnswerRecordContinuation(request, { stateDirectory } as DocsFabConfig);

    expect(loaded?.answerRecordContinuation.checkpoint.record.complete).toBe(true);
    expect(loaded?.request.runId).not.toBe(source.id);
  });

  it("continues to refuse a succeeded source even when its checkpoint is count-complete", async () => {
    const stateDirectory = join(root, "state");
    const source = await createStoppedSource({
      stateDirectory,
      repositoryPath,
      artifacts: new DurableArtifactStore(join(root, "artifacts")),
      checkpointComplete: true,
    });
    await rm(join(stateDirectory, `${source.id}.json`));
    await new FileRunStore(stateDirectory).save({ ...source, status: "succeeded" });
    const request = parseRunArguments([
      "update-documentation",
      "--repo",
      repositoryPath,
      "--resume-from",
      source.id,
      "--allow-write",
    ]) as RunRequestWithPublishProjection;

    await expect(
      loadAnswerRecordContinuation(request, { stateDirectory } as DocsFabConfig),
    ).rejects.toThrow(/selected-run-ineligible/u);
  });

  it("refuses to claim a continuation after its selected source changes", async () => {
    const stateDirectory = join(root, "state");
    const source = await createStoppedSource({
      stateDirectory,
      repositoryPath,
      artifacts: new DurableArtifactStore(join(root, "artifacts")),
    });
    const request = parseRunArguments([
      "update-documentation",
      "--repo",
      repositoryPath,
      "--resume-from",
      source.id,
      "--allow-write",
    ]) as RunRequestWithPublishProjection;
    const loaded = await loadAnswerRecordContinuation(request, { stateDirectory } as DocsFabConfig);
    expect(loaded).toBeDefined();

    await rm(join(stateDirectory, `${source.id}.json`));
    await new FileRunStore(stateDirectory).save({
      ...source,
      error: "changed after continuation load",
    });
    await expect(loaded!.claimAnswerRecordContinuation()).rejects.toMatchObject({
      code: "already-claimed",
    });

    const checkpoint = source.steps.find(
      (step) => step.id === "evaluate-document-quality",
    )?.answerRecordCheckpoint;
    expect(checkpoint).toBeDefined();
    await expect(
      new AnswerRecordContinuationClaimStore(join(root, "answer-record-continuations")).inspect({
        sourceRunId: source.id,
        sourceRunRecordSha256: loaded!.sourceRunRecordSha256,
        checkpointSha256: checkpoint!.sha256,
        checkpointSequence: checkpoint!.sequence,
        checkpointAttempt: checkpoint!.attempt,
        logicalRunId: source.id,
      }),
    ).resolves.toBeUndefined();
  });

  it("loads a current checkpoint with retained refusal diagnostics and verifies its seal", async () => {
    const stateDirectory = join(root, "state");
    const artifacts = new DurableArtifactStore(join(root, "artifacts"));
    const refusalDiagnostics = [
      { code: "evaluation-profile-semantics", location: "$.record", count: 4 },
    ];
    const source = await createStoppedSource({
      stateDirectory,
      repositoryPath,
      artifacts,
      refusalDiagnostics,
    });
    const request = parseRunArguments([
      "update-documentation",
      "--repo",
      repositoryPath,
      "--resume-from",
      source.id,
      "--allow-write",
    ]) as RunRequestWithPublishProjection;
    const loaded = await loadAnswerRecordContinuation(request, {
      stateDirectory,
    } as DocsFabConfig);

    expect(loaded?.answerRecordContinuation.checkpoint.record.refusalDiagnostics).toEqual(
      refusalDiagnostics,
    );
    const { recordSha256, ...checkpointBody } = loaded!.answerRecordContinuation.checkpoint.record;
    expect(recordSha256).toBe(canonicalDigest(checkpointBody));
  });

  it.each([
    ["a non-retainable rejection", [{ code: "free prose", location: "$.record", count: 1 }]],
    ["a non-positive count", [{ code: "invalid-shape", location: "$.record", count: 0 }]],
    [
      "duplicate rejection diagnostics",
      [
        { code: "invalid-shape", location: "$.record", count: 1 },
        { code: "invalid-shape", location: "$.record", count: 2 },
      ],
    ],
  ] as const)("rejects a checkpoint with %s", async (_label, refusalDiagnostics) => {
    const stateDirectory = join(root, "state");
    const artifacts = new DurableArtifactStore(join(root, "artifacts"));
    const source = await createStoppedSource({
      stateDirectory,
      repositoryPath,
      artifacts,
      refusalDiagnostics,
    });
    const request = parseRunArguments([
      "update-documentation",
      "--repo",
      repositoryPath,
      "--resume-from",
      source.id,
      "--allow-write",
    ]) as RunRequestWithPublishProjection;

    await expect(
      loadAnswerRecordContinuation(request, { stateDirectory } as DocsFabConfig),
    ).rejects.toThrow(/checkpoint-shape-invalid/u);
  });

  it("rejects checkpoint fields outside the closed legacy and diagnostic shapes", async () => {
    const stateDirectory = join(root, "state");
    const artifacts = new DurableArtifactStore(join(root, "artifacts"));
    const source = await createStoppedSource({
      stateDirectory,
      repositoryPath,
      artifacts,
      checkpointExtraField: true,
    });
    const request = parseRunArguments([
      "update-documentation",
      "--repo",
      repositoryPath,
      "--resume-from",
      source.id,
      "--allow-write",
    ]) as RunRequestWithPublishProjection;

    await expect(
      loadAnswerRecordContinuation(request, { stateDirectory } as DocsFabConfig),
    ).rejects.toThrow(/checkpoint-shape-invalid/u);
  });

  it("resumes a default review run without adding an instruction", async () => {
    const stateDirectory = join(root, "state");
    const artifacts = new DurableArtifactStore(join(root, "artifacts"));
    const source = await createStoppedSource({
      stateDirectory,
      repositoryPath,
      artifacts,
      workflow: "review-documentation",
      instruction: undefined,
    });
    const request = parseRunArguments([
      "review-documentation",
      "--repo",
      repositoryPath,
      "--resume-from",
      source.id,
    ]) as RunRequestWithPublishProjection;
    const loaded = await loadAnswerRecordContinuation(request, {
      stateDirectory,
    } as DocsFabConfig);

    expect(loaded).toBeDefined();
    expect(loaded!.source.instruction).toBeUndefined();
    expect(loaded!.request.instruction).toBeUndefined();
    expect(loaded!.requestIntent).toEqual(source.requestIntent);
  });

  it("refuses a caller instruction when the saved default review had none", async () => {
    const stateDirectory = join(root, "state");
    const artifacts = new DurableArtifactStore(join(root, "artifacts"));
    const source = await createStoppedSource({
      stateDirectory,
      repositoryPath,
      artifacts,
      workflow: "review-documentation",
      instruction: undefined,
    });
    const request = parseRunArguments([
      "review-documentation",
      "--repo",
      repositoryPath,
      "--resume-from",
      source.id,
      "--instruction",
      "Add a new review instruction.",
    ]) as RunRequestWithPublishProjection;

    await expect(
      loadAnswerRecordContinuation(request, { stateDirectory } as DocsFabConfig),
    ).rejects.toThrow(/requested-instruction-mismatch/u);
  });

  it("rejects an empty instruction on a saved review source", async () => {
    const stateDirectory = join(root, "state");
    const artifacts = new DurableArtifactStore(join(root, "artifacts"));
    const source = await createStoppedSource({
      stateDirectory,
      repositoryPath,
      artifacts,
      workflow: "review-documentation",
      instruction: "",
    });
    const request = parseRunArguments([
      "review-documentation",
      "--repo",
      repositoryPath,
      "--resume-from",
      source.id,
    ]) as RunRequestWithPublishProjection;

    await expect(
      loadAnswerRecordContinuation(request, { stateDirectory } as DocsFabConfig),
    ).rejects.toThrow(/selected-run-ineligible/u);
  });

  it("keeps update continuations instruction-bound and rejects a tampered intent seal", async () => {
    const stateDirectory = join(root, "state");
    const artifacts = new DurableArtifactStore(join(root, "artifacts"));
    const instruction = "Update the approved guide.";
    const intent = recordedIntent(instruction, {
      operation: "update",
      targets: [{ path: "docs/guide.md", quote: "approved guide" }],
    });
    const changedIntent = {
      ...intent,
      intent: { ...intent.intent!, instructionSha256: sha("9") },
    };
    const source = await createStoppedSource({
      stateDirectory,
      repositoryPath,
      artifacts,
      instruction,
      requestIntent: changedIntent,
    });
    const request = parseRunArguments([
      "update-documentation",
      "--repo",
      repositoryPath,
      "--resume-from",
      source.id,
      "--allow-write",
    ]) as RunRequestWithPublishProjection;

    await expect(
      loadAnswerRecordContinuation(request, { stateDirectory } as DocsFabConfig),
    ).rejects.toThrow(/source-request-intent-invalid/u);
  });

  it("still requires a concrete instruction for an update source", async () => {
    const stateDirectory = join(root, "state");
    const artifacts = new DurableArtifactStore(join(root, "artifacts"));
    const source = await createStoppedSource({
      stateDirectory,
      repositoryPath,
      artifacts,
      instruction: undefined,
    });
    const request = parseRunArguments([
      "update-documentation",
      "--repo",
      repositoryPath,
      "--resume-from",
      source.id,
      "--allow-write",
    ]) as RunRequestWithPublishProjection;

    await expect(
      loadAnswerRecordContinuation(request, { stateDirectory } as DocsFabConfig),
    ).rejects.toThrow(/selected-run-ineligible/u);
  });

  it("names the first child when a second exact continuation is attempted", async () => {
    const stateDirectory = join(root, "state");
    const artifacts = new DurableArtifactStore(join(root, "artifacts"));
    const source = await createStoppedSource({ stateDirectory, repositoryPath, artifacts });
    const request = parseRunArguments([
      "update-documentation",
      "--repo",
      repositoryPath,
      "--resume-from",
      source.id,
      "--allow-write",
    ]) as RunRequestWithPublishProjection;
    const first = await loadAnswerRecordContinuation(request, { stateDirectory } as DocsFabConfig);
    expect(first).toBeDefined();
    await first!.claimAnswerRecordContinuation();
    await expect(
      loadAnswerRecordContinuation(request, { stateDirectory } as DocsFabConfig),
    ).rejects.toThrow(first!.request.runId);
  });

  it("recovers the same child identity when a process died before its first run record", async () => {
    const stateDirectory = join(root, "state");
    const artifacts = new DurableArtifactStore(join(root, "artifacts"));
    const source = await createStoppedSource({ stateDirectory, repositoryPath, artifacts });
    const request = parseRunArguments([
      "update-documentation",
      "--repo",
      repositoryPath,
      "--resume-from",
      source.id,
      "--allow-write",
    ]) as RunRequestWithPublishProjection;
    const sourceRecord = await new FileRunStore(stateDirectory).getWithDigest(source.id);
    const checkpointSha256 = source.steps.find((step) => step.id === "evaluate-document-quality")
      ?.answerRecordCheckpoint?.sha256;
    if (!checkpointSha256) throw new Error("Fixture has no committed checkpoint pointer.");
    const claims = new AnswerRecordContinuationClaimStore(
      join(root, "answer-record-continuations"),
      undefined,
      () => "claim-orphaned",
      {
        ownerPid: () => 2_147_483_000,
        ownerHost: () => `${process.platform}:${hostname()}`,
        ownerIsAlive: () => false,
      },
    );
    await claims.claim({
      sourceRunId: source.id,
      sourceRunRecordSha256: sourceRecord.sha256,
      checkpointSha256,
      checkpointSequence: 1,
      checkpointAttempt: 1,
      logicalRunId: source.id,
      childRunId: "recoverable-child",
    });

    const resumed = await loadAnswerRecordContinuation(request, {
      stateDirectory,
    } as DocsFabConfig);
    expect(resumed?.request.runId).toBe("recoverable-child");
    await resumed!.claimAnswerRecordContinuation();
    const latest = await claims.inspect({
      sourceRunId: source.id,
      sourceRunRecordSha256: sourceRecord.sha256,
      checkpointSha256,
      checkpointSequence: 1,
      checkpointAttempt: 1,
      logicalRunId: source.id,
    });
    expect(latest).toMatchObject({ generation: 1, childRunId: "recoverable-child" });
  });

  it("recovers a same-host orphan through a chained continuation and keeps its source unchanged", async () => {
    const fixture = await createOrphanedContinuationFixture({
      stateDirectory: join(root, "state"),
      repositoryPath,
      artifacts: new DurableArtifactStore(join(root, "artifacts")),
      depth: 2,
    });
    const before = await new FileRunStore(fixture.stateDirectory).getWithDigest(fixture.source.id);
    const loaded = await loadAnswerRecordContinuation(fixture.request, {
      stateDirectory: fixture.stateDirectory,
    } as DocsFabConfig);

    expect(loaded).toBeDefined();
    expect(loaded!.sourceRunRecordSha256).toBe(before.sha256);
    expect(loaded!.request.runId).not.toBe(fixture.source.id);
    expect(loaded!.request.answerRecordContinuationReceipt).toMatchObject({
      recoveryBasis: "same-host-owner-process-exited",
      sourceRunId: fixture.source.id,
      inheritedPrefixSha256: answerRecordContinuationPrefixSha256(
        loaded!.answerRecordContinuation.completedPrefix,
      ),
    });
    expect(loaded!.answerRecordContinuation.completedPrefix).toEqual(
      fixture.source.steps.slice(
        0,
        fixture.source.steps.findIndex((step) => step.id === "evaluate-document-quality"),
      ),
    );
    await loaded!.claimAnswerRecordContinuation();
    const after = await new FileRunStore(fixture.stateDirectory).getWithDigest(fixture.source.id);
    expect(after.sha256).toBe(before.sha256);
    expect(after.record).toEqual(before.record);
    const renewed = await fixture.claims.inspect(fixture.claimIdentity);
    expect(renewed).toMatchObject({ childRunId: fixture.source.id });
  });

  it("authenticates a legacy copied pointer while proving an orphaned parent", async () => {
    const fixture = await createOrphanedContinuationFixture({
      stateDirectory: join(root, "state"),
      repositoryPath,
      artifacts: new DurableArtifactStore(join(root, "artifacts")),
      legacyCopiedParent: true,
    });

    const loaded = await loadAnswerRecordContinuation(fixture.request, {
      stateDirectory: fixture.stateDirectory,
    } as DocsFabConfig);

    expect(loaded?.source.id).toBe(fixture.source.id);
    expect(loaded?.answerRecordContinuation.checkpoint.record.sourceAttemptHighWater).toBe(1);
  });

  it("recovers a live-owner-lost orphan whose parent checkpoint filled its planned slots", async () => {
    const fixture = await createOrphanedContinuationFixture({
      stateDirectory: join(root, "state"),
      repositoryPath,
      artifacts: new DurableArtifactStore(join(root, "artifacts")),
      checkpointComplete: true,
    });

    const loaded = await loadAnswerRecordContinuation(fixture.request, {
      stateDirectory: fixture.stateDirectory,
    } as DocsFabConfig);

    expect(loaded).toBeDefined();
    expect(loaded!.answerRecordContinuation.checkpoint.record.complete).toBe(true);
    await loaded!.claimAnswerRecordContinuation();
  });

  it.each([
    ["a live owner", { ownerPid: process.pid }],
    ["a foreign host", { ownerHost: "foreign:host" }],
    ["a mismatched claim child", { claimChildRunId: "different-child" }],
    ["a missing claim", { omitClaim: true }],
  ] as const)(
    "refuses running sources with %s before continuation work",
    async (_label, options) => {
      const fixture = await createOrphanedContinuationFixture({
        stateDirectory: join(root, "state"),
        repositoryPath,
        artifacts: new DurableArtifactStore(join(root, "artifacts")),
        ...options,
      });
      await expect(
        loadAnswerRecordContinuation(fixture.request, {
          stateDirectory: fixture.stateDirectory,
        } as DocsFabConfig),
      ).rejects.toThrow(/selected-run-ineligible/u);
    },
  );

  it.each(["missing receipt", "receipt naming a different parent"] as const)(
    "refuses an orphan source with a %s",
    async (mutation) => {
      const fixture = await createOrphanedContinuationFixture({
        stateDirectory: join(root, "state"),
        repositoryPath,
        artifacts: new DurableArtifactStore(join(root, "artifacts")),
      });
      const changedSource = structuredClone(fixture.source);
      if (mutation === "missing receipt") {
        delete changedSource.answerRecordContinuation;
      } else {
        changedSource.answerRecordContinuation = {
          ...changedSource.answerRecordContinuation!,
          sourceRunId: "other-parent",
        };
      }
      await rm(join(fixture.stateDirectory, `${changedSource.id}.json`));
      await new FileRunStore(fixture.stateDirectory).save(changedSource);
      await expect(
        loadAnswerRecordContinuation(fixture.request, {
          stateDirectory: fixture.stateDirectory,
        } as DocsFabConfig),
      ).rejects.toThrow(/selected-run-ineligible/u);
    },
  );

  it("allows only one concurrent continuation claim for an orphan checkpoint", async () => {
    const fixture = await createOrphanedContinuationFixture({
      stateDirectory: join(root, "state"),
      repositoryPath,
      artifacts: new DurableArtifactStore(join(root, "artifacts")),
    });
    const [first, second] = await Promise.all([
      loadAnswerRecordContinuation(fixture.request, {
        stateDirectory: fixture.stateDirectory,
      } as DocsFabConfig),
      loadAnswerRecordContinuation(fixture.request, {
        stateDirectory: fixture.stateDirectory,
      } as DocsFabConfig),
    ]);
    const results = await Promise.allSettled([
      first!.claimAnswerRecordContinuation(),
      second!.claimAnswerRecordContinuation(),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const sourceDigest = (
      await new FileRunStore(fixture.stateDirectory).getWithDigest(fixture.source.id)
    ).sha256;
    const checkpointPointer = fixture.source.steps.find(
      (step) => step.id === "evaluate-document-quality",
    )?.answerRecordCheckpoint;
    expect(checkpointPointer).toBeDefined();
    const winningClaim = await new AnswerRecordContinuationClaimStore(
      join(dirname(fixture.stateDirectory), "answer-record-continuations"),
    ).inspect({
      sourceRunId: fixture.source.id,
      sourceRunRecordSha256: sourceDigest,
      checkpointSha256: checkpointPointer!.sha256,
      checkpointSequence: checkpointPointer!.sequence,
      checkpointAttempt: checkpointPointer!.attempt,
      logicalRunId: fixture.source.answerRecordContinuation!.logicalRunId,
    });
    expect([first!.request.runId, second!.request.runId]).toContain(winningClaim?.childRunId);
    expect(winningClaim?.childRunId).not.toBe(fixture.source.id);
  });

  it.each([
    "changed-parent-digest",
    "corrupted-parent-checkpoint",
    "malformed-source-shape",
  ] as const)(
    "refuses orphan recovery with %s before returning a continuation",
    async (mutation) => {
      const fixture = await createOrphanedContinuationFixture({
        stateDirectory: join(root, "state"),
        repositoryPath,
        artifacts: new DurableArtifactStore(join(root, "artifacts")),
      });
      if (mutation === "changed-parent-digest") {
        const changedParent = { ...fixture.parent, error: "substituted parent" };
        await rm(join(fixture.stateDirectory, `${changedParent.id}.json`));
        await new FileRunStore(fixture.stateDirectory).save(changedParent);
      } else if (mutation === "corrupted-parent-checkpoint") {
        await rm(
          join(
            root,
            "artifacts",
            "objects",
            "sha256",
            `${fixture.claimIdentity.checkpointSha256}.json`,
          ),
        );
      } else {
        await rm(join(fixture.stateDirectory, `${fixture.source.id}.json`));
        await new FileRunStore(fixture.stateDirectory).save({
          ...fixture.source,
          repository: null,
        } as unknown as RunRecord);
      }
      await expect(
        loadAnswerRecordContinuation(fixture.request, {
          stateDirectory: fixture.stateDirectory,
        } as DocsFabConfig),
      ).rejects.toThrow(/selected-run-ineligible/u);
    },
  );

  it("refuses a checkpoint pointer that does not resolve to the named sealed bytes", async () => {
    const stateDirectory = join(root, "state");
    const artifacts = new DurableArtifactStore(join(root, "artifacts"));
    const source = await createStoppedSource({
      stateDirectory,
      repositoryPath,
      artifacts,
      pointAtMissingCheckpoint: true,
    });
    const request = parseRunArguments([
      "update-documentation",
      "--repo",
      repositoryPath,
      "--resume-from",
      source.id,
      "--allow-write",
    ]) as RunRequestWithPublishProjection;
    await expect(
      loadAnswerRecordContinuation(request, { stateDirectory } as DocsFabConfig),
    ).rejects.toThrow(/checkpoint|artifact|digest/u);
    const claimStore = new AnswerRecordContinuationClaimStore(
      join(root, "answer-record-continuations"),
    );
    await expect(
      claimStore.inspect({
        sourceRunId: source.id,
        sourceRunRecordSha256: "a".repeat(64),
        checkpointSha256: "f".repeat(64),
        checkpointSequence: 1,
        checkpointAttempt: 1,
        logicalRunId: source.id,
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["missing-digest", false],
    ["tampered-digest", false],
    ["missing-digest", true],
    ["tampered-digest", true],
  ] as const)(
    "refuses a checkpoint with %s and complete=%s before returning a child or claiming it",
    async (checkpointSeal, checkpointComplete) => {
      const stateDirectory = join(root, "state");
      const artifacts = new DurableArtifactStore(join(root, "artifacts"));
      const source = await createStoppedSource({
        stateDirectory,
        repositoryPath,
        artifacts,
        checkpointSeal,
        checkpointComplete,
      });
      const request = parseRunArguments([
        "update-documentation",
        "--repo",
        repositoryPath,
        "--resume-from",
        source.id,
        "--allow-write",
      ]) as RunRequestWithPublishProjection;
      await expect(
        loadAnswerRecordContinuation(request, { stateDirectory } as DocsFabConfig),
      ).rejects.toThrow(/checkpoint-shape-invalid/u);

      // Loading fails before a continuation is returned to the runner, so no
      // provider path or claim callback can be entered.
      const sourceRecord = await new FileRunStore(stateDirectory).getWithDigest(source.id);
      const pointer = source.steps.find(
        (step) => step.id === "evaluate-document-quality",
      )?.answerRecordCheckpoint;
      expect(pointer).toBeDefined();
      await expect(
        new AnswerRecordContinuationClaimStore(join(root, "answer-record-continuations")).inspect({
          sourceRunId: source.id,
          sourceRunRecordSha256: sourceRecord.sha256,
          checkpointSha256: pointer!.sha256,
          checkpointSequence: pointer!.sequence,
          checkpointAttempt: pointer!.attempt,
          logicalRunId: source.id,
        }),
      ).resolves.toBeUndefined();
    },
  );
});

async function createOrphanedContinuationFixture(input: {
  readonly stateDirectory: string;
  readonly repositoryPath: string;
  readonly artifacts: DurableArtifactStore;
  readonly depth?: number;
  readonly checkpointComplete?: boolean;
  readonly ownerPid?: number;
  readonly ownerHost?: string;
  readonly claimChildRunId?: string;
  readonly omitClaim?: boolean;
  readonly legacyCopiedParent?: boolean;
}): Promise<{
  readonly stateDirectory: string;
  readonly parent: RunRecord;
  readonly source: RunRecord;
  readonly request: RunRequestWithPublishProjection;
  readonly claims: AnswerRecordContinuationClaimStore;
  readonly claimIdentity: {
    readonly sourceRunId: string;
    readonly sourceRunRecordSha256: string;
    readonly checkpointSha256: string;
    readonly checkpointSequence: number;
    readonly checkpointAttempt: number;
    readonly logicalRunId: string;
  };
}> {
  const parent = await createStoppedSource({
    stateDirectory: input.stateDirectory,
    repositoryPath: input.repositoryPath,
    artifacts: input.artifacts,
    checkpointComplete: input.checkpointComplete,
    ...(input.legacyCopiedParent
      ? {
          evaluatorStatus: "succeeded" as const,
          qualityValidationRejection: {
            validator: "technical-trace",
            code: "technical-trace-missing-fact-id",
            location: "$.findings",
            issueCount: 4,
          },
          completedOutcomeRefusal: true,
          legacyLedgerIndex: true,
          checkpointAttempt: 2,
          checkpointSourceAttemptHighWater: 1,
          evaluatorAttempts: [
            { attempt: 1, outcome: "malformed-response" },
            { attempt: 2, outcome: "succeeded" },
          ],
        }
      : {}),
  });
  let current = parent;
  let previous = parent;
  const depth = input.depth ?? 1;

  for (let index = 0; index < depth; index += 1) {
    previous = current;
    const parentRead = await new FileRunStore(input.stateDirectory).getWithDigest(previous.id);
    const parentStepIndex = previous.steps.findIndex(
      (step) => step.id === "evaluate-document-quality",
    );
    const parentTarget = previous.steps[parentStepIndex];
    const parentPointer = parentTarget?.answerRecordCheckpoint;
    if (!parentPointer) throw new Error("Fixture parent has no committed evaluator checkpoint.");
    const parentCheckpoint = await input.artifacts.getRecord(parentPointer.sha256);
    if (!parentCheckpoint || typeof parentCheckpoint !== "object") {
      throw new Error("Fixture parent checkpoint is unavailable.");
    }
    const { recordSha256: _priorSeal, ...checkpointBody } = parentCheckpoint as Record<
      string,
      unknown
    >;
    const sourceId = `orphan-child-${index + 1}`;
    const logicalRunId = previous.answerRecordContinuation?.logicalRunId ?? previous.id;
    const childCheckpoint = checkpointKit.seal(
      "docsfab-answer-record-continuation-checkpoint",
      "recordSha256",
      {
        ...checkpointBody,
        continuationId: `orphan-continuation-${index + 1}`,
        sequence: parentPointer.sequence + 1,
        predecessorCheckpointSha256: parentPointer.sha256,
        sourceRunId: sourceId,
        logicalRunId,
      } as AnswerRecordContinuationCheckpointV1,
    );
    const checkpointSha256 = opaqueRecordDigest(childCheckpoint);
    await input.artifacts.putRecord(checkpointSha256, childCheckpoint);

    const prefix = previous.steps.slice(0, parentStepIndex).map((step) => ({
      ...structuredClone(step),
      inheritedFrom: {
        sourceRunId: previous.id,
        sourceRunRecordSha256: parentRead.sha256,
        sourceStepId: step.id,
      },
    }));
    const receipt: AnswerRecordContinuationReceiptV1 = {
      schemaVersion: 1,
      kind: "docsfab-answer-record-continuation-receipt",
      sourceRunId: previous.id,
      sourceRunRecordSha256: parentRead.sha256,
      checkpointSha256: parentPointer.sha256,
      checkpointSequence: parentPointer.sequence,
      checkpointAttempt: parentPointer.attempt,
      logicalRunId,
      inheritedPrefixSha256: answerRecordContinuationPrefixSha256(prefix),
    };
    const targetPointer = {
      sha256: checkpointSha256,
      sequence: childCheckpoint.sequence,
      attempt: 1,
    };
    const steps = previous.steps.map((step, stepIndex) => {
      if (stepIndex < parentStepIndex) return prefix[stepIndex]!;
      if (stepIndex !== parentStepIndex) return structuredClone(step);
      const progress = step.answerRecordLedger?.progress;
      return {
        ...structuredClone(step),
        status: index === depth - 1 ? "running" : "failed",
        answerRecordCheckpoint: targetPointer,
        answerRecordLedger: {
          ...structuredClone(step.answerRecordLedger!),
          checkpoint: targetPointer,
          progress: {
            ...structuredClone(progress!),
            checkpointSequence: childCheckpoint.sequence,
            logicalRunId,
            sourceRunId: sourceId,
            sourceAttemptHighWater: childCheckpoint.sourceAttemptHighWater,
            complete: input.checkpointComplete ?? false,
          },
        },
      };
    }) as StepRunRecord[];
    const {
      error: _error,
      completedAt: _completedAt,
      durationMs: _durationMs,
      ...prior
    } = structuredClone(previous);
    current = {
      ...prior,
      id: sourceId,
      status: index === depth - 1 ? "running" : "failed",
      ...(index < depth - 1 ? { completedAt: previous.completedAt } : {}),
      answerRecordContinuation: receipt,
      steps,
    };
    await new FileRunStore(input.stateDirectory).save(current);
  }

  const source = current;
  const receipt = source.answerRecordContinuation!;
  const claimIdentity = {
    sourceRunId: receipt.sourceRunId,
    sourceRunRecordSha256: receipt.sourceRunRecordSha256,
    checkpointSha256: receipt.checkpointSha256,
    checkpointSequence: receipt.checkpointSequence,
    checkpointAttempt: receipt.checkpointAttempt,
    logicalRunId: receipt.logicalRunId,
  };
  const claims = new AnswerRecordContinuationClaimStore(
    join(dirname(input.stateDirectory), "answer-record-continuations"),
    undefined,
    () => "dead-owner-event",
    {
      ownerPid: () => input.ownerPid ?? 2_147_483_000,
      ownerHost: () => input.ownerHost ?? `${process.platform}:${hostname()}`,
      ownerIsAlive: () => false,
    },
  );
  if (!input.omitClaim) {
    await claims.claim({ ...claimIdentity, childRunId: input.claimChildRunId ?? source.id });
  }
  const request = parseRunArguments([
    source.workflow,
    "--repo",
    input.repositoryPath,
    "--resume-from",
    source.id,
    ...(source.workflow === "update-documentation" ? ["--allow-write"] : []),
  ]) as RunRequestWithPublishProjection;
  return {
    stateDirectory: input.stateDirectory,
    parent: previous,
    source,
    request,
    claims,
    claimIdentity,
  };
}

const checkpointKit = createContractKit({
  fail: (code) => {
    throw new Error(`Fixture checkpoint rejected: ${code}`);
  },
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "schema-mismatch",
  },
});

async function createStoppedSource(input: {
  readonly stateDirectory: string;
  readonly repositoryPath: string;
  readonly artifacts: DurableArtifactStore;
  readonly workflow?: "review-documentation" | "update-documentation";
  readonly instruction?: string;
  readonly requestIntent?: RunRecord["requestIntent"];
  readonly refusalDiagnostics?: readonly {
    readonly code: string;
    readonly location: string;
    readonly count: number;
  }[];
  readonly checkpointExtraField?: boolean;
  readonly pointAtMissingCheckpoint?: boolean;
  readonly checkpointSeal?: "missing-digest" | "tampered-digest";
  readonly checkpointComplete?: boolean;
  readonly evaluatorStatus?: StepRunRecord["status"];
  readonly sourceStatus?: RunRecord["status"];
  readonly evaluatorOutputArtifact?: boolean;
  readonly evaluatorStepOutputArtifact?: boolean;
  readonly qualityValidationRejection?: unknown;
  readonly completedOutcomeRefusal?: boolean;
  readonly sourceFailure?: unknown;
  readonly qualityArtifactValidation?: unknown;
  readonly legacyLedgerIndex?: boolean;
  readonly checkpointAttempt?: number;
  readonly checkpointSourceAttemptHighWater?: number;
  readonly evaluatorAttempts?: readonly { readonly attempt: number; readonly outcome: string }[];
  readonly legacyAnswerRows?: readonly {
    readonly key: string;
    readonly state: "admitted" | "released";
    readonly attempt: number;
  }[];
  readonly legacyHistoricalReAdmitTombstone?: boolean;
  readonly legacyMutation?:
    | "admitted-digest"
    | "admitted-attempt"
    | "missing-row"
    | "extra-row"
    | "bad-release-seal"
    | "bad-release-bindings"
    | "missing-release-tombstone"
    | "present-pointer-mismatch";
}): Promise<RunRecord> {
  const id = "source-run-1";
  const workflowName = input.workflow ?? "update-documentation";
  const workflow = getWorkflow(workflowName);
  const selectedSteps = isWorkflowManifestV2(workflow)
    ? workflowSelectedPath(workflow, "author").steps
    : workflow.steps;
  const selected = { steps: selectedSteps };
  const targetIndex = selected.steps.findIndex((step) => step.id === "evaluate-document-quality");
  const bindings = {
    declarationSha256: sha("a"),
    schemaSha256s: {},
    profilePayloadSha256: sha("b"),
    selectionSha256: sha("c"),
    referenceSourceSha256s: {},
    evaluatorIdentitySha256: sha("d"),
    compositionSha256: null,
    answerPathCapabilitySha256: sha("e"),
  };
  const legacyAnswerRows: {
    type: string;
    key: string;
    recordSha256: string;
    state: "admitted" | "released";
    attempt: number;
    payloadSha256: string;
  }[] = [];
  const legacyCheckpointRows: AnswerRecordContinuationCheckpointV1["rows"][number][] = [];
  for (const spec of input.legacyAnswerRows ?? []) {
    const payload = { finding: spec.key };
    const payloadSha256 = canonicalDigest(payload);
    const body = {
      contractId: "quality-evaluation",
      contractVersion: OUTPUT_RECORD_CONTRACTS["quality-evaluation"].version,
      runId: id,
      stepId: "evaluate-document-quality",
      attempt: spec.attempt,
      type: "evaluation-note" as const,
      key: spec.key,
      state: spec.state,
      bindings,
      payloadSha256,
      payload,
    };
    let sealed = checkpointKit.seal("docsfab-answer-record", "recordSha256", body);
    if (input.legacyMutation === "bad-release-bindings" && spec.state === "released") {
      sealed = checkpointKit.seal("docsfab-answer-record", "recordSha256", {
        ...body,
        bindings: { ...bindings, selectionSha256: sha("f") },
      });
    }
    if (input.legacyMutation === "bad-release-seal" && spec.state === "released") {
      sealed = { ...sealed, recordSha256: sha("f") };
    }
    const recordSha256 = opaqueRecordDigest(sealed);
    await input.artifacts.putRecord(recordSha256, sealed);
    legacyAnswerRows.push({
      type: body.type,
      key: body.key,
      recordSha256,
      state: body.state,
      attempt: body.attempt,
      payloadSha256,
    });
    if (spec.state === "admitted") {
      legacyCheckpointRows.push({
        type: body.type,
        key: body.key,
        recordSha256,
        payloadSha256,
        originalAttempt: body.attempt,
      });
    }
  }
  const legacyIndexRows = legacyAnswerRows.map((row) => ({
    type: row.type,
    key: row.key,
    recordSha256: row.recordSha256,
    state: row.state,
    attempt: row.attempt,
  }));
  if (input.legacyMutation === "admitted-digest") {
    const row = legacyIndexRows.find((candidate) => candidate.state === "admitted");
    if (row) row.recordSha256 = sha("f");
  } else if (input.legacyMutation === "admitted-attempt") {
    const row = legacyIndexRows.find((candidate) => candidate.state === "admitted");
    if (row) row.attempt += 1;
  } else if (input.legacyMutation === "missing-row") {
    legacyIndexRows.splice(0, legacyIndexRows.length);
  } else if (input.legacyMutation === "extra-row") {
    legacyIndexRows.push({
      type: "evaluation-note",
      key: "not-in-checkpoint",
      recordSha256: sha("f"),
      state: "admitted",
      attempt: 1,
    });
  }
  const legacyTombstones = [
    ...legacyAnswerRows
      .filter((row) => row.state === "released")
      .map((row) => ({
        type: row.type,
        key: row.key,
        reasonCode: "released",
        settlementSequence: 1,
      })),
    ...(input.legacyHistoricalReAdmitTombstone
      ? [
          {
            type: "evaluation-note",
            key: "singleton",
            reasonCode: "released",
            settlementSequence: 1,
          },
        ]
      : []),
  ].filter(
    (tombstone) =>
      !(
        input.legacyMutation === "missing-release-tombstone" && tombstone.key === "released-earlier"
      ),
  );
  const checkpoint: AnswerRecordContinuationCheckpointV1 = {
    schemaVersion: 1,
    kind: "docsfab-answer-record-continuation-checkpoint",
    continuationId: "continuation-1",
    sequence: 1,
    predecessorCheckpointSha256: null,
    sourceRunId: id,
    logicalRunId: id,
    stepId: "evaluate-document-quality",
    sourceAttemptHighWater: input.checkpointSourceAttemptHighWater ?? 1,
    bindingsSha256: canonicalDigest(bindings),
    bindings,
    rows: legacyCheckpointRows,
    issuedKeyHighWater: {},
    tombstones: legacyTombstones,
    refusalCounts: {},
    refusalExhaustion: null,
    settledBatchHighWater: 1,
    complete: input.checkpointComplete ?? false,
  };
  const sealedCheckpoint = checkpointKit.seal(
    "docsfab-answer-record-continuation-checkpoint",
    "recordSha256",
    {
      ...checkpoint,
      ...(input.refusalDiagnostics === undefined
        ? {}
        : { refusalDiagnostics: input.refusalDiagnostics }),
      ...(input.checkpointExtraField ? { extraField: true } : {}),
    } as AnswerRecordContinuationCheckpointV1,
  );
  const storedCheckpoint =
    input.checkpointSeal === "missing-digest"
      ? Object.fromEntries(
          Object.entries(sealedCheckpoint).filter(([key]) => key !== "recordSha256"),
        )
      : input.checkpointSeal === "tampered-digest"
        ? { ...sealedCheckpoint, recordSha256: sha("9") }
        : sealedCheckpoint;
  const checkpointSha256 = opaqueRecordDigest(storedCheckpoint);
  await input.artifacts.putRecord(checkpointSha256, storedCheckpoint);
  const selectedCheckpointSha256 = input.pointAtMissingCheckpoint ? sha("f") : checkpointSha256;
  const steps = selected.steps.map((step, index) => ({
    id: step.id,
    title: step.title,
    kind: step.kind,
    skill: step.skill,
    mode: step.mode,
    status:
      index < targetIndex
        ? "succeeded"
        : index === targetIndex
          ? (input.evaluatorStatus ?? "failed")
          : "pending",
    ...(index === targetIndex && input.qualityValidationRejection !== undefined
      ? { qualityValidationRejection: input.qualityValidationRejection }
      : {}),
    ...(index === targetIndex && input.evaluatorAttempts
      ? {
          inference: {
            attempts: input.evaluatorAttempts.map((attempt) => ({
              ...attempt,
              retryable: false,
              retryScheduled: false,
            })),
          },
        }
      : {}),
    ...(index === targetIndex
      ? {
          answerRecordCheckpoint: {
            sha256: selectedCheckpointSha256,
            sequence: 1,
            attempt: input.checkpointAttempt ?? 1,
          },
          answerRecordLedger: {
            schemaVersion: 1,
            kind: "docsfab-answer-record-ledger-index",
            contractId: "quality-evaluation",
            bindingsSha256: canonicalDigest(bindings),
            rows: legacyIndexRows,
            ...(input.legacyLedgerIndex
              ? {}
              : { checkpoint: { sha256: selectedCheckpointSha256, sequence: 1, attempt: 1 } }),
            ...(input.legacyMutation === "present-pointer-mismatch"
              ? { checkpoint: { sha256: sha("f"), sequence: 1, attempt: 2 } }
              : {}),
            ...(input.legacyLedgerIndex
              ? {}
              : {
                  progress: {
                    admittedRowCount: 0,
                    releasedRowCount: 0,
                    remainingKeyCount: input.checkpointComplete ? 0 : 1,
                    refusalEventCount: 0,
                    complete: input.checkpointComplete ?? false,
                    checkpointSequence: 1,
                    logicalRunId: id,
                    sourceRunId: id,
                    sourceAttemptHighWater: input.checkpointSourceAttemptHighWater ?? 1,
                  },
                }),
          },
        }
      : {}),
  })) as StepRunRecord[];
  const revision = sha("1").slice(0, 40);
  const candidateArtifact: EditorialDecisionArtifactReferenceV3 = {
    kind: "editorial-decision",
    schemaVersion: 3,
    digest: sha("3"),
    repositoryRevision: revision,
    repositoryContentDigest: sha("4"),
  };
  if (input.evaluatorStepOutputArtifact) {
    steps[targetIndex] = {
      ...steps[targetIndex]!,
      artifacts: [
        { role: "output", stepId: "evaluate-document-quality", reference: candidateArtifact },
      ],
    };
  }
  const source = {
    schemaVersion: 2,
    id,
    workflow: workflowName,
    repository: {
      sourcePath: input.repositoryPath,
      requestedRevision: "HEAD",
      revision,
    },
    workspace: { strategy: "tracked-export", disposable: true },
    ...(Object.hasOwn(input, "instruction")
      ? input.instruction === undefined
        ? {}
        : { instruction: input.instruction }
      : { instruction: "Update the approved guide." }),
    requestIntent: input.requestIntent ?? {
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
    ...(isWorkflowManifestV2(workflow)
      ? {
          workflowBranchCoverage: createWorkflowBranchCoverageV1({
            workflow,
            repositoryRevision: revision,
            workspaceSnapshotSha256: sha("5"),
            selection: { branchId: "author", candidateArtifact },
          }),
        }
      : {}),
    artifacts: [
      { role: "output", stepId: "plan-documentation", reference: candidateArtifact },
      ...(input.evaluatorOutputArtifact
        ? [
            {
              role: "output" as const,
              stepId: "evaluate-document-quality",
              reference: { ...candidateArtifact, digest: sha("6") },
            },
          ]
        : []),
    ],
    status: input.sourceStatus ?? "failed",
    error: "Quality evaluator attempt ended.",
    createdAt: "2026-10-10T00:00:00.000Z",
    completedAt: "2026-10-10T00:01:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps,
    ...(input.completedOutcomeRefusal
      ? {
          workflowOutcomeRejection: {
            code: "workflow-outcome-admission-execution-product-mismatch",
            location: "$.status",
          },
          failure: {
            class: "contract-shape",
            layer: "workflow",
            code: "workflow-outcome-admission-execution-product-mismatch",
          },
        }
      : {}),
    ...(input.sourceFailure !== undefined ? { failure: input.sourceFailure } : {}),
    ...(input.qualityArtifactValidation !== undefined
      ? { qualityArtifactValidation: input.qualityArtifactValidation }
      : {}),
  } as unknown as RunRecord;
  await new FileRunStore(input.stateDirectory).save(source);
  return source;
}
