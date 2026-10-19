// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { deriveAnswerSubmissionRemainingPlan } from "../src/model-composition/answer-submission-record-fit.js";

describe("deriveAnswerSubmissionRemainingPlan", () => {
  it("uses the largest fixture and per-group maxima without summing per-key maxima", () => {
    const fixtureRows = [
      { fixture: "a", group: 1, type: "dimension", key: "one", rawEnvelopeBytes: 70 },
      { fixture: "a", group: 1, type: "dimension", key: "two", rawEnvelopeBytes: 30 },
      { fixture: "a", group: 2, type: "layer-note", key: "one", rawEnvelopeBytes: 20 },
      { fixture: "b", group: 1, type: "dimension", key: "one", rawEnvelopeBytes: 10 },
      { fixture: "b", group: 1, type: "dimension", key: "two", rawEnvelopeBytes: 90 },
      { fixture: "b", group: 2, type: "layer-note", key: "one", rawEnvelopeBytes: 5 },
    ] as const;

    const result = deriveAnswerSubmissionRemainingPlan({
      fixtureRows,
      remainingKeys: ["dimension:one", "dimension:two", "layer-note:one"],
      completedKeys: [],
      openSets: [],
      complete: false,
      qualifiedMessageBudget: 60,
    });

    expect(result).toEqual({
      openPlanBytes: 120,
      remainingMessages: 3,
      missingRequiredKeys: [],
    });
  });

  it("preserves repeated anonymous rows as separate byte occurrences", () => {
    const result = deriveAnswerSubmissionRemainingPlan({
      fixtureRows: [
        { fixture: "a", group: 4, type: "finding", key: null, rawEnvelopeBytes: 12 },
        { fixture: "a", group: 4, type: "finding", key: null, rawEnvelopeBytes: 15 },
      ],
      remainingKeys: ["finding"],
      completedKeys: [],
      openSets: [{ type: "finding", open: true }],
      complete: false,
      qualifiedMessageBudget: 20,
    });

    expect(result).toEqual({ openPlanBytes: 27, remainingMessages: 2, missingRequiredKeys: [] });
  });

  it("reports an unmapped required key and preserves conservative optional rows", () => {
    const result = deriveAnswerSubmissionRemainingPlan({
      fixtureRows: [
        { fixture: "a", group: 1, type: "target-judgment", key: null, rawEnvelopeBytes: 10 },
        { fixture: "a", group: 4, type: "evaluation-note", key: null, rawEnvelopeBytes: 25 },
      ],
      remainingKeys: ["dimension:unqualified"],
      completedKeys: ["target-judgment"],
      openSets: [],
      complete: false,
      qualifiedMessageBudget: 20,
    });

    expect(result).toEqual({
      openPlanBytes: 25,
      remainingMessages: 2,
      missingRequiredKeys: ["dimension:unqualified"],
    });
  });

  it("does not plan answer-now after the ledger directly reports completion", () => {
    expect(
      deriveAnswerSubmissionRemainingPlan({
        fixtureRows: [
          { fixture: "a", group: 1, type: "target-judgment", key: null, rawEnvelopeBytes: 100 },
        ],
        remainingKeys: [],
        completedKeys: ["target-judgment"],
        openSets: [],
        complete: true,
        qualifiedMessageBudget: 20,
      }),
    ).toEqual({ openPlanBytes: 0, remainingMessages: 0, missingRequiredKeys: [] });
  });
});
