// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The record the writer produces when a transport fault falls between a
 * no-progress stop and its conclude-now retry: the throttled attempt re-sends
 * the conclude-now correction, so the attempt after it withdraws the tools
 * and records `concludeNow`. Each record validator suite feeds this evidence
 * through its own reader. No request leaves the host.
 */
import { parseRetryPolicy } from "../../src/config/retry-policy.js";
import type { HarnessStepInput, InferenceRetryPolicy } from "../../src/execution/contracts.js";
import { InferenceStepError } from "../../src/execution/contracts.js";
import type { InferenceExecutionEvidence } from "../../src/records/contracts.js";
import { concludesNow } from "../../src/records/inference-retry-rule-vocabulary.js";
import { executeInferenceStep } from "../../src/workflow-execution/retry.js";

/** The error the harness raises at the read-loop stop. */
export function readLoopStop(): InferenceStepError {
  return new InferenceStepError(
    "execution-read-loop-withheld-reads-bound: 9 exceeds execution.readLoopWithheldReads = 8 count.",
    "no-progress",
    true,
    undefined,
    { code: "execution-read-loop-withheld-reads-bound", location: "$.tools" },
  );
}

export function throttle(): InferenceStepError {
  return new InferenceStepError("provider throttled the request", "throttled", true);
}

export type ScriptedAttempt = (() => InferenceStepError) | "ok";

/**
 * Run the real retry writer over `script`. A succeeded attempt records
 * `concludeNow` only when its correction names a conclude-now rule, as the
 * harness does, so a stub cannot make an inconsistent record valid.
 *
 * The writer reads a clock this helper owns, advanced one millisecond per
 * reading, so every recorded `durationMs` depends on the script alone and two
 * runs of one script write the same record, however loaded the host is.
 */
export async function runScriptedInferenceStep(
  script: readonly ScriptedAttempt[],
  overrides: Partial<InferenceRetryPolicy> = {},
) {
  const corrections: Array<HarnessStepInput["responseCorrection"]> = [];
  let clock = 0;
  const execution = await executeInferenceStep({
    mode: "read-only",
    policy: { ...parseRetryPolicy({}), baseDelayMs: 0, maxDelayMs: 0, ...overrides },
    sleep: async () => {},
    now: () => (clock += 1),
    execute: async (attempt, correction) => {
      corrections.push(correction);
      const step = script[attempt - 1];
      if (step === undefined) throw new Error(`no scripted attempt ${attempt}`);
      if (step === "ok") {
        return concludesNow(correction?.retryRule)
          ? { summary: "admitted", concludeNow: { trigger: "read-loop" as const, turn: 3 } }
          : { summary: "admitted" };
      }
      throw step();
    },
  });
  return { execution, corrections };
}

/** `[no-progress, throttled, ok]`: the conclude-now retry lands after a transport retry. */
export async function concludeNowAfterTransportEvidence(
  overrides: Partial<InferenceRetryPolicy> = {},
): Promise<InferenceExecutionEvidence> {
  const { execution } = await runScriptedInferenceStep([readLoopStop, throttle, "ok"], overrides);
  if (execution.status !== "succeeded") throw new Error("the scripted step did not succeed");
  return execution.evidence;
}
