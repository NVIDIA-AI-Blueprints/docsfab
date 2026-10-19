// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { InferenceStepError, type HarnessStepInput } from "../src/execution/contracts.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import { PiHarness } from "../src/harness/pi.js";
import { createProviderConnectionFactory } from "../src/model/provider.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { LocalSourceObligationSourceObserver } from "../src/workflow-execution/source-obligation-observer.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import {
  canonicalSourceObligationProposal,
  validateSourceObligationProposal,
} from "../src/workflow-execution/source-obligation.js";
import { TECHNICAL_FACT_DIMENSIONS } from "../src/workflow-execution/review-response.js";
import { initFixtureRepo } from "./helpers/git.js";
import { verificationFixture } from "./helpers/verification.js";
import {
  fixtureCompositionExecutionProfile,
  resetSharedTestState,
  scriptedProvider,
  skillCrateDirectory,
  textTurn,
  toolTurn,
  testTimeoutMs,
  validModelConfig,
} from "./support/pi-harness-session-fixtures.js";

const roots: string[] = [];
afterEach(async () => {
  await resetSharedTestState();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class MemoryStore implements RunStore {
  readonly records: RunRecord[] = [];

  async save(record: RunRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}

describe("S2 source-obligation runner route", () => {
  it.each(["baseline", "provider-retry", "closure-retry", "runner-validation-retry"] as const)(
    "injects the gated capability and records the Pi-settled host proposal (%s)",
    {
      timeout: testTimeoutMs(30_000),
    },
    async (scenario) => {
      const root = await mkdtemp(join(tmpdir(), "docsfab-s2-runner-"));
      roots.push(root);
      const sourcePath = join(root, "source");
      const revision = await initFixtureRepo(sourcePath, {
        "README.md": "# Fixture title\n",
        "docs/guide.md": "# Guide\n\nA source-backed guide.\n",
        "src/api.ts": "export const value = 1;\n",
      });
      const workspace = await prepareRepositoryWorkspace(sourcePath, revision);
      const ordinaryResponses = [
        toolTurn([
          {
            id: "unknown-parent",
            name: "submit_answer_record",
            arguments: {
              type: "obligation",
              record: {
                sourceLocators: ["docs/guide.md:1-1"],
                statement: "An obligation with no admitted dimension parent.",
                evidenceClass: "source-observation",
                uncertainty: "The source may be stale.",
                dimensionKey: TECHNICAL_FACT_DIMENSIONS[1],
              },
            },
          },
        ]),
        toolTurn(
          TECHNICAL_FACT_DIMENSIONS.map((dimension, index) => ({
            id: `dimension-${index}`,
            name: "submit_answer_record",
            arguments: {
              type: "dimension",
              key: dimension,
              record: {
                status: index === 0 ? "applicable" : "unverified",
                reason:
                  index === 0
                    ? "A source obligation is pending."
                    : "The available source does not establish this fact.",
                sourceLocators: [],
                obligations: [],
              },
            },
          })),
        ),
        toolTurn([
          {
            id: "accepted-obligation",
            name: "submit_answer_record",
            arguments: {
              type: "obligation",
              record: {
                sourceLocators: ["docs/guide.md:1-1"],
                statement: "The guide has the heading Guide.",
                evidenceClass: "source-observation",
                uncertainty: "The heading may change.",
                dimensionKey: TECHNICAL_FACT_DIMENSIONS[0],
              },
            },
          },
        ]),
        toolTurn([
          {
            id: "close-source-obligations",
            name: "submit_answer_record",
            arguments: {
              type: "proposal-note",
              record: {
                limitations: ["The available source does not establish this fact."],
                closed: true,
              },
            },
          },
        ]),
        textTurn("The host assembled the source-obligation ledger."),
      ];
      const closureRetryResponses = [
        toolTurn(
          TECHNICAL_FACT_DIMENSIONS.map((dimension, index) => ({
            id: `dimension-${index}`,
            name: "submit_answer_record",
            arguments: {
              type: "dimension",
              key: dimension,
              record: {
                status: index === 0 ? "applicable" : "unverified",
                reason:
                  index === 0
                    ? "A source obligation is pending."
                    : "The available source does not establish this fact.",
                sourceLocators: [],
                obligations: [],
              },
            },
          })),
        ),
        toolTurn([
          {
            id: "premature-close",
            name: "submit_answer_record",
            arguments: {
              type: "proposal-note",
              record: { limitations: [], closed: true },
            },
          },
        ]),
        textTurn("The host assembled an incomplete source-obligation proposal."),
        toolTurn([
          {
            id: "corrected-obligation",
            name: "submit_answer_record",
            arguments: {
              type: "obligation",
              record: {
                sourceLocators: ["docs/guide.md:1-1"],
                statement: "The guide has the heading Guide.",
                evidenceClass: "source-observation",
                uncertainty: "The heading may change.",
                dimensionKey: TECHNICAL_FACT_DIMENSIONS[0],
              },
            },
          },
        ]),
        toolTurn([
          {
            id: "corrected-close",
            name: "submit_answer_record",
            arguments: {
              type: "proposal-note",
              record: {
                limitations: ["The available source does not establish this fact."],
                closed: true,
              },
            },
          },
        ]),
        textTurn("The host assembled the corrected source-obligation ledger."),
      ];
      const runnerValidationRetryResponses = [
        toolTurn(
          TECHNICAL_FACT_DIMENSIONS.map((dimension, index) => ({
            id: `initial-dimension-${index}`,
            name: "submit_answer_record",
            arguments: {
              type: "dimension",
              key: dimension,
              record: {
                status: "not-applicable",
                reason: "The bounded source does not establish an applicable obligation.",
                sourceLocators: ["docs/guide.md:1-1"],
                obligations: [],
              },
            },
          })),
        ),
        toolTurn([
          {
            id: "initial-close",
            name: "submit_answer_record",
            arguments: {
              type: "proposal-note",
              record: { limitations: [], closed: true },
            },
          },
        ]),
        textTurn("The harness returned a proposal for runner validation."),
        toolTurn(
          TECHNICAL_FACT_DIMENSIONS.map((dimension, index) => ({
            id: `corrected-dimension-${index}`,
            name: "submit_answer_record",
            arguments: {
              type: "dimension",
              key: dimension,
              record: {
                status: index === 0 ? "applicable" : "unverified",
                reason:
                  index === 0
                    ? "A source obligation is pending."
                    : "The available source does not establish this fact.",
                sourceLocators: [],
                obligations: [],
              },
            },
          })),
        ),
        toolTurn([
          {
            id: "corrected-obligation",
            name: "submit_answer_record",
            arguments: {
              type: "obligation",
              record: {
                sourceLocators: ["docs/guide.md:1-1"],
                statement: "The guide has the heading Guide.",
                evidenceClass: "source-observation",
                uncertainty: "The heading may change.",
                dimensionKey: TECHNICAL_FACT_DIMENSIONS[0],
              },
            },
          },
        ]),
        toolTurn([
          {
            id: "corrected-close",
            name: "submit_answer_record",
            arguments: {
              type: "proposal-note",
              record: {
                limitations: ["The available source does not establish this fact."],
                closed: true,
              },
            },
          },
        ]),
        textTurn("The host assembled the corrected source-obligation ledger."),
      ];
      const provider = vi.fn(
        scriptedProvider(
          scenario === "closure-retry"
            ? closureRetryResponses
            : scenario === "runner-validation-retry"
              ? runnerValidationRetryResponses
              : ordinaryResponses,
        ),
      );
      const profile = fixtureCompositionExecutionProfile({
        maxProviderTurns: 6,
        timeoutMs: 30_000,
        maxResponseBytes: 65_536,
      });
      const pi = new PiHarness({
        skillCrateDirectory,
        executionProfile: profile,
        credential: { family: "nvidia-inference-api", apiKey: validModelConfig.apiKey },
        providerConnectionFactory: createProviderConnectionFactory({
          routeId: profile.routeId,
          transport: profile.transport,
          fetch: provider,
        }),
      });
      const store = new MemoryStore();
      const routeHarness = {
        sourceStepInput: undefined as HarnessStepInput | undefined,
        sourceStepResult: undefined as Awaited<ReturnType<PiHarness["runStep"]>> | undefined,
        sourceStepCalls: 0,
        async runStep(input: HarnessStepInput) {
          if (input.step.id === "derive-source-obligations") {
            this.sourceStepCalls += 1;
            this.sourceStepInput = input;
            expect(input.sourceObligationAnswerRecords).toBeDefined();
            expect(input.sourceObligationAnswerRecordCallCeiling).toBeGreaterThan(0);
            if (scenario === "provider-retry" && this.sourceStepCalls === 1) {
              const ids = TECHNICAL_FACT_DIMENSIONS.map((dimension, index) => `retained-${index}`);
              await input.sourceObligationAnswerRecords!.prepareBatch({
                batchId: "retained-valid-dimensions",
                toolCalls: TECHNICAL_FACT_DIMENSIONS.map((dimension, index) => ({
                  toolCallId: ids[index]!,
                  rawArguments: JSON.stringify({
                    type: "dimension",
                    key: dimension,
                    record: {
                      status: index === 0 ? "applicable" : "unverified",
                      reason:
                        index === 0
                          ? "A source obligation is pending."
                          : "The available source does not establish this fact.",
                      sourceLocators: [],
                      obligations: [],
                    },
                  }),
                })),
                authorizedToolCallIds: ids,
              });
              await input.sourceObligationAnswerRecords!.settle({
                batchId: "retained-valid-dimensions",
                toolCallIds: ids,
                authorizedToolCallIds: ids,
                successfulToolCallIds: ids,
                failedToolCallIds: [],
              });
              throw new InferenceStepError(
                "Injected retry after valid answer records were admitted.",
                "provider-transient",
                true,
              );
            }
            if (scenario !== "baseline" && this.sourceStepCalls > 1) {
              expect(input.sourceObligationAnswerRecordGuidance).toContain(
                "Already admitted and retained: dimension:",
              );
            }
            const result = await pi.runStep(input);
            if (scenario === "runner-validation-retry" && this.sourceStepCalls === 1) {
              const proposal = structuredClone(result.sourceObligationProposal!);
              proposal.dimensions[0] = {
                ...proposal.dimensions[0]!,
                status: "applicable",
                reason: "A source obligation is pending.",
                sourceLocators: [],
                obligations: [],
              };
              const rejected = {
                ...result,
                sourceObligationProposal: proposal,
                summary: canonicalSourceObligationProposal(proposal),
              };
              this.sourceStepResult = rejected;
              return rejected;
            }
            this.sourceStepResult = result;
            return result;
          }
          return {
            summary: `ran ${input.step.id}`,
            ...(await verificationFixture(input)),
          };
        },
      };
      const runner = new WorkflowRunner({
        harness: routeHarness,
        hostOperations: {
          runStep: async (input) => ({ summary: `ran host operation ${input.step.id}` }),
        },
        store,
        repositoryScanner: {
          scan: async () => ({
            ruleSet: "s2-runner-fixture",
            status: "passed" as const,
            scannedFiles: 3,
            binaryFiles: 0,
            findings: [],
          }),
        },
        contextPreflight: {
          preflight: async () => ({
            status: "unnecessary" as const,
            reason: "target-not-applicable" as const,
          }),
        },
        workflowSearch: new LocalWorkflowSearchCoordinator({ workspace }),
        sourceObligationObserver: new LocalSourceObligationSourceObserver(workspace),
        sourceObligationAnswerRecordRouteEnabled: true,
        ...(scenario !== "baseline"
          ? {
              retryPolicy: {
                maxRetries: 1,
                baseDelayMs: 0,
                maxDelayMs: 0,
                retryableCategories: ["provider-transient" as const, "malformed-response" as const],
              },
              retrySleep: async () => {},
            }
          : {}),
        id: () => "s2-runner-route",
      });

      try {
        const record = await runner.run({
          workflow: "review-documentation",
          workspacePath: workspace.path,
          repository: { sourcePath, requestedRevision: revision, revision },
          contextTarget: { sourcePath: "docs/guide.md" },
          allowWrite: false,
        });
        const sourceStepResult = routeHarness.sourceStepResult;
        const runnerInput = routeHarness.sourceStepInput;
        expect(
          sourceStepResult,
          JSON.stringify({
            error: record.error,
            steps: record.steps.map(({ id, status, error, inference }) => ({
              id,
              status,
              error,
              attempts: inference?.attempts.map(
                ({ attempt, outcome, retryable, retryDecision, retryScheduled }) => ({
                  attempt,
                  outcome,
                  retryable,
                  retryDecision,
                  retryScheduled,
                }),
              ),
            })),
          }),
        ).toBeDefined();
        expect(runnerInput).toBeDefined();
        expect(sourceStepResult!.sourceObligationProposal).toBeDefined();
        const independentlyValidated = validateSourceObligationProposal(
          sourceStepResult!.sourceObligationProposal,
          runnerInput!,
        );
        expect(sourceStepResult!.summary).toBe(
          canonicalSourceObligationProposal(independentlyValidated),
        );
        const derive = record.steps.find((step) => step.id === "derive-source-obligations");
        if (scenario === "closure-retry" || scenario === "runner-validation-retry") {
          expect(derive?.inference?.attempts).toMatchObject([
            expect.objectContaining({
              outcome: "malformed-response",
              retryable: true,
              retryScheduled: true,
            }),
            expect.objectContaining({ outcome: "succeeded" }),
          ]);
        }
        const stepStates = record.steps.map(({ id, status, error }) => ({ id, status, error }));
        expect(record.status, JSON.stringify({ error: record.error, stepStates })).toBe("failed");
        expect(derive?.status).toBe("succeeded");
        const proposal = JSON.parse(derive!.summary!) as {
          schemaVersion: number;
          identity: { sources: Array<{ path: string }> };
          completeness: string;
          dimensions: Array<{
            dimension: string;
            obligations: Array<{ id: string; statement: string; sourceLocators: string[] }>;
          }>;
        };
        expect(proposal.schemaVersion).toBe(2);
        expect(proposal.completeness).toBe("bounded-not-proven");
        expect(proposal.dimensions[0]?.obligations).toEqual([
          expect.objectContaining({
            id: `OBL-${TECHNICAL_FACT_DIMENSIONS[0]!.toUpperCase()}-1`,
            statement: "The guide has the heading Guide.",
            sourceLocators: ["docs/guide.md:1-1"],
          }),
        ]);
        const sealedIds = proposal.dimensions.flatMap((dimension) =>
          dimension.obligations.map(({ id }) => id),
        );
        expect(new Set(sealedIds).size).toBe(sealedIds.length);
        expect(sealedIds).toEqual([`OBL-${TECHNICAL_FACT_DIMENSIONS[0]!.toUpperCase()}-1`]);
        expect(proposal.identity.sources.map(({ path }) => path)).toContain("docs/guide.md");
        expect(derive?.originalSourceAuthority?.members.map(({ path }) => path)).toContain(
          "docs/guide.md",
        );
        expect(
          record.steps.find((step) => step.id === "provisional-technical-verification")?.status,
        ).toBe("succeeded");
        expect(record.steps.find((step) => step.id === "verify-technical-accuracy")?.status).toBe(
          "failed",
        );
        expect(record.error).toContain("invalid-accounting");
        expect(derive?.summary).not.toContain("An obligation with no admitted dimension parent.");
        expect(routeHarness.sourceStepCalls).toBe(scenario === "baseline" ? 1 : 2);
        expect(provider).toHaveBeenCalledTimes(
          scenario === "closure-retry" ? 6 : scenario === "runner-validation-retry" ? 7 : 5,
        );
      } finally {
        await workspace.dispose();
      }
    },
  );
});
