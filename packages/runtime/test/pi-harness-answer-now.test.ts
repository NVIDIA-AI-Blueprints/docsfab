// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { limit } from "../src/config/limits.js";
import { parseRetryPolicy } from "../src/config/retry-policy.js";
import {
  answerNowFlipAtMs,
  stepAnswerNowPlan,
  resolveAnswerNowPolicy,
} from "../src/harness/answer-now.js";
import { PI_ANSWER_NOW_PROMPT, PI_ANSWER_NOW_TOOL_REFUSAL } from "../src/harness/pi-session.js";
import { READ_EVIDENCE_NOTICE_PREFIX } from "../src/harness/read-evidence.js";
import { classifyInferenceAttempt } from "../src/operator/failure-classification.js";
import { HOST_COVERAGE_DEGRADATION_STEM } from "../src/workflow-execution/judgment-coverage.js";
import {
  expectNoToolHistoryWithoutTools,
  type RecordedProviderRequest,
} from "./helpers/provider-request-shape.js";
import {
  boundStyleContext,
  HarnessStepInput,
  PiHarness,
  type PiHarnessOptions,
  SourceObligationLedgerProposalV1,
  TECHNICAL_FACT_DIMENSIONS,
  bindSourceObligationLedgerV2,
  captureInferenceFailure,
  createAuditHarness,
  createProviderConnectionFactory,
  expectDecodedAttemptEvidence,
  createRepository,
  executeInferenceStep,
  getWorkflow,
  issueOriginalSourceAuthorityAdmission,
  fixtureCompositionExecutionProfile,
  resetSharedTestState,
  reviewSourcePhaseInput,
  reviewStepInput,
  scriptedProvider,
  sealOriginalSourceAuthority,
  qualityDirectory,
  skillCrateDirectory,
  sourceObligationScopeSha256,
  textTurn,
  toolTurn,
  validModelConfig,
} from "./support/pi-harness-session-fixtures.js";

/** Run admission resolves the bound style profile once; every harness here reads it. */
const styleContext = await boundStyleContext();

afterEach(resetSharedTestState);

/**
 * A judgment step can read through its whole attempt without answering, so
 * the host asks for the answer once, from inside the attempt, at a named
 * elapsed point. The forced turn keeps the tool list the route already
 * accepted, since a route can refuse a tool history sent with no tools; the
 * host withdraws the tools by refusing every call made after the ask.
 *
 * Cases drive `PiHarness.runStep` against the real Pi session with a scripted
 * provider and an injected clock.
 */
describe("PiHarness soft elapsed budget for a judgment step", () => {
  const SOURCE_SHA256 = "f".repeat(64);
  const APPLICABLE_DIMENSION = "input-representations";
  const TARGET = "README.md";
  /** The sealed attempt timer. */
  const ATTEMPT_TIMEOUT_MS = limit("sealed.compositionLimits.timeoutMs", { environment: {} }).value;
  /** The elapsed point the catalog puts the ask at, for that attempt timer. */
  const FLIP_AT_MS = answerNowFlipAtMs(
    ATTEMPT_TIMEOUT_MS,
    resolveAnswerNowPolicy({ environment: {} }),
    stepAnswerNowPlan(
      "provisional-technical-verification",
      validModelConfig.profile.maxOutputTokens,
      {
        environment: {},
      },
    ),
  )!;
  /** The attempt timer 13 of the 16 registered compositions seal. */
  const SHORT_ATTEMPT_TIMEOUT_MS = 300_000;
  /**
   * Enough governed provider turns for the scripted turns, so the tool budget
   * decides nothing in these cases.
   */
  const FIXTURE_MAX_PROVIDER_TURNS = 8;
  /** A recorded route refusal of a tool history sent with no tools. */
  const TOOL_HISTORY_REJECTION =
    "litellm.UnsupportedParamsError: Bedrock doesn't support tool calling without `tools=` param specified. Pass `tools=` param OR set `litellm.modify_params = True` // `litellm_settings::modify_params: True` to add dummy tool to the request.. Received Model Group=aws/anthropic/bedrock-claude-sonnet-5\nAvailable Model Group Fallbacks=None";
  const TOOL_HISTORY_REJECTION_STATUS = 400;

  /** A mutable clock the harness reads for every elapsed decision in an attempt. */
  function testClock(startedAt = 1_000_000) {
    let value = startedAt;
    return {
      now: () => value,
      advanceTo: (elapsedMs: number) => {
        value = startedAt + elapsedMs;
      },
    };
  }

  interface RecordedRequest extends RecordedProviderRequest {
    messages?: Array<{
      role?: unknown;
      content?: unknown;
      tool_calls?: unknown;
      tool_call_id?: unknown;
    }>;
  }

  /**
   * A provider that records each request and moves the clock once the turn at
   * `afterRequest` has been sent, so the elapsed budget is spent between that
   * turn and the next `prepareNextTurn`.
   */
  function clockedProvider(
    responses: readonly Response[],
    clock: ReturnType<typeof testClock>,
    schedule: { afterRequest: number; elapsedMs: number },
  ) {
    const requests: RecordedRequest[] = [];
    const provider = scriptedProvider(responses);
    const fetchMock = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === schedule.afterRequest) clock.advanceTo(schedule.elapsedMs);
      return provider(request, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    return { requests, fetchMock };
  }

  function lastUserText(request: { messages?: Array<{ content?: unknown }> }): string {
    const content = request.messages?.at(-1)?.content;
    if (Array.isArray(content)) {
      return content.map((part) => (part as { text?: string }).text ?? "").join("");
    }
    return typeof content === "string" ? content : "";
  }

  /** How many copies of the host's ask one request's message list carries. */
  function askCount(request: { messages?: Array<{ role?: unknown; content?: unknown }> }): number {
    return userTexts(request).filter((text) => text === PI_ANSWER_NOW_PROMPT).length;
  }

  function userTexts(request: {
    messages?: Array<{ role?: unknown; content?: unknown }>;
  }): string[] {
    return (request.messages ?? [])
      .filter((message) => message.role === "user")
      .map((message) =>
        Array.isArray(message.content)
          ? message.content.map((part) => (part as { text?: string }).text ?? "").join("")
          : typeof message.content === "string"
            ? message.content
            : "",
      );
  }

  function toolCount(request: RecordedRequest): number {
    return Array.isArray(request.tools) ? request.tools.length : 0;
  }

  function toolResultText(request: RecordedRequest, toolCallId: string): string | undefined {
    const message = (request.messages ?? []).find(
      (candidate) => candidate.role === "tool" && candidate.tool_call_id === toolCallId,
    );
    if (!message) return undefined;
    return typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((part) => (part as { text?: string }).text ?? "").join("")
        : undefined;
  }

  function proposal(): SourceObligationLedgerProposalV1 {
    return {
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
    } as unknown as SourceObligationLedgerProposalV1;
  }

  /** The sealed V2 ledger and the step-4 input that judges it. */
  async function provisionalInput(repositoryPath: string) {
    const deriveInput = reviewSourcePhaseInput(repositoryPath, "derive-source-obligations");
    const scopeSha256 = sourceObligationScopeSha256(deriveInput);
    const sealed = sealOriginalSourceAuthority({
      runId: deriveInput.runId!,
      scope: "review-tracked-workspace",
      repositoryRevision: deriveInput.evidenceIdentity!.repositoryRevision,
      scopeSha256,
      workspaceSnapshotSha256: deriveInput.searchEvidence!.workspaceSnapshotSha256,
      members: [{ path: TARGET, mode: 0o644, byteLength: 10, sourceSha256: SOURCE_SHA256 }],
    });
    const ledger = bindSourceObligationLedgerV2(
      proposal(),
      deriveInput,
      [{ path: TARGET, sha256: SOURCE_SHA256 }],
      sealed.evidence,
    );
    issueOriginalSourceAuthorityAdmission({
      capture: sealed.capture,
      observer: {
        observe: async (paths) => paths.map((path) => ({ path, sha256: SOURCE_SHA256 })),
      },
      runId: deriveInput.runId!,
      repositoryRevision: deriveInput.evidenceIdentity!.repositoryRevision,
      scopeSha256,
      workspaceSnapshotSha256: deriveInput.searchEvidence!.workspaceSnapshotSha256,
    });
    const obligationId = ledger.dimensions.find(
      (dimension) => dimension.dimension === APPLICABLE_DIMENSION,
    )!.obligations[0]!.id;
    const input: HarnessStepInput = {
      ...reviewSourcePhaseInput(repositoryPath, "provisional-technical-verification"),
      runId: deriveInput.runId,
      sourceObligationLedger: ledger,
    };
    return { input, obligationId };
  }

  /**
   * An early judgment answer that covered no page, which the host coverage table
   * degrades rather than refuses.
   */
  function uncoveredJudgmentReply(obligationId: string): string {
    return JSON.stringify({
      verdict: "human-review",
      coverage: [],
      issueJudgments: [],
      obligationJudgments: [
        {
          obligationId,
          disposition: "retained",
          documentationDisposition: "documented",
          issueIds: [],
        },
      ],
    });
  }

  function compositionHarness(
    now: () => number,
    configureSession?: PiHarnessOptions["configureSession"],
    timeoutMs = ATTEMPT_TIMEOUT_MS,
    maxOutputTokens?: number,
  ) {
    const base = fixtureCompositionExecutionProfile({
      maxProviderTurns: FIXTURE_MAX_PROVIDER_TURNS,
      timeoutMs,
    });
    const executionProfile =
      maxOutputTokens === undefined
        ? base
        : {
            ...base,
            profile: {
              ...base.profile,
              configuredLimits: { ...base.profile.configuredLimits, maxOutputTokens },
              maxOutputTokens,
            },
          };
    return new PiHarness({
      skillCrateDirectory,
      qualityDirectory,
      styleContext,
      executionProfile,
      credential: { family: "nvidia-inference-api", apiKey: validModelConfig.apiKey },
      providerConnectionFactory: createProviderConnectionFactory({
        routeId: executionProfile.routeId,
        transport: executionProfile.transport,
      }),
      now,
      ...(configureSession ? { configureSession } : {}),
    });
  }

  const readTurn = () => toolTurn([{ id: "answer-now-ls", name: "ls", arguments: { path: "." } }]);
  const lateReadTurn = () =>
    toolTurn([{ id: "answer-now-ls-2", name: "ls", arguments: { path: "." } }]);

  it("keeps the provider tools and asks for the answer once the reading share is spent", async () => {
    const repositoryPath = await createRepository();
    const { input, obligationId } = await provisionalInput(repositoryPath);
    const clock = testClock();
    const { requests, fetchMock } = clockedProvider(
      [readTurn(), textTurn(uncoveredJudgmentReply(obligationId))],
      clock,
      { afterRequest: 1, elapsedMs: FLIP_AT_MS },
    );

    const result = await compositionHarness(clock.now).runStep(input);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The forced turn carries the earlier tool list unchanged plus the one
    // appended ask: its history holds a tool call and result, and the route
    // refuses such a history sent with no tools.
    expect(toolCount(requests[1]!)).toBeGreaterThan(0);
    expect(requests[1]!.tools).toEqual(requests[0]!.tools);
    expectNoToolHistoryWithoutTools(requests);
    expect(lastUserText(requests[1]!)).toBe(PI_ANSWER_NOW_PROMPT);
    expect(lastUserText(requests[1]!)).toContain("DocsFab reached the reading budget");
    // Degraded model content, not a refusal: the page the model never compared
    // is host-filled `unverified` with a limitation.
    expect(result.verificationResult?.coverage).toEqual([
      {
        path: TARGET,
        status: "unverified",
        evidence: [],
        reason: expect.stringContaining("returned no coverage entry"),
      },
    ]);
    expect(
      result.verificationResult?.factInventory.limitations.filter((entry) =>
        entry.startsWith(HOST_COVERAGE_DEGRADATION_STEM),
      ),
    ).toHaveLength(1);
    // The ordinary settlement path, not the terminal-summary checkpoint.
    expect(result.executionLease).toMatchObject({ terminalReason: "completed", providerTurns: 2 });
    // The attempt records the timed ask and the turn after which it came.
    expect(result.concludeNow).toEqual({ trigger: "reading-budget", turn: 1 });
  });

  it("arms on a 300 s composition: asks at the derived point and not one millisecond before", async () => {
    // The reserve follows the step's own answer plan, so the ask fires inside a
    // 300,000 ms attempt. Literal oracle: the provisional judgment plans 8,200 tokens,
    // 102,500 ms at 80 tokens per second plus two 25,000 ms turns, which leaves
    // 147,500 ms; the 120,000 ms reading share is earlier.
    const SHORT_FLIP_AT_MS = 120_000;
    expect(
      answerNowFlipAtMs(
        SHORT_ATTEMPT_TIMEOUT_MS,
        resolveAnswerNowPolicy({ environment: {} }),
        stepAnswerNowPlan(
          "provisional-technical-verification",
          validModelConfig.profile.maxOutputTokens,
          { environment: {} },
        ),
      ),
    ).toBe(SHORT_FLIP_AT_MS);
    for (const [elapsedMs, asked] of [
      [SHORT_FLIP_AT_MS, true],
      [SHORT_FLIP_AT_MS - 1, false],
    ] as const) {
      const repositoryPath = await createRepository();
      const { input, obligationId } = await provisionalInput(repositoryPath);
      const clock = testClock();
      const { requests, fetchMock } = clockedProvider(
        [readTurn(), textTurn(uncoveredJudgmentReply(obligationId))],
        clock,
        { afterRequest: 1, elapsedMs },
      );

      const result = await compositionHarness(
        clock.now,
        undefined,
        SHORT_ATTEMPT_TIMEOUT_MS,
      ).runStep(input);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(askCount(requests[1]!), `elapsed ${elapsedMs}`).toBe(asked ? 1 : 0);
      expect(requests[1]!.tools).toEqual(requests[0]!.tools);
      expect(result.executionLease).toMatchObject({
        terminalReason: "completed",
        providerTurns: 2,
      });
    }
  });

  it("caps the step's answer plan at what the composition's turns can carry", async () => {
    // Two 4,096-token turns carry 8,192 tokens, under the provisional
    // judgment's 8,200: the reserve is 152,400 ms, not 152,500 ms, so on a
    // 200,000 ms attempt the reserve point is 47,600 ms rather than 47,500 ms.
    const TIMEOUT_MS = 200_000;
    const PER_TURN_OUTPUT_TOKENS = 4_096;
    const CAPPED_FLIP_AT_MS = 47_600;
    expect(
      answerNowFlipAtMs(
        TIMEOUT_MS,
        resolveAnswerNowPolicy({ environment: {} }),
        stepAnswerNowPlan("provisional-technical-verification", PER_TURN_OUTPUT_TOKENS, {
          environment: {},
        }),
      ),
    ).toBe(CAPPED_FLIP_AT_MS);
    for (const [elapsedMs, asked] of [
      [CAPPED_FLIP_AT_MS, true],
      [CAPPED_FLIP_AT_MS - 1, false],
    ] as const) {
      const repositoryPath = await createRepository();
      const { input, obligationId } = await provisionalInput(repositoryPath);
      const clock = testClock();
      const { requests } = clockedProvider(
        [readTurn(), textTurn(uncoveredJudgmentReply(obligationId))],
        clock,
        { afterRequest: 1, elapsedMs },
      );

      await compositionHarness(clock.now, undefined, TIMEOUT_MS, PER_TURN_OUTPUT_TOKENS).runStep(
        input,
      );

      expect(askCount(requests[1]!), `elapsed ${elapsedMs}`).toBe(asked ? 1 : 0);
    }
  });

  it("asks for the answer after read-loop notices and accepts it", async () => {
    // Unchanged re-reads get host notices; the answer-now ask still fires on
    // the clock, and the answer it asked for is accepted.
    const repositoryPath = await createRepository();
    const { input, obligationId } = await provisionalInput(repositoryPath);
    const clock = testClock();
    const reRead = (id: string) => toolTurn([{ id, name: "ls", arguments: { path: "." } }]);
    const { requests, fetchMock } = clockedProvider(
      [
        reRead("ls-1"),
        reRead("ls-2"),
        reRead("ls-3"),
        textTurn(uncoveredJudgmentReply(obligationId)),
      ],
      clock,
      { afterRequest: 3, elapsedMs: FLIP_AT_MS },
    );

    const result = await compositionHarness(clock.now).runStep(input);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(toolResultText(requests[2]!, "ls-2")).toContain(READ_EVIDENCE_NOTICE_PREFIX);
    expect(toolResultText(requests[3]!, "ls-3")).toContain(READ_EVIDENCE_NOTICE_PREFIX);
    expect(lastUserText(requests[3]!)).toBe(PI_ANSWER_NOW_PROMPT);
    expect(result.tools?.readEvidence).toEqual({
      unchangedReReads: 2,
      withheld: 0,
      maxRepeatsOfOneResult: 2,
      maxUnchangedReReadsAcrossResults: 2,
    });
    expect(result.executionLease).toMatchObject({ terminalReason: "completed", providerTurns: 4 });
  });

  it("keeps the tools one millisecond before the same point", async () => {
    // Everything else is identical, so only the clock decides.
    const repositoryPath = await createRepository();
    const { input, obligationId } = await provisionalInput(repositoryPath);
    const clock = testClock();
    const { requests, fetchMock } = clockedProvider(
      [readTurn(), textTurn(uncoveredJudgmentReply(obligationId))],
      clock,
      { afterRequest: 1, elapsedMs: FLIP_AT_MS - 1 },
    );

    await compositionHarness(clock.now).runStep(input);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(toolCount(requests[1]!)).toBeGreaterThan(0);
    expect(userTexts(requests[1]!).join("\n")).not.toContain(PI_ANSWER_NOW_PROMPT);
    expectNoToolHistoryWithoutTools(requests);
  });

  it("asks exactly once, and a cut forced answer is still completed and admitted", async () => {
    // The forced answer settles through the ordinary path, so a cut answer
    // still takes the length-stop continuation and is stitched onto its
    // retained prefix. Pi persists the host's answer-now ask in session history,
    // including the continuation run. The continuation offers the same tools;
    // the host refuses a call made there like any other call after the ask.
    const repositoryPath = await createRepository();
    const { input, obligationId } = await provisionalInput(repositoryPath);
    const answer = uncoveredJudgmentReply(obligationId);
    const cut = Math.floor(answer.length / 2);
    const clock = testClock();
    const { requests, fetchMock } = clockedProvider(
      [
        readTurn(),
        textTurn(answer.slice(0, cut), validModelConfig.modelId, "length"),
        textTurn(answer.slice(cut)),
      ],
      clock,
      { afterRequest: 1, elapsedMs: FLIP_AT_MS },
    );

    const result = await compositionHarness(clock.now).runStep(input);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.verificationResult?.coverage[0]?.status).toBe("unverified");
    // The continuation carries the one original ask; it does not add a copy.
    expect(requests.map((request) => askCount(request))).toEqual([0, 1, 1]);
    expect(lastUserText(requests[2]!)).toContain("Emit only the remaining characters.");
    expect(requests[1]!.tools).toEqual(requests[0]!.tools);
    expect(requests[2]!.tools).toEqual(requests[0]!.tools);
    expectNoToolHistoryWithoutTools(requests);
  });

  it("refuses a tool call made after the ask, does not ask again, and still settles the answer", async () => {
    // The host withdraws the tools by refusing the call, not by dropping them
    // from the request: the call is recorded as a denied lease authorization,
    // nothing runs, and the model is told why.
    const repositoryPath = await createRepository();
    const { input, obligationId } = await provisionalInput(repositoryPath);
    const clock = testClock();
    const { requests, fetchMock } = clockedProvider(
      [readTurn(), lateReadTurn(), textTurn(uncoveredJudgmentReply(obligationId))],
      clock,
      { afterRequest: 1, elapsedMs: FLIP_AT_MS },
    );

    const result = await compositionHarness(clock.now).runStep(input);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    // The call made before the ask ran: its result is the workspace listing.
    expect(toolResultText(requests[1]!, "answer-now-ls")).toContain(TARGET);
    // The call made after it did not run.
    expect(toolResultText(requests[2]!, "answer-now-ls-2")).toBe(PI_ANSWER_NOW_TOOL_REFUSAL);
    expect(toolResultText(requests[2]!, "answer-now-ls-2")).not.toContain(TARGET);
    expect(result.executionLease).toMatchObject({
      terminalReason: "completed",
      providerTurns: 3,
      toolCalls: { requested: 2, executed: 1, succeeded: 1, denied: 1, governanceBlocked: 0 },
    });
    // The second prepared turn inherits the one ask in its history; no second
    // copy is stacked.
    expect(requests.map((request) => askCount(request))).toEqual([0, 1, 1]);
    expect(requests[2]!.tools).toEqual(requests[0]!.tools);
    expectNoToolHistoryWithoutTools(requests);
    expect(result.tools?.failureCategories).toContainEqual({
      category: "governance-stop",
      count: 1,
    });
    expectDecodedAttemptEvidence(result, "succeeded", false);
    expect(result.verificationResult?.coverage[0]?.status).toBe("unverified");
    expect(
      result.verificationResult?.factInventory.limitations.filter((entry) =>
        entry.startsWith(HOST_COVERAGE_DEGRADATION_STEM),
      ),
    ).toHaveLength(1);
  });

  it("refuses every call of a batch made after the ask with the same reason", async () => {
    // Pi hands the host one call at a time, and every call after the first finds
    // the batch already settled, so each must still be told why it was refused.
    const repositoryPath = await createRepository();
    const { input, obligationId } = await provisionalInput(repositoryPath);
    const clock = testClock();
    const { requests, fetchMock } = clockedProvider(
      [
        readTurn(),
        toolTurn([
          { id: "answer-now-ls-2", name: "ls", arguments: { path: "." } },
          { id: "answer-now-find-2", name: "find", arguments: { pattern: "*.md" } },
        ]),
        textTurn(uncoveredJudgmentReply(obligationId)),
      ],
      clock,
      { afterRequest: 1, elapsedMs: FLIP_AT_MS },
    );

    const result = await compositionHarness(clock.now).runStep(input);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(toolResultText(requests[2]!, "answer-now-ls-2")).toBe(PI_ANSWER_NOW_TOOL_REFUSAL);
    expect(toolResultText(requests[2]!, "answer-now-find-2")).toBe(PI_ANSWER_NOW_TOOL_REFUSAL);
    expect(result.executionLease).toMatchObject({
      terminalReason: "completed",
      toolCalls: { requested: 3, executed: 1, denied: 2 },
    });
    // Each refused call is one governance stop, so the tool summary accounts for
    // every call of the last governed turn and still decodes.
    expect(result.tools?.failureCategories).toContainEqual({
      category: "governance-stop",
      count: 2,
    });
    expectDecodedAttemptEvidence(result, "succeeded", false);
    expectNoToolHistoryWithoutTools(requests);
  });

  it("runs the same late call one millisecond before the ask", async () => {
    const repositoryPath = await createRepository();
    const { input, obligationId } = await provisionalInput(repositoryPath);
    const clock = testClock();
    const { requests, fetchMock } = clockedProvider(
      [readTurn(), lateReadTurn(), textTurn(uncoveredJudgmentReply(obligationId))],
      clock,
      { afterRequest: 1, elapsedMs: FLIP_AT_MS - 1 },
    );

    const result = await compositionHarness(clock.now).runStep(input);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(toolResultText(requests[2]!, "answer-now-ls-2")).toContain(TARGET);
    expect(toolResultText(requests[2]!, "answer-now-ls-2")).not.toBe(PI_ANSWER_NOW_TOOL_REFUSAL);
    expect(result.executionLease).toMatchObject({
      toolCalls: { requested: 2, executed: 2, denied: 0 },
    });
    expect(requests.map((request) => askCount(request))).toEqual([0, 0, 0]);
  });

  it("keeps the lease-boundary reason for a call the lease itself blocks, with no ask made", async () => {
    // A call the lease refuses for its own reason is told it reached a lease
    // boundary, not that the reading budget is spent. A batch of as many calls
    // as the fixture has provider turns exceeds the hard tool-call ceiling (at
    // most `maxProviderTurns - maxLeases`). The turn after it is refused
    // locally, so the refusal is read off the session itself.
    const repositoryPath = await createRepository();
    const { input } = await provisionalInput(repositoryPath);
    const clock = testClock();
    const callIds = Array.from(
      { length: FIXTURE_MAX_PROVIDER_TURNS },
      (_, index) => `lease-bound-ls-${index}`,
    );
    clockedProvider(
      [toolTurn(callIds.map((id) => ({ id, name: "ls", arguments: { path: "." } })))],
      clock,
      { afterRequest: 1, elapsedMs: 0 },
    );
    const sessions: Array<{ messages: readonly unknown[] }> = [];
    const harness = compositionHarness(clock.now, (session) => {
      sessions.push(session);
    });

    const error = await captureInferenceFailure(harness, input);

    const toolCalls = error.evidence?.executionLease?.toolCalls;
    expect(toolCalls?.denied).toBe(0);
    expect(toolCalls?.governanceBlocked).toBeGreaterThan(0);
    const refusals = (sessions[0]?.messages ?? [])
      .map((message) => message as { role?: unknown; content?: unknown })
      .filter((message) => message.role === "toolResult")
      .map((message) =>
        Array.isArray(message.content)
          ? message.content.map((part) => (part as { text?: string }).text ?? "").join("")
          : "",
      )
      .filter((text) => !text.includes(TARGET));
    expect(refusals).toHaveLength(toolCalls?.governanceBlocked ?? -1);
    for (const text of refusals) {
      expect(text).toBe("DocsFab withheld this tool call at an execution-lease boundary.");
    }
  });

  /**
   * The ledger derivation of the same workflow: a proposal, not a judgment, so
   * there is no host coverage table to degrade it into.
   */
  function derivationCase(repositoryPath: string) {
    return {
      input: {
        ...reviewSourcePhaseInput(repositoryPath, "derive-source-obligations"),
        reviewScope: undefined,
        contextTarget: { sourcePath: TARGET },
      } as HarnessStepInput,
      reply: JSON.stringify(proposal(), null, 2),
    };
  }

  /** The editorial review of the same workflow, also not a judgment. */
  function editorialCase(repositoryPath: string) {
    return {
      input: reviewStepInput(repositoryPath, "review-documentation"),
      reply: JSON.stringify({
        verdict: "needs-revision",
        issues: [
          {
            id: "TECH-001",
            severity: "major",
            category: "technical_accuracy",
            location: `${TARGET}:12`,
            finding: "The command omits a required flag.",
            evidence: { source_id: "source-1", locator: "src/cli.ts:42" },
            required_change: "Add the required flag.",
          },
        ],
      }),
    };
  }

  it.each([
    ["derive-source-obligations (step 2)", derivationCase],
    ["review-documentation (step 6)", editorialCase],
  ] as const)(
    "never arms or refuses a call on %s, at the exact elapsed point that flips step 4",
    async (_label, buildCase) => {
      // Proves at the call site that `runStep` consults
      // `answerNowAppliesTo(input)`: harness fixtures elsewhere use an attempt
      // timer below the answer reserve, so the budget does not arm. A non-judgment
      // step of the same workflow, at exactly `FLIP_AT_MS`, keeps its tools, gets
      // no ask, and a later call still runs.
      const repositoryPath = await createRepository();
      const { input, reply } = buildCase(repositoryPath);
      const clock = testClock();
      const { requests, fetchMock } = clockedProvider(
        [readTurn(), lateReadTurn(), textTurn(reply)],
        clock,
        { afterRequest: 1, elapsedMs: FLIP_AT_MS },
      );

      const result = await compositionHarness(clock.now).runStep(input);

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(toolCount(requests[1]!)).toBeGreaterThan(0);
      expect(userTexts(requests[1]!).join("\n")).not.toContain(PI_ANSWER_NOW_PROMPT);
      expect(userTexts(requests[2]!).join("\n")).not.toContain(PI_ANSWER_NOW_PROMPT);
      expect(toolResultText(requests[2]!, "answer-now-ls-2")).toContain(TARGET);
      expect(result.executionLease).toMatchObject({ toolCalls: { executed: 2, denied: 0 } });
    },
  );

  it("does not arm at all for a step attempt that carries no attempt timer", async () => {
    // `createAuditHarness` binds no composition policy, so there is no attempt
    // envelope to take a share of, however far the clock has moved.
    const repositoryPath = await createRepository();
    const { input, obligationId } = await provisionalInput(repositoryPath);
    const clock = testClock();
    const { requests, fetchMock } = clockedProvider(
      [readTurn(), textTurn(uncoveredJudgmentReply(obligationId))],
      clock,
      { afterRequest: 1, elapsedMs: ATTEMPT_TIMEOUT_MS * 2 },
    );

    await (await createAuditHarness({ now: clock.now })).runStep(input);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(toolCount(requests[1]!)).toBeGreaterThan(0);
    expect(userTexts(requests[1]!).join("\n")).not.toContain(PI_ANSWER_NOW_PROMPT);
  });

  it("records a front-door refusal of the forced turn exactly as run-e12c5668 recorded it", async () => {
    // A route refusal of the forced turn records the provider error class and
    // status, no retry, and the operator classification, so a live failure of
    // this class can be matched to this test.
    const repositoryPath = await createRepository();
    const { input } = await provisionalInput(repositoryPath);
    const clock = testClock();
    const rejection = () =>
      new Response(
        JSON.stringify({
          error: {
            message: TOOL_HISTORY_REJECTION,
            type: "None",
            param: "None",
            code: String(TOOL_HISTORY_REJECTION_STATUS),
          },
        }),
        {
          status: TOOL_HISTORY_REJECTION_STATUS,
          headers: { "content-type": "application/json" },
        },
      );
    const { requests, fetchMock } = clockedProvider([readTurn(), rejection()], clock, {
      afterRequest: 1,
      elapsedMs: FLIP_AT_MS,
    });
    const harness = compositionHarness(clock.now);

    const execution = await executeInferenceStep({
      mode: input.step.mode,
      policy: parseRetryPolicy({}),
      evidenceIdentity: input.evidenceIdentity,
      sleep: async () => {},
      execute: (attempt) => harness.runStep({ ...input, inferenceAttempt: attempt }),
    });

    expect(execution.status).toBe("failed");
    // The forced turn was sent once, with the tools: the 400 came from the
    // route, not from DocsFab's own request-shape refusal.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requests[1]!.tools).toEqual(requests[0]!.tools);
    expect(execution.evidence.attempts).toHaveLength(1);
    const [attempt] = execution.evidence.attempts;
    expect(attempt).toMatchObject({
      outcome: "invalid-request",
      retryable: false,
      retryScheduled: false,
    });
    expect(attempt!.modelTelemetry?.providerError).toEqual({
      class: "invalid-request",
      httpStatus: TOOL_HISTORY_REJECTION_STATUS,
    });
    expect(classifyInferenceAttempt(attempt)).toEqual({
      class: "unknown",
      layer: "inference",
      code: "invalid-request",
    });
    expect(execution.status === "failed" ? execution.error.message : "").toContain(
      "Model request failed [invalid-request; retryable=false]",
    );
    expect(execution.status === "failed" ? execution.error.message : "").toContain(
      "litellm.UnsupportedParamsError",
    );
  });
});
