// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { InferenceStepError } from "../src/execution/contracts.js";
import { throwPiAttemptFailure } from "../src/harness/pi-step/attempt-failure.js";
import { ProviderResponseLimitError } from "../src/model/provider.js";
import {
  qualityResponseCorrection,
  recordQualityResponseCorrection,
} from "../src/workflow-execution/quality-response-correction.js";

function failureContext(error: unknown) {
  const complete = vi.fn();
  const stopExecution = vi.fn();
  const collectAttemptEvidence = vi.fn(() => ({}));
  return {
    error,
    sessionEventError: undefined,
    skillExpansionRefusal: undefined,
    inputSignalAborted: false,
    sessionSignalAborted: false,
    attemptTimedOut: false,
    settlementRefusals: new WeakSet<object>(),
    phase: () => "active" as const,
    complete,
    stopExecution,
    credentialRefusedTurns: new WeakMap(),
    responseLimitRefusedTurns: new WeakMap(),
    proxyRefusedTurns: new WeakMap(),
    collectAttemptEvidence,
    redact: (value: unknown) => String(value),
  };
}

describe("Pi attempt failure phase", () => {
  it("completes an already-settled refusal before attaching attempt evidence", () => {
    const rejection = { code: "unsafe-disclosure" as const, location: "$response" };
    const refusal = new InferenceStepError(
      "refused",
      "malformed-response",
      false,
      undefined,
      rejection,
      { condition: "unframed-reply" },
    );
    const correction = {
      kind: "quality-key-set" as const,
      missing: ["summary"],
      undeclared: [],
      withheldCount: 0,
    };
    recordQualityResponseCorrection(refusal, correction);
    const context = failureContext(refusal);
    context.settlementRefusals.add(refusal);
    let caught: unknown;
    try {
      throwPiAttemptFailure(context);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InferenceStepError);
    expect(caught).toMatchObject({
      message: refusal.message,
      category: refusal.category,
      retryable: refusal.retryable,
      evidence: {},
      rejection,
      condition: "unframed-reply",
    });
    expect(qualityResponseCorrection(caught)).toBe(correction);
    expect(context.complete).toHaveBeenCalledOnce();
    expect(context.stopExecution).not.toHaveBeenCalled();
    expect(context.collectAttemptEvidence).toHaveBeenCalledOnce();
  });

  it("retains a typed response limit refusal and terminalizes the lease", () => {
    const refusal = new ProviderResponseLimitError(Buffer.byteLength("oversized"));
    const context = failureContext(refusal);
    let caught: unknown;
    try {
      throwPiAttemptFailure(context);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InferenceStepError);
    expect(caught).toMatchObject({ category: "provider-terminal", retryable: false });
    expect(context.stopExecution).toHaveBeenCalledWith("provider-terminal", "provider-failed");
    expect(context.complete).not.toHaveBeenCalled();
    expect((caught as Error).cause).toBe(refusal);
    expect(Object.keys(caught as object)).not.toContain("cause");
    expect(context.collectAttemptEvidence).toHaveBeenCalledWith(refusal);
  });

  it("keeps Pi's wrapped connection error transient while preserving the response limit cause", () => {
    const flattened = new Error("Connection error");
    const refusal = new ProviderResponseLimitError(Buffer.byteLength("oversized"));
    const context = failureContext(flattened);
    context.responseLimitRefusedTurns.set(flattened, refusal);

    expect(() => throwPiAttemptFailure(context)).toThrow(
      expect.objectContaining({
        category: "provider-transient",
        retryable: true,
        cause: refusal,
      }),
    );
    expect(context.stopExecution).toHaveBeenCalledWith("provider-terminal", "provider-failed");
    expect(context.collectAttemptEvidence).toHaveBeenCalledWith(refusal);
  });
});
