// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { PiHarness } from "../src/harness/pi.js";
import { createProviderConnectionFactory } from "../src/model/provider.js";
import {
  validateSourceObligationProposal,
  validateSourceObligationRecordForAdmission,
} from "../src/workflow-execution/source-obligation.js";
import { createSourceObligationAnswerRecordSession } from "../src/harness/source-obligation-answer-records.js";
import {
  createRepository,
  fixtureCompositionExecutionProfile,
  resetSharedTestState,
  skillCrateDirectory,
  scriptedProvider,
  stepInput,
  textTurn,
  toolTurn,
  testTimeoutMs,
  validModelConfig,
} from "./support/pi-harness-session-fixtures.js";
import { TECHNICAL_FACT_DIMENSIONS } from "../src/workflow-execution/review-response.js";

afterEach(resetSharedTestState);

describe("S2 source-obligation Pi route", () => {
  it("settles the admitted production tool route and does not retain a refused parent link", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    const repositoryPath = await createRepository();
    const input = stepInput(repositoryPath);
    const stepInputForSource = {
      ...input,
      step: input.workflow.steps.find((step) => step.id === "derive-source-obligations")!,
    };
    const session = createSourceObligationAnswerRecordSession({
      validateRecord: (type, record, parentStatus) =>
        validateSourceObligationRecordForAdmission(type, record, stepInputForSource, parentStatus),
    });
    const badObligation = {
      sourceLocators: ["src/manual.md:1-2"],
      statement: "This row names a parent that has not been submitted.",
      evidenceClass: "source-observation",
      uncertainty: "The source may be stale.",
      dimensionKey: TECHNICAL_FACT_DIMENSIONS[1],
    };
    const unverifiedReason = "The available source does not establish this fact.";
    const rejectedTurn = toolTurn([
      {
        id: "unknown-parent",
        name: "submit_answer_record",
        arguments: { type: "obligation", record: badObligation },
      },
    ]);
    const dimensionsTurn = toolTurn([
      ...TECHNICAL_FACT_DIMENSIONS.map((dimension, index) => ({
        id: `dimension-${index}`,
        name: "submit_answer_record",
        arguments: {
          type: "dimension",
          key: dimension,
          record: {
            status: index === 0 ? "applicable" : "unverified",
            reason: index === 0 ? "A source obligation is pending." : unverifiedReason,
            sourceLocators: [],
            obligations: [],
          },
        },
      })),
    ]);
    const obligationTurn = toolTurn([
      {
        id: "accepted-obligation",
        name: "submit_answer_record",
        arguments: {
          type: "obligation",
          record: {
            sourceLocators: ["README.md:1-1"],
            statement: "README declares the fixture title.",
            evidenceClass: "source-observation",
            uncertainty: "The title may change.",
            dimensionKey: TECHNICAL_FACT_DIMENSIONS[0],
          },
        },
      },
    ]);
    const closeTurn = toolTurn([
      {
        id: "close-source-obligations",
        name: "submit_answer_record",
        arguments: {
          type: "proposal-note",
          record: { limitations: [unverifiedReason], closed: true },
        },
      },
    ]);
    const provider = vi.fn(
      scriptedProvider([
        rejectedTurn,
        dimensionsTurn,
        obligationTurn,
        closeTurn,
        textTurn("Source ledger closed."),
      ]),
    );
    const profile = fixtureCompositionExecutionProfile({
      maxProviderTurns: 6,
      timeoutMs: 30_000,
      maxResponseBytes: 65_536,
    });
    const harness = new PiHarness({
      skillCrateDirectory,
      executionProfile: profile,
      credential: { family: "nvidia-inference-api", apiKey: validModelConfig.apiKey },
      providerConnectionFactory: createProviderConnectionFactory({
        routeId: profile.routeId,
        transport: profile.transport,
        fetch: provider,
      }),
    });

    await expect(
      harness.runStep({
        ...stepInputForSource,
        qualityAnswerRecords: {} as NonNullable<typeof stepInputForSource.qualityAnswerRecords>,
        sourceObligationAnswerRecords: session.capability,
        sourceObligationAnswerRecordCallCeiling: session.recordCallCeiling,
        sourceObligationAnswerRecordGuidance: session.promptGuidance,
      }),
    ).rejects.toThrow(/cannot bind quality and source-obligation/u);
    expect(provider).not.toHaveBeenCalled();

    const result = await harness.runStep({
      ...stepInputForSource,
      sourceObligationAnswerRecords: session.capability,
      sourceObligationAnswerRecordCallCeiling: session.recordCallCeiling,
      sourceObligationAnswerRecordGuidance: session.promptGuidance,
    });

    expect(result.sourceObligationProposal).toBeDefined();
    const validated = validateSourceObligationProposal(
      result.sourceObligationProposal,
      stepInputForSource,
    );
    expect(validated.dimensions).toHaveLength(TECHNICAL_FACT_DIMENSIONS.length);
    expect(session.snapshot().rows.size).toBe(8);
    expect([...session.snapshot().refusals.values()]).toEqual([1]);
    expect(JSON.stringify([...session.snapshot().rows.values()])).not.toContain(
      badObligation.statement,
    );
    expect(validated.dimensions[0]?.obligations).toEqual([
      expect.objectContaining({
        statement: "README declares the fixture title.",
        sourceLocators: ["README.md:1-1"],
      }),
    ]);
    expect(result.sourceObligationProposal?.dimensions).toHaveLength(
      TECHNICAL_FACT_DIMENSIONS.length,
    );
    expect(provider).toHaveBeenCalledTimes(5);
  });

  it("settles returned semantic refusal receipts through the declared exhaustion bound", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    const repositoryPath = await createRepository();
    const input = stepInput(repositoryPath);
    const stepInputForSource = {
      ...input,
      step: input.workflow.steps.find((step) => step.id === "derive-source-obligations")!,
    };
    const session = createSourceObligationAnswerRecordSession({
      validateRecord: (type, record, parentStatus) =>
        validateSourceObligationRecordForAdmission(type, record, stepInputForSource, parentStatus),
    });
    const dimension = TECHNICAL_FACT_DIMENSIONS[0]!;
    const invalidRow = {
      sourceLocators: ["README.md:1-1"],
      statement: "This obligation conflicts with its not-applicable parent.",
      evidenceClass: "source-observation",
      uncertainty: "The source may be stale.",
      dimensionKey: dimension,
    };
    const dimensionTurn = toolTurn(
      TECHNICAL_FACT_DIMENSIONS.map((key, index) => ({
        id: `dimension-${index}`,
        name: "submit_answer_record",
        arguments: {
          type: "dimension",
          key,
          record: {
            status: index === 0 ? "not-applicable" : "unverified",
            reason:
              index === 0
                ? "This source is outside the review target."
                : "Not established by the source.",
            sourceLocators: index === 0 ? ["README.md:1-1"] : [],
            obligations: [],
          },
        },
      })),
    );
    const refusalCount = session.snapshot().plan.maxRefusalsPerKey + 1;
    const refusalTurns = Array.from({ length: refusalCount }, (_, index) => ({
      id: `semantic-refusal-${index}`,
      turn: toolTurn([
        {
          id: `semantic-refusal-call-${index}`,
          name: "submit_answer_record",
          arguments: { type: "obligation", record: invalidRow },
        },
      ]),
    }));
    const provider = vi.fn(
      scriptedProvider([dimensionTurn, ...refusalTurns.map(({ turn }) => turn), textTurn("Done.")]),
    );
    const profile = fixtureCompositionExecutionProfile({
      maxProviderTurns: session.recordCallCeiling,
      timeoutMs: 30_000,
      maxResponseBytes: 65_536,
    });
    const harness = new PiHarness({
      skillCrateDirectory,
      executionProfile: profile,
      credential: { family: "nvidia-inference-api", apiKey: validModelConfig.apiKey },
      providerConnectionFactory: createProviderConnectionFactory({
        routeId: profile.routeId,
        transport: profile.transport,
        fetch: provider,
      }),
    });

    await expect(
      harness.runStep({
        ...stepInputForSource,
        sourceObligationAnswerRecords: session.capability,
        sourceObligationAnswerRecordCallCeiling: session.recordCallCeiling,
        sourceObligationAnswerRecordGuidance: session.promptGuidance,
      }),
    ).rejects.toThrow(/incomplete/u);
    expect(session.capability.receipt(`semantic-refusal-call-${refusalCount - 1}`)).toMatchObject({
      status: "refused",
      code: "answer-record-exhausted",
      retry: "terminal",
    });
    expect(session.snapshot().exhausted).toEqual({ type: "obligation", key: null });
    expect(session.snapshot().rows.has("obligation\u0000O-1")).toBe(false);
    expect(provider).toHaveBeenCalledTimes(refusalCount + 2);
  });
});
