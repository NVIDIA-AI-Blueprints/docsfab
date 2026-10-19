// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseRetryPolicy } from "../src/config/retry-policy.js";
import { RETRY_RULES } from "../src/contracts/model-output.generated.js";
import { PI_CONCLUDE_NOW_PROMPT } from "../src/harness/pi-session.js";
import { classifyInferenceAttempt } from "../src/operator/failure-classification.js";
import { decodeInference } from "../src/scorecard-record-decode.js";
import {
  boundStyleContext,
  type HarnessStepInput,
  PiHarness,
  type SourceObligationLedgerProposalV1,
  TECHNICAL_FACT_DIMENSIONS,
  canonicalDigest,
  createProviderConnectionFactory,
  createRepository,
  executeInferenceStep,
  fixtureCompositionExecutionProfile,
  projectRoot,
  resetSharedTestState,
  reviewSourcePhaseInput,
  skillCrateDirectory,
  stepInput,
  textTurn,
  toolTurn,
  validModelConfig,
  verificationResultFixture,
  verifyQualityPackContext,
} from "./support/pi-harness-session-fixtures.js";

/** Run admission resolves the bound style profile once; every harness here reads it. */
const styleContext = await boundStyleContext();

afterEach(resetSharedTestState);

/**
 * A step attempt that spends its whole tool-call ceiling without answering
 * ends there as a coded no-progress stop, and the step correction policy
 * retries it the way it retries a read loop: the retry withdraws the tools at
 * its first withheld re-read and asks for the answer. The cases follow two
 * recorded runs that reached 126 of 126 calls on attempt 1 and then succeeded:
 * a quality evaluation (ad6fab22) and a source-obligation derivation
 * (48ef1a5c).
 *
 * Cases drive `executeInferenceStep` over the real Pi session with a scripted
 * provider. The ceiling is reached by shrinking the sealed provider-turn
 * budget, which fits the tool-call ceiling to it.
 */
describe("PiHarness recovery from the hard tool-call ceiling", () => {
  // `resolveLeaseShapeForTurns` fits one lease at this budget, so one batch of
  // `maxProviderTurns - 1` calls reaches the ceiling.
  const MAX_PROVIDER_TURNS = 8;
  const CEILING = MAX_PROVIDER_TURNS - 1;
  const CEILING_CODE = "composition-execution-max-tool-calls-per-step-bound";

  interface DelegatedRequest {
    messages: Array<{ role?: string; content?: unknown }>;
  }

  function recordProvider(responses: readonly Response[]): DelegatedRequest[] {
    const delegated: DelegatedRequest[] = [];
    let index = 0;
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      delegated.push(JSON.parse(String(init?.body ?? "{}")) as DelegatedRequest);
      const response = responses[index];
      index += 1;
      if (!response) throw new Error("Unexpected provider request.");
      return response.clone();
    });
    return delegated;
  }

  function text(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((part) => (part as { text?: string }).text ?? "").join("\n");
    }
    return "";
  }

  function userTexts(request: DelegatedRequest): string {
    return request.messages
      .filter((message) => message.role === "user")
      .map((message) => text(message.content))
      .join("\n");
  }

  /** One batch of distinct calls that brings executed calls to the ceiling. */
  function ceilingTurn(prefix: string): Response {
    return toolTurn(
      Array.from({ length: CEILING }, (_, offset) => ({
        id: `${prefix}-${offset}`,
        name: "ls",
        arguments: { path: offset === 0 ? "." : `./${String(offset)}` },
      })),
    );
  }

  function harness(environment: Record<string, string> = {}): PiHarness {
    const executionProfile = fixtureCompositionExecutionProfile({
      maxProviderTurns: MAX_PROVIDER_TURNS,
      timeoutMs: 30_000,
    });
    return new PiHarness({
      skillCrateDirectory,
      executionProfile,
      qualityDirectory: resolve(projectRoot, "quality"),
      styleContext,
      limits: { environment, hostFile: null, projectFile: null },
      credential: { family: "nvidia-inference-api", apiKey: validModelConfig.apiKey },
      providerConnectionFactory: createProviderConnectionFactory({
        routeId: executionProfile.routeId,
        transport: executionProfile.transport,
      }),
    });
  }

  function run(subject: PiHarness, input: HarnessStepInput) {
    return executeInferenceStep({
      mode: input.step.mode,
      policy: parseRetryPolicy({}),
      evidenceIdentity: input.evidenceIdentity,
      sleep: async () => {},
      execute: (attempt, responseCorrection) =>
        subject.runStep({
          ...input,
          inferenceAttempt: attempt,
          retriesConsumed: attempt - 1,
          ...(responseCorrection ? { responseCorrection } : {}),
        }),
    });
  }

  type Execution = Awaited<ReturnType<typeof run>>;

  /** The truthful record of the attempt that reached the ceiling. */
  function expectCodedCeilingStop(execution: Execution): void {
    const stopped = execution.evidence.attempts[0]!;
    expect(stopped).toMatchObject({
      outcome: "no-progress",
      condition: "tool-call-ceiling",
      retryable: true,
      retryScheduled: true,
      retryDecision: "retried",
      retryRule: "retried-tool-call-ceiling",
    });
    expect(stopped.turns?.at(-1)?.decision).not.toBe("stop");
    expect(stopped.executionLease).toMatchObject({
      terminalReason: "hard-tool-call-ceiling",
      terminalDisposition: "budget-stopped",
      toolCalls: { executed: CEILING },
    });
    expect(classifyInferenceAttempt(stopped)).toEqual({
      class: "bound",
      layer: "inference",
      code: CEILING_CODE,
    });
    // Every record decoder admits the sequence as written.
    expect(
      decodeInference(structuredClone(execution.evidence)).attempts.map(
        (attempt) => attempt.outcome,
      ),
    ).toEqual(["no-progress", "succeeded"]);
  }

  it("retries a source-obligation derivation that reached the ceiling, and the retry answers (48ef1a5c)", async () => {
    const repositoryPath = await createRepository();
    const input = {
      ...reviewSourcePhaseInput(repositoryPath, "derive-source-obligations"),
      reviewScope: undefined,
      contextTarget: { sourcePath: "README.md" },
    } as HarnessStepInput;
    const proposal = {
      completeness: "bounded-not-proven",
      dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) => ({
        dimension,
        status: "not-applicable" as const,
        reason: `The focused source establishes no ${dimension} obligation.`,
        sourceLocators: ["README.md:1"],
        obligations: [],
      })),
      limitations: [],
    } as unknown as SourceObligationLedgerProposalV1;
    const delegated = recordProvider([
      ceilingTurn("derive"),
      // Attempt 2 answers at once, with no tool call, as 48ef1a5c's did.
      textTurn(JSON.stringify(proposal)),
    ]);

    const execution = await run(harness(), input);

    // No provider turn is spent after the ceiling: the step would refuse it.
    expect(delegated).toHaveLength(2);
    expect(execution.status).toBe("succeeded");
    expectCodedCeilingStop(execution);
    expect(userTexts(delegated[1]!)).toContain(RETRY_RULES["retried-tool-call-ceiling"].statement!);
    expect(execution.evidence.attempts[1]).toMatchObject({
      outcome: "succeeded",
      tools: { totalCalls: 0 },
    });
  }, 120_000);

  it("retries a quality evaluation that reached the ceiling, and the conclude-now ask gets its answer (ad6fab22)", async () => {
    const repositoryPath = await createRepository();
    const pack = await verifyQualityPackContext({
      skillCrateDirectory,
      qualityDirectory: resolve(projectRoot, "quality"),
      qualityPackDirectory: resolve(projectRoot, "quality-pack"),
    });
    const base = stepInput(repositoryPath);
    const technicalVerification = verificationResultFixture(["README.md"]);
    const profileAssetPath = "profiles/docsfab-documentation-quality/profile.json";
    const input: HarnessStepInput = {
      ...base,
      step: base.workflow.steps.find((step) => step.skill === "evaluate-document-quality")!,
      evidenceIdentity: {
        ...base.evidenceIdentity!,
        technicalVerificationSha256: canonicalDigest(technicalVerification),
      },
      technicalVerification,
      reviewScope: {
        scope: "focused-set",
        reason: "operator-named",
        targetPaths: ["README.md"],
        deferredPaths: [],
        scopeSha256: "c".repeat(64),
        corpusFileCount: 1,
      },
      qualityProfileSelection: {
        skillLockSha256: pack.evidence.skillLockSha256,
        qualityLockSha256: pack.evidence.qualityLockSha256,
        qualityBundleSha256: pack.evidence.qualityBundleSha256,
        profileAssetPath,
        profilePayloadSha256: pack.qualityLock.files.find((file) => file.path === profileAssetPath)!
          .sha256,
        profileId: "docsfab-documentation-quality",
        profileVersion: "v0.1",
        profileModel: "documentation-quality-model-v0.2",
        repositoryRevision: base.evidenceIdentity!.repositoryRevision,
        selectionSha256: "b".repeat(64),
      } as NonNullable<HarnessStepInput["qualityProfileSelection"]>,
    };
    const read = (id: string) => toolTurn([{ id, name: "read", arguments: { path: "README.md" } }]);
    const delegated = recordProvider([
      ceilingTurn("quality"),
      // Attempt 2 reads the page, re-reads it once in full, and its next
      // unchanged re-read is withheld; the host then asks for the answer.
      read("quality-read-1"),
      read("quality-read-2"),
      read("quality-read-3"),
      textTurn(
        JSON.stringify({
          evaluation: { model_version: input.qualityProfileSelection!.profileModel },
          qualityScore: null,
          reportMarkdown: "# Candidate report; not host validated",
        }),
      ),
    ]);

    const execution = await run(harness({ DOCSFAB_EXECUTION_READ_LOOP_REPEAT_STREAK: "1" }), input);

    expect(delegated).toHaveLength(5);
    expect(execution.status).toBe("succeeded");
    expectCodedCeilingStop(execution);
    expect(userTexts(delegated[1]!)).toContain(RETRY_RULES["retried-tool-call-ceiling"].statement!);
    // The retry's first withheld re-read withdrew the tools and asked.
    expect(text(delegated[4]!.messages.at(-1)?.content)).toBe(PI_CONCLUDE_NOW_PROMPT);
    expect(execution.evidence.attempts[1]).toMatchObject({
      outcome: "succeeded",
      concludeNow: { trigger: "read-loop", turn: 3 },
    });
  }, 120_000);

  it("stops the step when the retry reaches the ceiling again, spending the no-progress budget once", async () => {
    const repositoryPath = await createRepository();
    const input = {
      ...reviewSourcePhaseInput(repositoryPath, "derive-source-obligations"),
      reviewScope: undefined,
      contextTarget: { sourcePath: "README.md" },
    } as HarnessStepInput;
    const delegated = recordProvider([ceilingTurn("first"), ceilingTurn("second")]);

    const execution = await run(harness(), input);

    expect(delegated).toHaveLength(2);
    expect(execution.status).toBe("failed");
    expect(execution.evidence.attempts.map((attempt) => attempt.retryRule)).toEqual([
      "retried-tool-call-ceiling",
      "exhausted-no-progress-budget",
    ]);
    expect(execution.evidence.attempts[1]).toMatchObject({
      outcome: "no-progress",
      condition: "tool-call-ceiling",
      executionLease: { terminalReason: "hard-tool-call-ceiling" },
    });
    if (execution.status !== "failed") throw new Error("expected a failed step");
    expect(execution.error.message).toContain(`${CEILING_CODE}: workflow step "${input.step.id}"`);
    expect(decodeInference(structuredClone(execution.evidence)).attempts).toHaveLength(2);
  }, 120_000);
});
