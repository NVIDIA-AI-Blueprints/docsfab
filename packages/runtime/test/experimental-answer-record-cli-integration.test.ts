// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { withLocalWorkflowRun } from "../src/cli/run/local-workflow.js";
import { loadAnswerRecordContinuation } from "../src/cli/run/answer-record-continuation.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import { limit } from "../src/config/limits.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import { InferenceStepError } from "../src/execution/contracts.js";
import type { AgentHarness, QualityAnswerRecordSessionV1 } from "../src/execution/contracts.js";
import { QualityValidatorHost } from "../src/evaluation-report/quality-validator-host.js";
import { defaultRunRecordPath } from "../src/operator/run-summary.js";
import type { RunRecord } from "../src/records/contracts.js";
import { decodeSavedRunRecord } from "../src/records/saved-run-record.js";
import { validModelConfig } from "./helpers.js";
import { initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { verificationFixture } from "./helpers/verification.js";

const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));
const roots = temporaryRoots();

afterEach(async () => {
  await roots.cleanup();
  vi.restoreAllMocks();
});

describe("experimental answer-record discovery through the local CLI application", () => {
  it("keeps the flag explicit, workflow-scoped, and compatible with quiet output", () => {
    const base = ["review-documentation", "--repo", "/tmp/repository"];
    expect(parseRunArguments([...base]).experimentalAnswerRecords === true).toBe(false);
    expect(
      parseRunArguments([
        ...base,
        "--composition",
        "nvidia-nemotron-3-super-120b-a12b-pi",
        "--experimental-answer-records",
        "--quiet",
      ]),
    ).toMatchObject({ experimentalAnswerRecords: true, quiet: true });
    expect(() => parseRunArguments([...base, "--experimental-answer-records"])).toThrow(
      /requires an explicit --composition/u,
    );
    expect(() =>
      parseRunArguments([
        "create-documentation",
        "--repo",
        "/tmp/repository",
        "--instruction",
        "Create docs/guide.md.",
        "--composition",
        "nvidia-nemotron-3-super-120b-a12b-pi",
        "--experimental-answer-records",
      ]),
    ).toThrow(/supported only for review-documentation/u);
    expect(() =>
      parseRunArguments([
        ...base,
        "--composition",
        "nvidia-nemotron-3-super-120b-a12b-pi",
        "--experimental-answer-records",
        "--experimental-answer-records",
      ]),
    ).toThrow(/must not be duplicated/u);
  });

  it(
    "activates discovery through parseRunArguments and the real local application runner",
    async () => {
      const root = await roots.create("docsfab-experimental-answer-record-run-");
      const repositoryPath = join(root, "repo");
      const stateDirectory = join(root, "state", "runs");
      await initFixtureRepo(repositoryPath, {
        "README.md": "# Fixture\n",
        "docs/guide.md": "# Guide\n\nA deterministic documentation fixture.\n",
        "src/api.ts": Array.from(
          { length: 50 },
          (_, index) => `export const line${index + 1} = ${index + 1};`,
        ).join("\n"),
      });
      await mkdir(stateDirectory, { recursive: true });

      // This tiny opaque-session double checks only CLI-to-runner activation and
      // retry propagation. Real ledger admission and report assembly are covered
      // by the production QualityValidatorHost corpus journey.
      let remainingKeys = ["required-key-a", "required-key-b"];
      const calls: Array<{
        readonly remaining: readonly string[];
        readonly replay: number;
      }> = [];
      const pendingToolCalls = new Map<string, string>();
      const session = {
        capability: {
          answerNowProgress: () => ({
            requiredKeys: ["required-key-a", "required-key-b"],
            remainingKeys: [...remainingKeys],
            completedKeys: ["required-key-a", "required-key-b"].filter(
              (key) => !remainingKeys.includes(key),
            ),
            openSets: [],
            complete: remainingKeys.length === 0,
          }),
          async prepareBatch(input: {
            readonly toolCalls: readonly {
              readonly toolCallId: string;
              readonly rawArguments?: string;
            }[];
            readonly authorizedToolCallIds: readonly string[];
          }) {
            for (const call of input.toolCalls) {
              if (input.authorizedToolCallIds.includes(call.toolCallId) && call.rawArguments) {
                pendingToolCalls.set(call.toolCallId, call.rawArguments);
              }
            }
          },
          receipt: (toolCallId: string) => ({
            toolCallId,
            status: "admitted" as const,
            type: "dimension",
            key: "required-key-a",
          }),
          async settle(input: { readonly successfulToolCallIds: readonly string[] }) {
            if (input.successfulToolCallIds.some((id) => pendingToolCalls.has(id))) {
              remainingKeys = ["required-key-b"];
            }
          },
        },
        recordCallCeiling: 2,
        promptGuidance: "Submit host-planned answer records.",
        async restoreCheckpoint() {},
        checkpointWasStale: () => false,
        async materializeContinuationCheckpoint() {},
        async latestCheckpoint() {
          return undefined;
        },
        async replayState() {
          return {
            pairs: [],
            remainingKeys: [...remainingKeys],
            completedKeys: ["required-key-a", "required-key-b"].filter(
              (key) => !remainingKeys.includes(key),
            ),
            complete: remainingKeys.length === 0,
          };
        },
        async snapshotIndex() {
          return undefined;
        },
        async releaseAll() {},
        async finish() {
          throw new Error("The fixture intentionally stops before report assembly.");
        },
      } satisfies QualityAnswerRecordSessionV1;
      vi.spyOn(QualityValidatorHost.prototype, "createAnswerRecordSession").mockResolvedValue(
        session,
      );

      let evaluatorTurns = 0;
      const harness: AgentHarness = {
        qualityAnswerRecordRouteBindingSha256: () => "b".repeat(64),
        qualityAnswerRecordProviderId: () => "nvidia-api-catalog",
        async runStep(stepInput) {
          if (stepInput.step.id === "evaluate-document-quality") {
            evaluatorTurns += 1;
            calls.push({
              remaining: [...(stepInput.qualityAnswerRecordRemainingKeys ?? [])],
              replay: stepInput.qualityAnswerRecordReplay?.length ?? 0,
            });
            if (evaluatorTurns === 1) {
              const capability = stepInput.qualityAnswerRecords;
              if (!capability) throw new Error("The experimental CLI path did not admit records.");
              await capability.prepareBatch({
                batchId: "partial-first-turn",
                toolCalls: [
                  {
                    toolCallId: "first-record",
                    rawArguments: JSON.stringify({
                      type: "dimension",
                      key: "required-key-a",
                      record: { assessment: "met" },
                    }),
                  },
                ],
                authorizedToolCallIds: ["first-record"],
              });
              await capability.settle({
                batchId: "partial-first-turn",
                toolCallIds: ["first-record"],
                authorizedToolCallIds: ["first-record"],
                successfulToolCallIds: ["first-record"],
              });
              throw new InferenceStepError("Continue after one partial record.", "timeout", true);
            }
            throw new InferenceStepError("Stop after observing remaining keys.", "timeout", true);
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
            usage: {
              input: 10,
              output: 5,
              cacheRead: 0,
              cacheWrite: 0,
              total: 15,
              turns: 1,
            },
            tools: {
              totalCalls: 1,
              failedCalls: 0,
              byTool: [{ name: "read", calls: 1, failures: 0 }],
            },
          };
        },
      };

      const config: DocsFabConfig = {
        projectRoot: runtimeRoot,
        skillCrateDirectory: join(runtimeRoot, "skill-crate"),
        qualityDirectory: join(runtimeRoot, "quality"),
        qualityPackDirectory: join(runtimeRoot, "quality-pack"),
        stateDirectory,
        retryPolicy: {
          maxRetries: 1,
          maxTimeoutRetries: 1,
          baseDelayMs: 0,
          maxDelayMs: 0,
          retryableCategories: ["timeout"],
        },
        model: {
          ...validModelConfig,
          providerId: "nvidia-api-catalog",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          modelId: "nvidia/nemotron-3-super-120b-a12b",
          apiFormat: "chat_completions",
          apiKey: "fixture-only-no-network",
          profile: {
            ...validModelConfig.profile,
            compatibility: {
              ...validModelConfig.profile.compatibility,
              apiFormats: ["chat_completions"],
            },
          },
        },
      };
      const request = parseRunArguments([
        "review-documentation",
        "--repo",
        repositoryPath,
        "--revision",
        "HEAD",
        "--instruction",
        "Review docs/guide.md.",
        "--composition",
        "nvidia-nemotron-3-super-120b-a12b-pi",
        "--experimental-answer-records",
      ]);
      const record = (await withLocalWorkflowRun(
        request,
        config,
        {
          silent: true,
          output: { log: () => undefined, error: () => undefined },
          executionHarness: harness,
          requestInterpreter: {
            async call() {
              return {
                text: JSON.stringify({
                  operation: "review",
                  targets: [
                    {
                      path: "docs/guide.md",
                      role: "write",
                      chosenFrom: "named",
                      quote: "docs/guide.md",
                    },
                  ],
                  sources: [],
                  preserve: [],
                  exclusions: [],
                  constraints: [],
                  authorityPreference: {
                    preference: "unspecified",
                    quote: null,
                  },
                  questions: [],
                }),
                usage: { inputTokens: 3, outputTokens: 2 },
              };
            },
          },
        },
        async ({ execution }) => ({ value: execution.record }),
      )) as RunRecord | undefined;

      expect(request.experimentalAnswerRecords).toBe(true);
      if (evaluatorTurns !== 2) {
        throw new Error(
          `CLI discovery reached ${evaluatorTurns} evaluator turns: ${JSON.stringify({
            status: record?.status,
            error: record?.error,
            steps: record?.steps.map((step) => [
              step.skill,
              step.status,
              step.failure?.code,
              step.error,
            ]),
          })}`,
        );
      }
      expect(calls[0]?.remaining).toEqual(["required-key-a", "required-key-b"]);
      expect(calls[1]).toMatchObject({
        remaining: ["required-key-b"],
        replay: 0,
      });
      expect(record?.status).toBe("failed");
      expect(record?.answerRecordDiscovery).toMatchObject({
        qualification: "unqualified",
        statusLabel: "Experimental discovery — not qualified",
        runBinding: { runId: record?.id, workflow: "review-documentation" },
      });
      expect(record?.compositionExecution).toBeUndefined();

      const savedValue = JSON.parse(
        await readFile(defaultRunRecordPath(stateDirectory, record!.id), "utf8"),
      ) as Record<string, unknown>;
      expect(decodeSavedRunRecord(savedValue as never, record!.id).answerRecordDiscovery).toEqual(
        record!.answerRecordDiscovery,
      );
      const mismatchedBinding = structuredClone(savedValue) as Record<string, any>;
      mismatchedBinding.answerRecordDiscovery.runBinding.repositoryRevision = "f".repeat(40);
      const { evidenceSha256: _digest, ...discoveryBody } = mismatchedBinding.answerRecordDiscovery;
      mismatchedBinding.answerRecordDiscovery.evidenceSha256 = canonicalDigest(discoveryBody);
      expect(() => decodeSavedRunRecord(mismatchedBinding as never, record!.id)).toThrow(
        /experimental discovery evidence is invalid/u,
      );
      const mixedMode = structuredClone(savedValue) as Record<string, unknown>;
      mixedMode.compositionExecution = {};
      expect(() => decodeSavedRunRecord(mixedMode as never, record!.id)).toThrow(
        /invalid execution mode/u,
      );

      const legacyMarker = structuredClone(savedValue) as Record<string, any>;
      delete legacyMarker.answerRecordDiscovery.answerRecordRefusalPolicy;
      const { evidenceSha256: _legacyDigest, ...legacyBody } = legacyMarker.answerRecordDiscovery;
      legacyMarker.answerRecordDiscovery.evidenceSha256 = canonicalDigest(legacyBody);
      const legacyDecoded = decodeSavedRunRecord(legacyMarker as never, record!.id);
      expect(legacyDecoded.answerRecordDiscovery).not.toHaveProperty("answerRecordRefusalPolicy");

      await writeFile(
        defaultRunRecordPath(stateDirectory, record!.id),
        JSON.stringify(legacyMarker),
        "utf8",
      );
      const legacyContinuationRequest = parseRunArguments([
        "review-documentation",
        "--repo",
        repositoryPath,
        "--resume-from",
        record!.id,
        "--composition",
        "nvidia-nemotron-3-super-120b-a12b-pi",
        "--experimental-answer-records",
      ]);
      await expect(
        loadAnswerRecordContinuation(legacyContinuationRequest, {
          stateDirectory,
        } as DocsFabConfig),
      ).rejects.toThrow(
        /source-discovery-refusal-policy-mismatch.*start a fresh experimental answer-record review run/u,
      );
    },
    testTimeoutMs(limit("test.applicationExecutionTimeoutMs").value),
  );
});
