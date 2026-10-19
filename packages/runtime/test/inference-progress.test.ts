// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { decodeInferenceProgressObservation } from "../src/records/inference-progress.js";

const progress = {
  schemaVersion: 1,
  kind: "docsfab-inference-progress-observation",
  attempt: 1,
  observedAt: "2026-10-10T12:00:00.000Z",
  event: "provider-turn-settled",
  phase: "provider-turn-settled",
  providerTurns: { started: 1, settled: 1 },
  toolExecutions: { started: 2, settled: 1 },
  usage: { input: 12, output: 4, cacheRead: 3, cacheWrite: 1, total: 20, turns: 1 },
} as const;

describe("inference progress observations", () => {
  it("accepts content-free cumulative boundary and token counters", () => {
    expect(decodeInferenceProgressObservation(progress)).toEqual(progress);
  });

  it("accepts optional fixed tool-activity categories and keeps old observations valid", () => {
    const activity = {
      answerRecord: { started: 0, settled: 0, errorResults: 0 },
      reportSubmission: { started: 0, settled: 0, errorResults: 0 },
      candidateValidation: { started: 0, settled: 0, errorResults: 0 },
      readSearch: { started: 1, settled: 1, errorResults: 0 },
      other: { started: 1, settled: 0, errorResults: 0 },
    };
    expect(decodeInferenceProgressObservation({ ...progress, toolActivity: activity })).toEqual({
      ...progress,
      toolActivity: activity,
    });
    expect(decodeInferenceProgressObservation(progress).toolActivity).toBeUndefined();
  });

  it.each([
    { ...progress, providerTurns: { started: 1, settled: 2 } },
    { ...progress, usage: { ...progress.usage, output: -1 } },
    { ...progress, usage: { ...progress.usage, total: 19 } },
    { ...progress, usage: { ...progress.usage, total: 21 } },
    { ...progress, usage: { ...progress.usage, cacheRead: 4 } },
    {
      ...progress,
      usage: {
        ...progress.usage,
        input: Number.MAX_SAFE_INTEGER,
        output: 0,
        cacheRead: 1,
        cacheWrite: 0,
        total: Number.MAX_SAFE_INTEGER,
      },
    },
    { ...progress, prompt: "must not be retained" },
    { ...progress, observedAt: "not-a-time" },
    {
      ...progress,
      toolActivity: {
        answerRecord: { started: 0, settled: 0, errorResults: 0 },
        reportSubmission: { started: 0, settled: 0, errorResults: 0 },
        candidateValidation: { started: 0, settled: 0, errorResults: 0 },
        readSearch: { started: 1, settled: 1, errorResults: 0 },
        other: { started: 1, settled: 0, errorResults: 0 },
        arbitrary: { started: 0, settled: 0, errorResults: 0 },
      },
    },
    {
      ...progress,
      toolActivity: {
        answerRecord: { started: 0, settled: 0, errorResults: 0 },
        reportSubmission: { started: 0, settled: 0, errorResults: 0 },
        candidateValidation: { started: 0, settled: 0, errorResults: 0 },
        readSearch: { started: 1, settled: 1, errorResults: 2 },
        other: { started: 1, settled: 0, errorResults: 0 },
      },
    },
    {
      ...progress,
      toolActivity: {
        answerRecord: { started: 0, settled: 0, errorResults: 0 },
        reportSubmission: { started: 0, settled: 0, errorResults: 0 },
        candidateValidation: { started: 0, settled: 0, errorResults: 0 },
        readSearch: { started: 1, settled: 2, errorResults: 0 },
        other: { started: 0, settled: 0, errorResults: 0 },
      },
    },
    {
      ...progress,
      toolActivity: {
        answerRecord: { started: 0, settled: 0, errorResults: 0, rawToolName: "read" },
        reportSubmission: { started: 0, settled: 0, errorResults: 0 },
        candidateValidation: { started: 0, settled: 0, errorResults: 0 },
        readSearch: { started: 1, settled: 1, errorResults: 0 },
        other: { started: 1, settled: 0, errorResults: 0 },
      },
    },
    {
      ...progress,
      toolActivity: {
        answerRecord: { started: 0, settled: 0, errorResults: 0 },
        reportSubmission: { started: 0, settled: 0, errorResults: 0 },
        candidateValidation: { started: 0, settled: 0, errorResults: 0 },
        readSearch: { started: 1, settled: 1, errorResults: 0 },
        other: { started: 0, settled: 0, errorResults: 0 },
      },
    },
    {
      ...progress,
      event: "tool-execution-started",
      phase: "tool-execution-active",
      toolExecutions: { started: 1, settled: 1 },
    },
    {
      ...progress,
      event: "tool-execution-settled",
      phase: "tool-execution-active",
      toolExecutions: { started: 1, settled: 1 },
    },
    {
      ...progress,
      event: "tool-execution-settled",
      phase: "tool-execution-settled",
      toolExecutions: { started: 2, settled: 1 },
    },
  ])("rejects malformed progress evidence", (candidate) => {
    expect(() => decodeInferenceProgressObservation(candidate)).toThrow(
      "The inference progress observation does not satisfy its closed schema.",
    );
  });
});
