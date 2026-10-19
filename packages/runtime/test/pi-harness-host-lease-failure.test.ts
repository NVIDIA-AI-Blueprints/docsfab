// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { ExecutionLeaseCoordinatorError } from "../src/execution/lease-coordinator.js";
import { PiExecutionLeaseController } from "../src/harness/pi-lease.js";
import {
  classifyInferenceAttempt,
  classifyThrownFailure,
} from "../src/operator/failure-classification.js";
import { classifyAttemptRow } from "../src/diagnosis/classify.js";
import { decodeInference } from "../src/scorecard-record.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import { parseRetryPolicy } from "../src/config/retry-policy.js";
import { buildRunHumanNextCommand } from "../src/operator/run-next-action.js";
import { projectRunIndexRows } from "../src/records/run-index.js";
import { QUALITY_ANSWER_RECORD_TOOL_NAME } from "../src/harness/answer-submission.js";
import {
  PiHarness,
  boundStyleContext,
  createProviderConnectionFactory,
  createRepository,
  captureInferenceFailure,
  executeInferenceStep,
  skillCrateDirectory,
  resetSharedTestState,
  stepInput,
  toolTurn,
  testTimeoutMs,
  validModelConfig,
  fixtureCompositionExecutionProfile,
  projectRoot,
} from "./support/pi-harness-session-fixtures.js";
import {
  qualityStepInput,
  rawToolCallTurn,
  toolPathHarness,
} from "./support/answer-submission-fixtures.js";
import { resolve } from "node:path";

afterEach(async () => {
  vi.restoreAllMocks();
  await resetSharedTestState();
});

describe("host-origin inference failures", () => {
  it.each([false, true])(
    "records a real Pi checkpoint rejection as host infrastructure (abortAtCheckpoint=%s)",
    async (abortAtCheckpoint) => {
      const repositoryPath = await createRepository();
      const baseInput = await qualityStepInput(repositoryPath, {
        path: "tool-call",
        reason: "recorded-route",
      });
      const { answerSubmission: _answerSubmission, ...input } = baseInput;
      let fetchCalls = 0;
      vi.stubGlobal("fetch", async () => {
        fetchCalls += 1;
        return rawToolCallTurn([
          {
            id: "checkpoint-call",
            name: QUALITY_ANSWER_RECORD_TOOL_NAME,
            chunks: [
              JSON.stringify({ type: "dimension", key: "done", record: { evidence: "fixture" } }),
            ],
          },
        ]);
      });
      const harness = toolPathHarness({
        environment: { DOCSFAB_COMPOSITION_EXECUTION_CALLS_PER_LEASE: "1" },
      });
      const abort = new AbortController();
      const applyHostCheckpoint = vi
        .spyOn(PiExecutionLeaseController.prototype, "applyHostCheckpoint")
        .mockImplementation(() => {
          if (abortAtCheckpoint) abort.abort();
          throw new ExecutionLeaseCoordinatorError();
        });
      const stop = vi.spyOn(PiExecutionLeaseController.prototype, "stop").mockImplementation(() => {
        throw new ExecutionLeaseCoordinatorError();
      });
      let progress = {
        requiredKeys: ["dimension:done"],
        remainingKeys: ["dimension:done"],
        completedKeys: [] as string[],
        openSets: [] as string[],
        complete: false,
      };
      const result = await executeInferenceStep({
        signal: abort.signal,
        mode: input.step.mode,
        policy: parseRetryPolicy({}),
        evidenceIdentity: input.evidenceIdentity,
        sleep: async () => {},
        execute: (attempt, responseCorrection) =>
          harness.runStep({
            ...input,
            signal: abort.signal,
            inferenceAttempt: attempt,
            retriesConsumed: attempt - 1,
            qualityAnswerRecordCallCeiling: 1,
            qualityAnswerRecordGuidance: "Record the one fixture dimension.",
            qualityAnswerRecordProgress: progress,
            qualityAnswerRecordRemainingKeys: ["dimension:done"],
            experimentalAnswerRecordDiscoveryRenewal: true,
            qualityAnswerRecords: {
              answerNowProgress: () => progress,
              prepareBatch: async () => {},
              receipt: () => ({
                status: "admitted",
                type: "dimension",
                key: "done",
                remaining: ["dimension:done"],
                complete: false,
              }),
              settle: async () => {
                progress = {
                  requiredKeys: ["dimension:done"],
                  remainingKeys: [],
                  completedKeys: ["dimension:done"],
                  openSets: [],
                  complete: true,
                };
              },
              takeReportReadiness: () => false,
            },
            ...(responseCorrection ? { responseCorrection } : {}),
          }),
      });

      expect(result.status).toBe("failed");
      if (result.status !== "failed") throw new Error("Expected failed inference execution.");
      const attempt = result.evidence.attempts[0]!;
      expect(fetchCalls).toBeGreaterThan(0);
      expect(applyHostCheckpoint).toHaveBeenCalledOnce();
      expect(attempt.outcome).toBe("host-runtime-failure");
      expect(attempt).toMatchObject({
        retryable: false,
        retryScheduled: false,
        hostFailureOrigin: {
          schemaVersion: 1,
          origin: "execution-lease-coordinator",
          code: "invalid-execution-lease-coordinator",
        },
      });
      expect(attempt).toHaveProperty("identity");
      expect(attempt).toHaveProperty("model");
      expect(attempt).toHaveProperty("usage");
      expect(attempt).toHaveProperty("tools");
      expect(abort.signal.aborted).toBe(abortAtCheckpoint);
      expect(classifyInferenceAttempt(attempt)).toEqual({
        class: "infrastructure",
        layer: "inference",
        code: "invalid-execution-lease-coordinator",
      });
      expect(classifyThrownFailure(result.error, "inference")).toEqual(
        classifyInferenceAttempt(attempt),
      );
      expect(classifyThrownFailure(result.error, "inference", { cancelled: true })).toEqual({
        class: "cancelled",
        layer: "workflow",
        code: "workflow-cancelled",
      });
      expect(stop).not.toHaveBeenCalled();
      const decoded = decodeInference(result.evidence);
      expect(decoded.attempts[0]?.outcome).toBe("host-runtime-failure");
      expect(decoded.attempts[0]?.executionLease?.phase).toBe("checkpoint-required");
      const providerResponses = decoded.attempts[0]?.providerResponses;
      expect(providerResponses).toMatchObject({
        schemaVersion: 1,
        state: "complete",
        pendingRequestSequences: [],
      });
      expect(providerResponses?.observations.length).toBe(fetchCalls);
      expect(providerResponses?.observations.every((item) => item.disposition === "complete")).toBe(
        true,
      );
      expect(
        providerResponses?.observations.every((item) => Number.isInteger(item.observedBytes)),
      ).toBe(true);

      // A minimal projection wrapper lets the actual decoded inference evidence
      // reach the run-index/operator projections without claiming this partial
      // object is a valid persisted RunRecord.
      const runRecord = {
        schemaVersion: 2,
        id: "host-checkpoint-failure",
        workflow: input.workflow.name,
        status: "failed",
        createdAt: "2026-10-11T00:00:00.000Z",
        steps: [
          {
            id: input.step.id,
            status: "failed",
            inference: decoded,
          },
        ],
      };
      const indexed = projectRunIndexRows(runRecord as never, {
        origin: "import",
        snapshotId: "snapshot-host-failure",
        indexedAt: "2026-10-11T00:00:00.000Z",
        recordSha256: "a".repeat(64),
        fieldMaxChars: 512,
      });
      expect(indexed.ok, JSON.stringify(indexed)).toBe(true);
      if (indexed.ok) {
        const attemptRow = indexed.rows.find((row) => row.rowKind === "attempt");
        expect(attemptRow).toMatchObject({
          failureClass: "infrastructure",
          failureLayer: "inference",
          failureCode: "invalid-execution-lease-coordinator",
          outcome: "host-runtime-failure",
        });
        expect(
          classifyAttemptRow(attemptRow!, {
            whyJson: "docsfab runs why-json host-checkpoint-failure",
            runsShow: "docsfab runs show host-checkpoint-failure",
          }),
        ).toMatchObject({
          cause: "host-runtime-failure",
          ownerClass: "docsfab-defect",
          signature: {
            outcome: "host-runtime-failure",
            failureClass: "infrastructure",
            failureLayer: "inference",
            failureCode: "invalid-execution-lease-coordinator",
          },
          nextCommand: "docsfab runs show host-checkpoint-failure",
        });

        expect(
          classifyAttemptRow(
            {
              ...attemptRow!,
              failureCode: "provider-timeout",
            },
            {
              whyJson: "docsfab runs why-json host-checkpoint-failure",
              runsShow: "docsfab runs show host-checkpoint-failure",
            },
          ).cause,
        ).toBe("uncatalogued-failure");
      }
      expect(buildRunHumanNextCommand({ record: runRecord as never })?.reason).toContain(
        "does not identify a provider failure",
      );

      const asRecord = (value: unknown) => value as Record<string, unknown>;
      const rehashLease = (lease: Record<string, unknown>) => {
        const { evidenceSha256: _oldDigest, ...body } = lease;
        lease.evidenceSha256 = canonicalDigest(body);
      };
      const laggedProviderAttempt = structuredClone(result.evidence) as unknown as {
        attempts: Array<Record<string, unknown>>;
      };
      laggedProviderAttempt.attempts[0]!.outcome = "provider-terminal";
      delete laggedProviderAttempt.attempts[0]!.hostFailureOrigin;
      expect(() => decodeInference(laggedProviderAttempt)).toThrow();

      const wrongPhase = structuredClone(result.evidence) as unknown as {
        attempts: Array<Record<string, unknown>>;
      };
      const wrongPhaseAttempt = wrongPhase.attempts[0]!;
      const wrongPhaseLease = asRecord(wrongPhaseAttempt.executionLease);
      wrongPhaseLease.phase = "active";
      rehashLease(wrongPhaseLease);
      expect(() => decodeInference(wrongPhase)).toThrow();

      const wrongCounters = structuredClone(result.evidence) as unknown as {
        attempts: Array<Record<string, unknown>>;
      };
      const wrongCountersAttempt = wrongCounters.attempts[0]!;
      asRecord(wrongCountersAttempt.tools).totalCalls = 0;
      expect(() => decodeInference(wrongCounters)).toThrow();
      expect(() =>
        decodeInference({
          ...result.evidence,
          attempts: [
            { ...attempt, hostFailureOrigin: { ...attempt.hostFailureOrigin, code: "timeout" } },
          ],
        } as never),
      ).toThrow();
    },
    testTimeoutMs(15_000),
  );

  it(
    "keeps an actual provider HTTP failure in the provider category",
    async () => {
      const repositoryPath = await createRepository();
      const profile = fixtureCompositionExecutionProfile({
        maxProviderTurns: 8,
        timeoutMs: 30_000,
        maxResponseBytes: 65_536,
      });
      const harness = new PiHarness({
        skillCrateDirectory,
        qualityDirectory: resolve(projectRoot, "quality"),
        styleContext: await boundStyleContext(),
        executionProfile: profile,
        credential: { family: "nvidia-inference-api", apiKey: validModelConfig.apiKey },
        providerConnectionFactory: createProviderConnectionFactory({
          routeId: profile.routeId,
          transport: profile.transport,
        }),
      });
      vi.stubGlobal(
        "fetch",
        async () =>
          new Response(
            JSON.stringify({ error: { type: "invalid_request_error", message: "invalid" } }),
            {
              status: 400,
              headers: { "content-type": "application/json" },
            },
          ),
      );

      const failure = await captureInferenceFailure(harness, stepInput(repositoryPath));
      expect(failure.category).toBe("invalid-request");
      expect(failure.hostFailureOrigin).toBeUndefined();
      expect(classifyThrownFailure(failure, "inference").code).not.toBe(
        "invalid-execution-lease-coordinator",
      );
    },
    testTimeoutMs(15_000),
  );
});
