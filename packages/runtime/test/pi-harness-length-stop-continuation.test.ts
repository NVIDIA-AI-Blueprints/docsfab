// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { InferenceStepError } from "../src/execution/contracts.js";
import { markStitchedReplyRefusal } from "../src/harness/length-stop-continuation.js";
import { projectRunIndexRows } from "../src/records/run-index.js";
import { expectNoToolHistoryWithoutTools } from "./helpers/provider-request-shape.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { recordedReviewJudgmentFixture } from "./helpers/recorded-review-judgment.js";
import {
  HarnessStepInput,
  PiHarness,
  SourceObligationLedgerProposalV1,
  TECHNICAL_FACT_DIMENSIONS,
  bindSourceObligationLedgerV2,
  blankTurn,
  boundStyleContext,
  captureInferenceFailure,
  createAuditHarness,
  createInstantReplayAuditHarness,
  createProviderConnectionFactory,
  createRepository,
  createReviewHarness,
  editorialTechnicalStepInput,
  issueOriginalSourceAuthorityAdmission,
  limitDefinition,
  fixtureCompositionExecutionProfile,
  qualityDirectory,
  resetSharedTestState,
  reviewSourcePhaseInput,
  scriptedProvider,
  sealOriginalSourceAuthority,
  skillCrateDirectory,
  sourceObligationScopeSha256,
  sseResponse,
  stepInput,
  textTurn,
  toolTurn,
  validModelConfig,
} from "./support/pi-harness-session-fixtures.js";

afterEach(resetSharedTestState);

/**
 * A structured judgment answer can exceed the output limit, and prompt-side
 * compaction cannot shrink the answer itself. These drive the real Pi session
 * against a terminal turn stopped at the output limit with partial text (the
 * `text-truncated` shape), then the continuation the host asks for.
 */
describe("PiHarness bounded continuation of a structured answer cut at the output limit", () => {
  const outputLimit = validModelConfig.profile.maxOutputTokens.toLocaleString("en-US");
  const issue = {
    id: "TECH-001",
    severity: "major",
    category: "technical_accuracy",
    location: "README.md:12",
  } as const;
  const coverage = [
    {
      reason: "Compared the documented command with the option parser.",
      evidence: ["src/cli.ts:42"],
      status: "verified",
      path: "README.md",
    },
  ] as const;
  const SOURCE_SHA256 = "f".repeat(64);
  const APPLICABLE_DIMENSION = "input-representations";
  // Enough governed provider turns for three scripted turns, and an attempt
  // deadline no scripted turn can reach.
  const COMPOSITION_FIXTURE_MAX_PROVIDER_TURNS = 4;
  const COMPOSITION_FIXTURE_TIMEOUT_MS = 30_000;
  // Long enough that two retained halves exceed one whole SSE response body
  // (the assistant text plus its chunk framing).
  const CUT_FILLER_CHARS = 2_048;
  // `resolveLeaseShapeForTurns` derives the hard tool-call ceiling as
  // `maxProviderTurns - maxLeases`; at this budget it picks one lease, so one
  // batch of `maxProviderTurns - 1` calls reaches the ceiling.
  const CEILING_FIXTURE_MAX_PROVIDER_TURNS = 8;
  const CEILING_FIXTURE_TOOL_CALLS = CEILING_FIXTURE_MAX_PROVIDER_TURNS - 1;

  /** The sealed V2 ledger and authority a step-4 or step-5 judgment binds. */
  async function sealedReviewFixture(repositoryPath: string) {
    const deriveInput = reviewSourcePhaseInput(repositoryPath, "derive-source-obligations");
    const proposal: SourceObligationLedgerProposalV1 = {
      completeness: "bounded-not-proven",
      dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) =>
        dimension === APPLICABLE_DIMENSION
          ? {
              dimension,
              status: "applicable" as const,
              reason: "The focused source establishes one input obligation.",
              sourceLocators: [],
              obligations: [
                {
                  dimension,
                  sourceLocators: ["README.md:1"],
                  statement: "The command input requires a flag defined by the option parser.",
                  evidenceClass: "source-observation" as const,
                  uncertainty: "The focused source fixture defines the required flag.",
                },
              ],
            }
          : {
              dimension,
              status: "not-applicable" as const,
              reason: `The focused source establishes no ${dimension} obligation.`,
              sourceLocators: ["README.md:1"],
              obligations: [],
            },
      ),
      limitations: [],
    };
    const scopeSha256 = sourceObligationScopeSha256(deriveInput);
    const sealed = sealOriginalSourceAuthority({
      runId: deriveInput.runId!,
      scope: "review-tracked-workspace",
      repositoryRevision: deriveInput.evidenceIdentity!.repositoryRevision,
      scopeSha256,
      workspaceSnapshotSha256: deriveInput.searchEvidence!.workspaceSnapshotSha256,
      members: [
        {
          path: "README.md",
          mode: 0o644,
          byteLength: 10,
          sourceSha256: SOURCE_SHA256,
        },
      ],
    });
    const ledger = bindSourceObligationLedgerV2(
      proposal,
      deriveInput,
      [{ path: "README.md", sha256: SOURCE_SHA256 }],
      sealed.evidence,
    );
    const obligationId = ledger.dimensions.find(
      (dimension) => dimension.dimension === APPLICABLE_DIMENSION,
    )!.obligations[0]!.id;
    const admission = issueOriginalSourceAuthorityAdmission({
      capture: sealed.capture,
      observer: {
        observe: async (paths) => paths.map((path) => ({ path, sha256: SOURCE_SHA256 })),
      },
      runId: deriveInput.runId!,
      repositoryRevision: deriveInput.evidenceIdentity!.repositoryRevision,
      scopeSha256,
      workspaceSnapshotSha256: deriveInput.searchEvidence!.workspaceSnapshotSha256,
    });
    return { deriveInput, ledger, obligationId, admission };
  }

  /** The judgment answer both step 4 and step 5 return over that ledger. */
  function judgmentReply(obligationId: string): string {
    return JSON.stringify({
      verdict: "needs-revision",
      coverage,
      issueJudgments: [{ ...issue, obligationIds: [obligationId] }],
      obligationJudgments: [
        {
          obligationId,
          disposition: "retained",
          documentationDisposition: "omitted",
          issueIds: [issue.id],
        },
      ],
    });
  }

  /** Step 4 input: the provisional judgment contract over a sealed V2 ledger. */
  async function provisionalInput(repositoryPath: string): Promise<{
    input: HarnessStepInput;
    obligationId: string;
  }> {
    const { deriveInput, ledger, obligationId } = await sealedReviewFixture(repositoryPath);
    return {
      input: {
        ...reviewSourcePhaseInput(repositoryPath, "provisional-technical-verification"),
        runId: deriveInput.runId,
        sourceObligationLedger: ledger,
      },
      obligationId,
    };
  }

  /** Step 5 input: the V3 technical-correction judgment over the same ledger. */
  async function correctionInput(repositoryPath: string): Promise<{
    input: HarnessStepInput;
    obligationId: string;
  }> {
    const { deriveInput, ledger, obligationId, admission } =
      await sealedReviewFixture(repositoryPath);
    return {
      input: {
        ...reviewSourcePhaseInput(repositoryPath, "verify-technical-accuracy"),
        runId: deriveInput.runId,
        sourceObligationLedger: ledger,
        originalSourceAuthorityAdmission: admission,
      },
      obligationId,
    };
  }

  function cutAt(answer: string, retainedChars: number) {
    return {
      head: answer.slice(0, retainedChars),
      tail: answer.slice(retainedChars),
    };
  }

  function lastUserText(request: { messages?: Array<{ content?: unknown }> }): string {
    const content = request.messages?.at(-1)?.content;
    if (Array.isArray(content)) {
      return content.map((part) => (part as { text?: string }).text ?? "").join("");
    }
    return typeof content === "string" ? content : "";
  }

  function assistantTexts(request: {
    messages?: Array<{ role?: unknown; content?: unknown }>;
  }): string[] {
    return (request.messages ?? [])
      .filter((message) => message.role === "assistant")
      .map((message) =>
        Array.isArray(message.content)
          ? message.content.map((part) => (part as { text?: string }).text ?? "").join("")
          : typeof message.content === "string"
            ? message.content
            : "",
      );
  }

  /**
   * A turn whose whole output budget went to reasoning: `reasoning_content`
   * deltas only, cut at the output limit. `assistantTurnFailure` classifies it
   * `text-truncated` through its thinking fallback, and the retained answer
   * prefix is empty.
   */
  function thinkingOnlyCutTurn(reasoning: string): Response {
    return sseResponse([
      {
        id: "completion-thinking-cut-turn",
        object: "chat.completion.chunk",
        created: 1,
        model: validModelConfig.modelId,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", reasoning_content: reasoning },
            finish_reason: null,
          },
        ],
      },
      {
        id: "completion-thinking-cut-turn",
        object: "chat.completion.chunk",
        created: 1,
        model: validModelConfig.modelId,
        choices: [{ index: 0, delta: {}, finish_reason: "length" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ]);
  }

  /**
   * A reasoning turn cut at the output limit whose last chunk also carries the
   * whole reasoning again as `content`, as a hosted NVIDIA NIM reasoning parser
   * sends it when the cut lands before reasoning ends. Shape sanitized from a
   * captured `nvidia/nemotron-3-super-120b-a12b` stream.
   */
  function reasoningEchoCutTurn(reasoning: readonly [string, string]): Response {
    const chunk = (delta: Record<string, unknown>, finishReason: string | null) => ({
      id: "completion-reasoning-echo-cut-turn",
      object: "chat.completion.chunk",
      created: 1,
      model: validModelConfig.modelId,
      choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: finishReason }],
    });
    return sseResponse([
      chunk({ reasoning_content: reasoning[0] }, null),
      chunk({ content: reasoning.join(""), reasoning_content: reasoning[1] }, "length"),
      {
        ...chunk({}, null),
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ]);
  }

  function recordingProvider(responses: readonly Response[]) {
    const requests: Array<{
      messages?: Array<{ role?: unknown; content?: unknown; tool_calls?: unknown }>;
      tools?: unknown;
    }> = [];
    const provider = scriptedProvider(responses);
    const fetchMock = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return provider(request, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    return { requests, fetchMock };
  }

  it("continues a cut provisional verification answer and admits the completed judgment", async () => {
    const repositoryPath = await createRepository();
    const { input, obligationId } = await provisionalInput(repositoryPath);
    const answer = judgmentReply(obligationId);
    const { head, tail } = cutAt(answer, Math.floor(answer.length / 2));
    const { requests, fetchMock } = recordingProvider([
      textTurn(head, validModelConfig.modelId, "length"),
      textTurn(tail),
    ]);

    const result = await (await createAuditHarness()).runStep(input);

    expect(result.verificationResult?.review.verdict).toBe("needs-revision");
    expect(result.verificationResult?.review.issues.map(({ id }) => id)).toEqual([issue.id]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The continuation is asked for inside the same session: the second request
    // carries the retained partial answer plus the host's continuation ask.
    expect(assistantTexts(requests[1]!)).toEqual([head]);
    expect(lastUserText(requests[1]!)).toContain(
      `Your previous message was cut off at the output limit of ${outputLimit} tokens (finish_reason=length)`,
    );
    expect(lastUserText(requests[1]!)).toContain("Emit only the remaining characters.");
    expect(result.turns).toHaveLength(2);
    expect(result.turns?.filter((turn) => turn.rawStopReason === "length")).toHaveLength(1);
    expect(result.turns?.at(-1)?.rawStopReason).toBe("stop");
    expect(result.executionLease).toMatchObject({
      providerTurns: 2,
      terminalReason: "completed",
    });
    // The admitted answer's size is the whole stitched span, not the last turn.
    expect(result.answerBytes).toBe(Buffer.byteLength(answer, "utf8"));
  });

  it("projects the continued answer onto its run index row as one continuation", async () => {
    const repositoryPath = await createRepository();
    const { input, obligationId } = await provisionalInput(repositoryPath);
    const answer = judgmentReply(obligationId);
    const { head, tail } = cutAt(answer, Math.floor(answer.length / 2));
    recordingProvider([textTurn(head, validModelConfig.modelId, "length"), textTurn(tail)]);

    const result = await (await createAuditHarness()).runStep(input);

    // The continuation issued no tool call, so the ledger's count stays level.
    expect(result.turns![1]!.toolCalls).toBe(result.turns![0]!.toolCalls);
    const projection = projectRunIndexRows(
      {
        schemaVersion: 2,
        id: "run-continued",
        workflow: "review-documentation",
        status: "succeeded",
        createdAt: "2026-10-01T09:00:00.000Z",
        steps: [
          {
            id: input.step.id,
            status: "succeeded",
            inference: {
              attempts: [
                {
                  attempt: 1,
                  outcome: "succeeded",
                  retryable: false,
                  durationMs: 1,
                  turns: result.turns,
                  usage: result.usage,
                  modelTelemetry: result.modelTelemetry,
                },
              ],
            },
          },
        ],
      },
      {
        origin: "import",
        snapshotId: "snapshot-continued",
        indexedAt: "2026-10-01T09:00:00.000Z",
        recordSha256: "a".repeat(64),
        fieldMaxChars: 512,
      },
    );
    if (!projection.ok) throw new Error(`fixture record refused: ${projection.reason}`);
    expect(projection.rows.find((row) => row.rowKind === "attempt")).toMatchObject({
      finishReason: "stop",
      continuations: 1,
      firstFinishReason: "length",
      answerOutputTokens: result.turns!.reduce((total, turn) => total + turn.outputTokens!, 0),
    });
  });

  it("host-completes the same cut answer, unverified, when no continuation is allowed", async () => {
    // Reachable from the catalog floor. On a review judgment step the cut is
    // degraded model content; `pi-harness-cut-judgment.test.ts` pins the
    // `create-documentation` decline.
    vi.stubEnv("DOCSFAB_INFERENCE_MAX_LENGTH_STOP_CONTINUATIONS", "0");
    const repositoryPath = await createRepository();
    const { input, obligationId } = await provisionalInput(repositoryPath);
    const answer = judgmentReply(obligationId);
    const { head, tail } = cutAt(answer, Math.floor(answer.length / 2));
    const { fetchMock } = recordingProvider([
      textTurn(head, validModelConfig.modelId, "length"),
      textTurn(tail),
    ]);

    const result = await (await createAuditHarness()).runStep(input);

    expect(result.verificationResult?.review.verdict).toBe("human-review");
    expect(result.verificationResult?.factInventory.limitations).toContainEqual(
      expect.stringContaining(
        "(text-truncated) after 0 continuation turns; the answer turns billed 5 output tokens",
      ),
    );
    // No continuation was asked for.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The size recorded is the host-completed reply the decoder admitted, not
    // the cut prefix the model sent.
    expect(Number.isSafeInteger(result.answerBytes)).toBe(true);
    expect(result.answerBytes).toBeGreaterThan(Buffer.byteLength(head, "utf8"));
  });

  it("leaves an answer that fits inside the budget on one uncut turn", async () => {
    // Positive control: the continuation branch is skipped.
    const repositoryPath = await createRepository();
    const { input, obligationId } = await provisionalInput(repositoryPath);
    const { fetchMock } = recordingProvider([textTurn(judgmentReply(obligationId))]);

    const result = await (await createAuditHarness()).runStep(input);

    expect(result.verificationResult?.review.verdict).toBe("needs-revision");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.turns).toHaveLength(1);
    expect(result.turns?.filter((turn) => turn.rawStopReason === "length")).toHaveLength(0);
    expect(result.turns?.at(-1)?.rawStopReason).toBe("stop");
    expect(result.executionLease).toMatchObject({
      providerTurns: 1,
      terminalReason: "completed",
    });
  });

  it("spends the catalog default of one continuation and then host-completes the second cut", async () => {
    // At the bound: the default is one continuation, so the second cut is not
    // continued. On this review judgment step it completes unverified; the
    // decline is pinned on `create-documentation` in
    // `pi-harness-cut-judgment.test.ts`.
    expect(limitDefinition("inference.maxLengthStopContinuations").value).toBe(1);
    const repositoryPath = await createRepository();
    const { input, obligationId } = await provisionalInput(repositoryPath);
    const answer = judgmentReply(obligationId);
    const first = cutAt(answer, Math.floor(answer.length / 3));
    const second = cutAt(first.tail, Math.floor(first.tail.length / 2));
    const { fetchMock } = recordingProvider([
      textTurn(first.head, validModelConfig.modelId, "length"),
      textTurn(second.head, validModelConfig.modelId, "length"),
      textTurn(second.tail),
    ]);

    const result = await (await createAuditHarness()).runStep(input);

    expect(result.verificationResult?.review.verdict).toBe("human-review");
    expect(result.verificationResult?.factInventory.limitations).toContainEqual(
      expect.stringContaining(
        `(text-truncated) after 1 continuation turn; the answer turns billed 10 output tokens and the host retained ${(first.head.length + second.head.length).toLocaleString("en-US")} characters.`,
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.turns?.map((turn) => turn.rawStopReason)).toEqual(["length", "length"]);

    // Parity: the run index reads the same answer total the host's note bills.
    const billed = (result.verificationResult?.factInventory.limitations ?? [])
      .map((entry) => /the answer turns billed ([\d,]+) output tokens/u.exec(entry)?.[1])
      .find((match) => match !== undefined);
    expect(billed).toBeDefined();
    const projection = projectRunIndexRows(
      {
        schemaVersion: 2,
        id: "run-host-completed",
        workflow: "review-documentation",
        status: "succeeded",
        createdAt: "2026-10-01T09:00:00.000Z",
        steps: [
          {
            id: input.step.id,
            status: "succeeded",
            inference: {
              attempts: [
                {
                  attempt: 1,
                  outcome: "succeeded",
                  retryable: false,
                  durationMs: 1,
                  turns: result.turns,
                  usage: result.usage,
                  modelTelemetry: result.modelTelemetry,
                },
              ],
            },
          },
        ],
      },
      {
        origin: "import",
        snapshotId: "snapshot-host-completed",
        indexedAt: "2026-10-01T09:00:00.000Z",
        recordSha256: "a".repeat(64),
        fieldMaxChars: 512,
      },
    );
    if (!projection.ok) throw new Error(`fixture record refused: ${projection.reason}`);
    expect(projection.rows.find((row) => row.rowKind === "attempt")).toMatchObject({
      continuations: 1,
      firstFinishReason: "length",
      answerOutputTokens: Number(billed!.replaceAll(",", "")),
    });
  });

  it("spends the raised bound of two continuations and completes on the third turn", async () => {
    // Bound plus one: the same three scripted turns now finish, so the stop
    // above is the bound and not the shape.
    vi.stubEnv("DOCSFAB_INFERENCE_MAX_LENGTH_STOP_CONTINUATIONS", "2");
    const repositoryPath = await createRepository();
    const { input, obligationId } = await provisionalInput(repositoryPath);
    const answer = judgmentReply(obligationId);
    const first = cutAt(answer, Math.floor(answer.length / 3));
    const second = cutAt(first.tail, Math.floor(first.tail.length / 2));
    const { fetchMock } = recordingProvider([
      textTurn(first.head, validModelConfig.modelId, "length"),
      textTurn(second.head, validModelConfig.modelId, "length"),
      textTurn(second.tail),
    ]);

    const result = await (await createAuditHarness()).runStep(input);

    expect(result.verificationResult?.review.verdict).toBe("needs-revision");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.turns).toHaveLength(3);
    expect(result.turns?.filter((turn) => turn.rawStopReason === "length")).toHaveLength(2);
    expect(result.turns?.at(-1)?.rawStopReason).toBe("stop");
  });

  it("never continues a cut that surfaced nothing, and host-completes it on a judgment step", async () => {
    // `output-truncated` has no retained prefix, so there is nothing to
    // continue and the whole budget is already billed. On this review judgment
    // step the answer is host-filled unverified instead of declined.
    const repositoryPath = await createRepository();
    const { input } = await provisionalInput(repositoryPath);
    const { fetchMock } = recordingProvider([blankTurn("length"), blankTurn("length")]);

    const result = await (await createInstantReplayAuditHarness()).runStep(input);

    expect(result.verificationResult?.review).toEqual({ verdict: "human-review", issues: [] });
    expect(result.verificationResult?.factInventory.limitations).toContainEqual(
      expect.stringContaining("(output-truncated) after 0 continuation turns;"),
    );
    // Two requests are the one nudged in-turn replay, not a continuation.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.turns).toHaveLength(1);
  });

  it("still refuses a cut answer on a step with no host response contract", async () => {
    // `audit-documentation` has no contract to decode a stitched answer
    // against, so a cut there ends the attempt as the `cut-answer` condition;
    // the retry rule, not the harness, decides whether a fresh sample follows.
    const repositoryPath = await createRepository();
    const partial = "# Documentation audit\n\n## Findings\n\n1. The README's install section";
    const { fetchMock } = recordingProvider([
      textTurn(partial, validModelConfig.modelId, "length"),
      textTurn("continues here."),
    ]);

    const error = await captureInferenceFailure(
      await createAuditHarness(),
      stepInput(repositoryPath),
    );

    expect(error.message).toContain(
      `text-truncated: step audit-documentation answer cut at the ${outputLimit}-token output limit (finish_reason=length) after ${partial.length} characters`,
    );
    expect(error.retryable).toBe(true);
    expect(error.condition).toBe("cut-answer");
    expect(error.rejection).toMatchObject({ code: "text-truncated" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("continues a cut V3 technical-correction answer on the consuming step", async () => {
    // Step 5 answers the same judgment shape over the same ledger.
    const repositoryPath = await createRepository();
    const { input, obligationId } = await correctionInput(repositoryPath);
    const answer = judgmentReply(obligationId);
    const { head, tail } = cutAt(answer, Math.floor(answer.length / 2));
    const { fetchMock } = recordingProvider([
      textTurn(head, validModelConfig.modelId, "length"),
      textTurn(tail),
    ]);

    const result = await (await createAuditHarness()).runStep(input);

    expect(result.technicalCorrectionEvidence?.schemaVersion).toBe(3);
    expect(result.verificationResult?.review.verdict).toBe("needs-revision");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.turns?.filter((turn) => turn.rawStopReason === "length")).toHaveLength(1);
  });

  it("continues a cut answer under the pilot-shaped composition execution profile", async () => {
    // The review composition binds a compositionPolicy, which selects the settled
    // terminal message as the decoded answer and applies a response byte
    // ceiling; the stitch must work there too.
    const repositoryPath = await createRepository();
    const { input, obligationId } = await provisionalInput(repositoryPath);
    const answer = judgmentReply(obligationId);
    const { head, tail } = cutAt(answer, Math.floor(answer.length / 2));
    const { fetchMock } = recordingProvider([
      textTurn(head, validModelConfig.modelId, "length"),
      textTurn(tail),
    ]);
    const harness = await createReviewHarness(true);

    const result = await harness.runStep(input);

    expect(result.verificationResult?.review.verdict).toBe("needs-revision");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.turns?.filter((turn) => turn.rawStopReason === "length")).toHaveLength(1);
    expect(result.turns?.at(-1)?.rawStopReason).toBe("stop");
  });

  it("refuses a stitched answer that outgrows the composition response byte ceiling", async () => {
    // The stitched answer is one step answer: continuation may not multiply the
    // per-message ceiling. The cut turns carry filler because the byte
    // accounting is under test, not the decoded contract.
    vi.stubEnv("DOCSFAB_INFERENCE_MAX_LENGTH_STOP_CONTINUATIONS", "2");
    const repositoryPath = await createRepository();
    const { input, obligationId } = await provisionalInput(repositoryPath);
    const cut = (text: string) => textTurn(text, validModelConfig.modelId, "length");
    const halves = ["A".repeat(CUT_FILLER_CHARS), "B".repeat(CUT_FILLER_CHARS)] as const;
    // Each cut response body fits the ceiling on its own (the transport and
    // per-turn capture checks pass); only the two retained halves together
    // cross it.
    const maxResponseBytes = Math.max(
      ...(await Promise.all(
        halves.map(async (half) => Buffer.byteLength(await cut(half).text(), "utf8")),
      )),
    );
    expect(CUT_FILLER_CHARS * halves.length).toBeGreaterThan(maxResponseBytes);
    const { fetchMock } = recordingProvider([
      ...halves.map(cut),
      textTurn(judgmentReply(obligationId)),
    ]);
    const executionProfile = fixtureCompositionExecutionProfile({
      maxProviderTurns: COMPOSITION_FIXTURE_MAX_PROVIDER_TURNS,
      timeoutMs: COMPOSITION_FIXTURE_TIMEOUT_MS,
      maxResponseBytes,
    });
    const harness = new PiHarness({
      skillCrateDirectory,
      executionProfile,
      credential: {
        family: "nvidia-inference-api",
        apiKey: validModelConfig.apiKey,
      },
      providerConnectionFactory: createProviderConnectionFactory({
        routeId: executionProfile.routeId,
        transport: executionProfile.transport,
      }),
    });

    const error = await captureInferenceFailure(harness, input);

    expect(error.message).toContain(
      `Provider response rejected because it exceeded the composition response byte limit. limit=${maxResponseBytes}`,
    );
    // The first cut was continued; the second crossed the ceiling.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([0, 1])(
    "enforces the completed editorial response byte limit with %s excess bytes",
    async (overBy) => {
      const editorial = editorialTechnicalStepInput(await createRepository());
      const input = {
        ...editorial,
        step: editorial.workflow.steps.find((step) => step.id === "evaluate-document-quality")!,
      };
      const summary = "Source-supported findings. ".repeat(CUT_FILLER_CHARS).trim();
      const reply = JSON.stringify({
        summary,
        editorialAssessmentProposal: {
          schemaVersion: 1,
          kind: "docsfab-editorial-assessment-proposal",
          assessment: "rejected",
          rationale: "The independent findings establish a source-supported documentation defect.",
          evidenceRefs: input.editorialEvidenceRefs,
          limitations: [],
          recommendation: {
            candidate: "update",
            kind: "product-gap",
            code: "product-gap.documentation-defect",
          },
        },
      });
      const maxResponseBytes = Buffer.byteLength(reply, "utf8") - overBy;
      const splitAt = Math.floor(reply.length / 2);
      const executionProfile = fixtureCompositionExecutionProfile({
        maxProviderTurns: COMPOSITION_FIXTURE_MAX_PROVIDER_TURNS,
        timeoutMs: COMPOSITION_FIXTURE_TIMEOUT_MS,
        maxResponseBytes,
      });
      const harness = new PiHarness({
        skillCrateDirectory,
        qualityDirectory,
        styleContext: await boundStyleContext(),
        executionProfile,
        credential: { family: "nvidia-inference-api", apiKey: validModelConfig.apiKey },
        providerConnectionFactory: createProviderConnectionFactory({
          routeId: executionProfile.routeId,
          transport: executionProfile.transport,
        }),
      });
      const provider = vi.fn(
        scriptedProvider([
          textTurn(reply.slice(0, splitAt), validModelConfig.modelId, "length"),
          textTurn(reply.slice(splitAt)),
        ]),
      );
      vi.stubGlobal("fetch", provider);
      if (overBy) {
        const failure = await captureInferenceFailure(harness, input);
        expect(failure.message).toContain("response byte limit");
      } else {
        expect((await harness.runStep(input)).summary).toBe(summary);
      }
      expect(provider).toHaveBeenCalledTimes(2);
    },
  );

  const DECLINED_STITCH =
    "The answer was cut at the output limit and completed by a continuation before the host refused it.";

  function expectRefusedJudgmentFloor(
    result: Awaited<ReturnType<PiHarness["runStep"]>>,
    stepId: string,
    rejectionCode: string,
  ) {
    expect(result.verificationResult?.review).toEqual({ verdict: "human-review", issues: [] });
    expect(
      result.verificationResult?.factInventory.dimensions.find(
        ({ dimension }) => dimension === APPLICABLE_DIMENSION,
      ),
    ).toMatchObject({ status: "unverified", facts: [] });
    expect(result.verificationResult?.coverage).toMatchObject([
      { path: "README.md", status: "unverified", evidence: [] },
    ]);
    expect(result.verificationResult?.factInventory.limitations).toContain(
      `Host judgment completion: the step's own checks refused the ${stepId} judgment reply after a continuation (1 attempt spent, rejection code ${rejectionCode}), so the host kept none of that reply and did not retry the whole step. The host kept 0 complete obligation judgments and recorded 1 unverified, kept 0 coverage entries and host-filled 1, and kept 0 issue judgments and dropped 0; the verdict is human-review.`,
    );
    expect(result.verificationResult?.factInventory.limitations).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "Host demotion continued-judgment-reply-refused: the step's own checks refused the stitched judgment reply after a continuation,",
        ),
        expect.stringMatching(
          /Host demotion evidence for rejected source obligation .*: continued-judgment-reply-refused, the step's own checks refused the reply after a continuation, so the host kept none of it and filled it without retrying the whole step\./u,
        ),
      ]),
    );
    expect(result.verificationResult?.factInventory.limitations.join(" ")).not.toContain(
      "with no retry left",
    );
    const correction = result.technicalCorrectionEvidence;
    if (correction?.schemaVersion === 3) {
      expect(correction.proposal.obligationAccounting).toEqual([
        expect.objectContaining({
          reason:
            "Host-filled, not judged: the step's own checks refused the stitched judgment reply after a continuation, so the host kept none of that reply, recorded no fact for this obligation, and it needs human review.",
        }),
      ]);
    }
    expect(result.turns).toHaveLength(2);
    expect(result.executionLease).toMatchObject({ providerTurns: 2, terminalReason: "completed" });
  }

  it("floors a first-attempt provisional continuation that restarts the answer", async () => {
    // The model re-emits the whole answer, so the stitched text is half an
    // object followed by a second one. It is the `cut-answer` condition: its
    // retry rule has its own small budget, because each retry re-pays the whole
    // output allowance.
    const repositoryPath = await createRepository();
    const { input, obligationId } = await provisionalInput(repositoryPath);
    const answer = judgmentReply(obligationId);
    const { head } = cutAt(answer, Math.floor(answer.length / 2));
    const { fetchMock } = recordingProvider([
      textTurn(head, validModelConfig.modelId, "length"),
      textTurn(answer),
    ]);

    const result = await (await createAuditHarness()).runStep({
      ...input,
      inferenceAttempt: 1,
      finalInferenceAttempt: false,
    });

    expectRefusedJudgmentFloor(result, input.step.id, "json-unexpected-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("floors a first-attempt provisional continuation that fences the remainder", async () => {
    // A correct remainder wrapped in a fence the host asked the model not to
    // add: the stitch is still undecodable and is marked the same way.
    const repositoryPath = await createRepository();
    const { input, obligationId } = await provisionalInput(repositoryPath);
    const answer = judgmentReply(obligationId);
    const { head, tail } = cutAt(answer, Math.floor(answer.length / 2));
    const { fetchMock } = recordingProvider([
      textTurn(head, validModelConfig.modelId, "length"),
      textTurn(`\n\`\`\`json\n${tail}\n\`\`\``),
    ]);

    const result = await (await createAuditHarness()).runStep({
      ...input,
      inferenceAttempt: 1,
      finalInferenceAttempt: false,
    });

    expectRefusedJudgmentFloor(result, input.step.id, "json-unexpected-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps an ordinary malformed answer retryable when the attempt spent no continuation", async () => {
    // Same step, decoder and `invalid-json` rejection, but no turn was cut, so
    // the model may still correct itself on a retry. The marking keys on the
    // continuation, not the step.
    const repositoryPath = await createRepository();
    const { input } = await provisionalInput(repositoryPath);
    const { fetchMock } = recordingProvider([textTurn('{"verdict": "needs-revision"')]);

    const error = await captureInferenceFailure(await createAuditHarness(), input);

    expect(error.message).toContain("Technical review response rejected: invalid-json");
    expect(error.message).not.toContain(DECLINED_STITCH);
    expect(error.category).toBe("malformed-response");
    expect(error.retryable).toBe(true);
    expect(error.condition).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("floors a first-attempt provisional answer after a reasoning-only cut", async () => {
    // The marking keys on the continuation this attempt spent, not on a
    // non-empty retained prefix: a reasoning-only cut retains nothing but still
    // paid the whole output budget. Only the cut differs from the case above.
    const repositoryPath = await createRepository();
    const { input } = await provisionalInput(repositoryPath);
    const { fetchMock } = recordingProvider([
      thinkingOnlyCutTurn("Weighing every obligation before answering."),
      textTurn('{"verdict": "needs-revision"'),
    ]);

    const result = await (await createAuditHarness()).runStep({
      ...input,
      inferenceAttempt: 1,
      finalInferenceAttempt: false,
    });

    expectRefusedJudgmentFloor(result, input.step.id, "json-unexpected-end");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("floors a first-attempt correction continuation refused for model content", async () => {
    const repositoryPath = await createRepository();
    const { input, obligationId } = await correctionInput(repositoryPath);
    const answer = judgmentReply(obligationId);
    const { head } = cutAt(answer, Math.floor(answer.length / 2));
    const { fetchMock } = recordingProvider([
      textTurn(head, validModelConfig.modelId, "length"),
      textTurn(answer),
    ]);

    const result = await (await createAuditHarness()).runStep({
      ...input,
      inferenceAttempt: 1,
      finalInferenceAttempt: false,
    });

    expectRefusedJudgmentFloor(result, input.step.id, "json-unexpected-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still refuses a stitched model-content reply on create-documentation", async () => {
    const repositoryPath = await createRepository();
    const { provisional, answer } = recordedReviewJudgmentFixture(repositoryPath, {
      workflowName: "create-documentation",
    });
    const { head } = cutAt(answer, Math.floor(answer.length / 2));
    const { fetchMock } = recordingProvider([
      textTurn(head, validModelConfig.modelId, "length"),
      textTurn(answer),
    ]);

    const error = await captureInferenceFailure(await createAuditHarness(), {
      ...provisional,
      inferenceAttempt: 1,
      finalInferenceAttempt: false,
    });

    expect(error.message).toContain("Technical review response rejected: invalid-json");
    expect(error.message).toContain(DECLINED_STITCH);
    expect(error.condition).toBe("cut-answer");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still fails closed on a credential in a stitched judgment reply", async () => {
    const repositoryPath = await createRepository();
    const { input, obligationId } = await provisionalInput(repositoryPath);
    const token = configureCredential(["glpat", "a".repeat(24)].join("-"));
    const answer = judgmentReply(obligationId).replace(issue.id, token);
    const { head, tail } = cutAt(answer, answer.indexOf(token));
    const { fetchMock } = recordingProvider([
      textTurn(head, validModelConfig.modelId, "length"),
      textTurn(tail),
    ]);

    const error = await captureInferenceFailure(await createAuditHarness(), {
      ...input,
      inferenceAttempt: 1,
      finalInferenceAttempt: false,
    });

    expect(error.message).toContain("Technical correction response rejected: unsafe-disclosure.");
    expect(error.message).toContain(DECLINED_STITCH);
    expect(error.rejection?.code).toBe("unsafe-disclosure");
    expect(error.retryable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("asks for the whole answer when the cut turn carried only reasoning", async () => {
    // `text-truncated` from the thinking fallback retains an empty prefix, so
    // the ask is for the whole answer rather than a continuation.
    const repositoryPath = await createRepository();
    const { input, obligationId } = await provisionalInput(repositoryPath);
    const { requests, fetchMock } = recordingProvider([
      thinkingOnlyCutTurn("Weighing every obligation before answering."),
      textTurn(judgmentReply(obligationId)),
    ]);

    const result = await (await createAuditHarness()).runStep(input);

    expect(result.verificationResult?.review.verdict).toBe("needs-revision");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lastUserText(requests[1]!)).toContain(
      "None of the answer itself arrived, so the host retained nothing of it",
    );
    expect(lastUserText(requests[1]!)).toContain(
      "Emit the whole answer now, from its first character.",
    );
    expect(lastUserText(requests[1]!)).not.toContain(
      "Continue that same answer from its final character.",
    );
    // A reasoning-only message leaves no assistant text in the conversation.
    expect(assistantTexts(requests[1]!)).toEqual([]);
  });

  it("asks for the whole answer when the cut turn only echoed its reasoning as content", async () => {
    // The echoed `content` repeats the reasoning, so it is not an answer prefix:
    // stitching the next message onto it would fail the decode at character 0.
    const repositoryPath = await createRepository();
    const { input, obligationId } = await provisionalInput(repositoryPath);
    const { requests, fetchMock } = recordingProvider([
      reasoningEchoCutTurn(["Weighing every obligation", " before answering."]),
      textTurn(judgmentReply(obligationId)),
    ]);

    const result = await (await createAuditHarness()).runStep(input);

    expect(result.verificationResult?.review.verdict).toBe("needs-revision");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lastUserText(requests[1]!)).toContain(
      "Emit the whole answer now, from its first character.",
    );
    expect(lastUserText(requests[1]!)).not.toContain(
      "Continue that same answer from its final character.",
    );
  });

  it("ends at the hard tool-call ceiling with a retained prefix, admitting neither the prefix nor a forced answer", async () => {
    // The model answers a cut prefix, then spends the whole tool-call ceiling.
    // The attempt ends at the ceiling: no answer is asked for, so the retained
    // prefix is never stitched or admitted. Reached by shrinking the sealed
    // provider-turn budget.
    const repositoryPath = await createRepository();
    const { input, obligationId } = await provisionalInput(repositoryPath);
    const answer = judgmentReply(obligationId);
    const { head } = cutAt(answer, Math.floor(answer.length / 2));
    const { fetchMock } = recordingProvider([
      textTurn(head, validModelConfig.modelId, "length"),
      toolTurn(
        Array.from({ length: CEILING_FIXTURE_TOOL_CALLS }, (_, offset) => ({
          id: `ceiling-ls-${offset}`,
          name: "ls",
          arguments: { path: "." },
        })),
      ),
      textTurn(answer),
    ]);
    const executionProfile = fixtureCompositionExecutionProfile({
      maxProviderTurns: CEILING_FIXTURE_MAX_PROVIDER_TURNS,
      timeoutMs: COMPOSITION_FIXTURE_TIMEOUT_MS,
    });
    const harness = new PiHarness({
      skillCrateDirectory,
      executionProfile,
      credential: {
        family: "nvidia-inference-api",
        apiKey: validModelConfig.apiKey,
      },
      providerConnectionFactory: createProviderConnectionFactory({
        routeId: executionProfile.routeId,
        transport: executionProfile.transport,
      }),
    });

    const error = await captureInferenceFailure(harness, input);

    expect(error).toMatchObject({ category: "no-progress", condition: "tool-call-ceiling" });
    expect(error.message).toContain(
      `used all of its tool-call ceiling of ${CEILING_FIXTURE_TOOL_CALLS} calls`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(error.evidence?.executionLease).toMatchObject({
      terminalReason: "hard-tool-call-ceiling",
      toolCalls: { executed: CEILING_FIXTURE_TOOL_CALLS },
    });
  });

  it("states the enforced judgment answer ceilings in both judgment contracts", async () => {
    // Stating the ceilings lets the model budget for them in advance.
    const repositoryPath = await createRepository();
    const expected = [
      `a statement or location is at most ${limitDefinition("technicalCorrection.fieldMaxChars").value} characters`,
      `an uncertainty or a rejection reason is at most ${limitDefinition("technicalCorrection.proseMaxChars").value} characters`,
      `one judgment names at most ${limitDefinition("technicalCorrection.maxJudgmentFactIds").value} obligation IDs`,
      `the answer carries at most ${limitDefinition("technicalCorrection.maxIssueJudgments").value} issue judgments`,
    ];

    const provisional = await provisionalInput(repositoryPath);
    const first = recordingProvider([textTurn(judgmentReply(provisional.obligationId))]);
    await (await createAuditHarness()).runStep(provisional.input);
    const provisionalPrompt = lastUserText(first.requests[0]!);

    const correction = await correctionInput(repositoryPath);
    const second = recordingProvider([textTurn(judgmentReply(correction.obligationId))]);
    await (await createAuditHarness()).runStep(correction.input);
    const correctionPrompt = lastUserText(second.requests[0]!);

    for (const prompt of [provisionalPrompt, correctionPrompt]) {
      expect(prompt).toContain("Answer budget (host-enforced ceilings, not targets):");
      // The whole-answer budget is derived from the bound profile's output
      // limit, not the sealed ceiling across compositions. A literal oracle:
      // 16384 x 2 turns x 2.
      expect(validModelConfig.profile.maxOutputTokens).toBe(16_384);
      expect(prompt).toContain("the whole answer is at most 65536 characters");
      for (const line of expected) expect(prompt).toContain(line);
      expect(prompt).toContain("Serialize compact JSON without indentation.");
      expect(prompt).toContain("An answer cut at the output limit is not accepted as complete.");
    }
    // The ledger-derivation step answers a different shape and keeps its own
    // guidance: the budget is not pasted onto every structured step.
    const derive = recordingProvider([textTurn("{}")]);
    await captureInferenceFailure(
      await createAuditHarness(),
      reviewSourcePhaseInput(repositoryPath, "derive-source-obligations"),
    );
    expect(lastUserText(derive.requests[0]!)).not.toContain(
      "Answer budget (host-enforced ceilings, not targets):",
    );
  });
});

/**
 * The marking's category scope, driven at the classifier's boundary: reaching a
 * retryable non-`malformed-response` failure through a Pi session would cost
 * real transport backoff. These pin the categories the marking leaves alone.
 */
describe("markStitchedReplyRefusal category and continuation scope", () => {
  const rejection = { code: "invalid-json", location: "$response" } as const;

  it("marks a malformed-response rejection cut-answer once a continuation was spent", () => {
    const rejected = new InferenceStepError(
      "Technical review response rejected: invalid-json.",
      "malformed-response",
      true,
      undefined,
      rejection,
    );

    const marked = markStitchedReplyRefusal(rejected, 1) as InferenceStepError;

    expect(marked).not.toBe(rejected);
    // The retry rule decides; the raiser's correctability is kept.
    expect(marked.retryable).toBe(true);
    expect(marked.condition).toBe("cut-answer");
    expect(marked.category).toBe("malformed-response");
    expect(marked.rejection).toEqual(rejection);
    expect(marked.message.startsWith(rejected.message)).toBe(true);
  });

  it.each([
    ["provider-transient", "Provider turn failed: 8 provider attempts: 503."],
    ["timeout", "The attempt deadline elapsed."],
  ] as const)(
    "leaves a retryable %s failure after a continuation untouched",
    (category, message) => {
      // Transient, not a property of the over-long answer, so a step retry is
      // the right remedy.
      const transient = new InferenceStepError(message, category, true);

      expect(markStitchedReplyRefusal(transient, 1)).toBe(transient);
    },
  );

  it("leaves a blank response after a continuation untouched", () => {
    // A blank reply is not a rejected answer, and the model may answer on a retry.
    const blank = new InferenceStepError(
      "Model returned a blank response.",
      "blank-response",
      true,
    );

    expect(markStitchedReplyRefusal(blank, 1)).toBe(blank);
  });

  it("keeps a rejection the raiser declined terminal while marking it", () => {
    const declinedByRaiser = new InferenceStepError(
      "x",
      "malformed-response",
      false,
      undefined,
      rejection,
    );

    const marked = markStitchedReplyRefusal(declinedByRaiser, 1) as InferenceStepError;

    expect(marked.retryable).toBe(false);
    expect(marked.condition).toBe("cut-answer");
  });

  it("leaves every rejection untouched when no continuation was spent", () => {
    const rejected = new InferenceStepError("x", "malformed-response", true, undefined, rejection);

    expect(markStitchedReplyRefusal(rejected, 0)).toBe(rejected);
  });

  it("leaves an error the harness did not raise untouched", () => {
    const foreign = new Error("cancelled");

    expect(markStitchedReplyRefusal(foreign, 1)).toBe(foreign);
  });
});
