// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Inference refusal identity, evidence conversion, and harness result validation.

import type { InferenceRejectedReplyExcerptV1 } from "../rejected-reply-excerpt.js";
import type { InferenceRejectedReplyShapeV1 } from "../rejected-reply-shape.js";
import type {
  ModelEvidence,
  TokenUsage,
  ToolActivitySummary,
  InferenceFailureCategory,
  InferenceFailureCondition,
  InferenceAttemptEvidence,
  InferenceAttemptModelTelemetryV1,
  InferenceTurnEvidence,
  InferenceConcludeNowEvidenceV1,
  InferenceAnswerSubmissionEvidenceV1,
  InferenceDeadlineTurn,
} from "../../records/contracts.js";
import type { ExecutionLeaseRuntimeEvidenceV1, HarnessStepResult } from "./harness-protocol.js";

/**
 * Operator-envelope `.code` for each {@link InferenceFailureCategory}.
 * Identity mapping — keep the inference taxonomy; do not flatten onto one code.
 */
export const INFERENCE_STEP_ERROR_CODES = {
  "blank-response": "blank-response",
  "malformed-response": "malformed-response",
  "context-exhausted": "context-exhausted",
  timeout: "timeout",
  throttled: "throttled",
  "provider-transient": "provider-transient",
  "invalid-request": "invalid-request",
  "provider-terminal": "provider-terminal",
  "host-runtime-failure": "host-runtime-failure",
  "no-progress": "no-progress",
} as const satisfies Record<InferenceFailureCategory, InferenceFailureCategory>;

/**
 * Which host-owned validation refused a response (`code`), and where in the
 * response contract it lives (`location`), both from the raising decoder's
 * closed vocabulary.
 *
 * Content-free by construction: neither field may carry response text, host
 * paths, or credential material. The record-boundary bound and grammar live in
 * `config/inference-rejection-limits.ts`.
 */
export interface InferenceRejectionReasonV1 {
  readonly code: string;
  readonly location: string;
}

export class InferenceStepError extends Error {
  public readonly category: InferenceFailureCategory;
  public readonly hostFailureOrigin?: InferenceAttemptEvidence["hostFailureOrigin"];
  public readonly retryable: boolean;
  public readonly evidence?: {
    model?: ModelEvidence;
    usage?: TokenUsage;
    tools?: ToolActivitySummary;
    writeSettlement?: InferenceAttemptEvidence["writeSettlement"];
    turns?: InferenceTurnEvidence[];
    executionLease?: ExecutionLeaseRuntimeEvidenceV1;
    /** Closed per-attempt model telemetry for the failed attempt. */
    modelTelemetry?: InferenceAttemptModelTelemetryV1;
    providerResponses?: InferenceAttemptEvidence["providerResponses"];
    efficiency?: InferenceAttemptEvidence["efficiency"];
    concludeNow?: InferenceConcludeNowEvidenceV1;
    deadlineTurn?: InferenceDeadlineTurn;
    answerSubmission?: InferenceAnswerSubmissionEvidenceV1;
  };
  public readonly rejection?: InferenceRejectionReasonV1;
  /**
   * Content-free structural fingerprint of the rejected reply, attached once
   * after every decoder wrap (`retainRejectedReplyShape`). Never reply text.
   */
  public rejectedReplyShape?: InferenceRejectedReplyShapeV1;
  /** Bounded, redacted excerpt of the same reply, attached with the fingerprint. */
  public rejectedReplyExcerpt?: InferenceRejectedReplyExcerptV1;
  /**
   * What the rule refused, as paths the host already knows; recorded beside
   * `rejection` on the attempt, never in a retry prompt. Rewraps forward it.
   */
  public readonly rejectionSubject?: import("../rejection-subject.js").InferenceRejectionSubjectV1;
  public readonly condition?: InferenceFailureCondition;
  public readonly code: InferenceFailureCategory;
  public constructor(
    message: string,
    category: InferenceFailureCategory,
    retryable: boolean,
    evidence?: {
      model?: ModelEvidence;
      usage?: TokenUsage;
      tools?: ToolActivitySummary;
      writeSettlement?: InferenceAttemptEvidence["writeSettlement"];
      turns?: InferenceTurnEvidence[];
      executionLease?: ExecutionLeaseRuntimeEvidenceV1;
      modelTelemetry?: InferenceAttemptModelTelemetryV1;
      providerResponses?: InferenceAttemptEvidence["providerResponses"];
      efficiency?: InferenceAttemptEvidence["efficiency"];
      concludeNow?: InferenceConcludeNowEvidenceV1;
      deadlineTurn?: InferenceDeadlineTurn;
      answerSubmission?: InferenceAnswerSubmissionEvidenceV1;
      hostFailureOrigin?: InferenceAttemptEvidence["hostFailureOrigin"];
    },
    /**
     * Absent means the decoder records no coded reason. Host wraps must copy
     * it forward or the reason is lost.
     */
    rejection?: InferenceRejectionReasonV1,
    /**
     * The host's failure condition. Every rewrap passes the wrapped error's
     * condition through `inferenceFailureConditionOf`, or the retry rule
     * loses it.
     */
    options?: {
      readonly condition?: InferenceFailureCondition;
      readonly rejectionSubject?: import("../rejection-subject.js").InferenceRejectionSubjectV1;
      readonly hostFailureOrigin?: InferenceAttemptEvidence["hostFailureOrigin"];
    },
  ) {
    super(message);
    this.category = category;
    this.retryable = retryable;
    this.evidence = evidence;
    this.rejection = rejection;
    if (options?.condition !== undefined) this.condition = options.condition;
    if (options?.rejectionSubject !== undefined) this.rejectionSubject = options.rejectionSubject;
    if (options?.hostFailureOrigin !== undefined)
      this.hostFailureOrigin = options.hostFailureOrigin;
    this.name = "InferenceStepError";
    this.code = INFERENCE_STEP_ERROR_CODES[category];
  }
}

/** The condition a rewrap must carry forward; `undefined` for any other error. */
export function inferenceFailureConditionOf(error: unknown): {
  readonly condition?: InferenceFailureCondition;
} {
  return error instanceof InferenceStepError && error.condition !== undefined
    ? { condition: error.condition }
    : {};
}

/**
 * The provider evidence of one harness attempt, so an attempt the host refuses
 * after the harness returned still records the model, usage, and tools it used.
 */
export function harnessAttemptEvidence(result: HarnessStepResult): InferenceStepError["evidence"] {
  return {
    ...(result.model ? { model: result.model } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.tools ? { tools: result.tools } : {}),
    ...(result.writeSettlement ? { writeSettlement: result.writeSettlement } : {}),
    ...(result.turns ? { turns: result.turns } : {}),
    ...(result.executionLease ? { executionLease: result.executionLease } : {}),
    ...(result.modelTelemetry ? { modelTelemetry: result.modelTelemetry } : {}),
    ...(result.providerResponses ? { providerResponses: result.providerResponses } : {}),
    ...(result.efficiency ? { efficiency: result.efficiency } : {}),
  };
}

/**
 * Validate a harness's textual result before it is recorded as a successful
 * step. Protocol-shaped text (an unexecuted `<tool_call>` block) or a
 * skill-unavailable report is not usable evidence. The error record retains
 * no provider response text.
 */
export function assertUsableHarnessStepResult(result: unknown): HarnessStepResult {
  if (!result || typeof result !== "object") {
    throw new InferenceStepError(
      "The model returned a malformed harness step result.",
      "malformed-response",
      true,
    );
  }
  const summary = (result as Record<string, unknown>).summary;
  if (typeof summary !== "string") {
    throw new InferenceStepError(
      "The model returned a malformed harness step result.",
      "malformed-response",
      true,
    );
  }
  if (!summary.trim()) {
    throw new InferenceStepError(
      "The model returned an empty harness response body.",
      "blank-response",
      true,
    );
  }
  if (UNPARSED_TOOL_CALL_LITERAL.test(summary)) {
    throw new InferenceStepError(
      "Model returned an unparsed tool call instead of usable step evidence.",
      "malformed-response",
      true,
    );
  }
  if (UNAVAILABLE_SKILL_REPORT.test(summary)) {
    throw new InferenceStepError(
      "Model reported that the requested skill is unavailable.",
      "provider-terminal",
      false,
    );
  }
  return result as HarnessStepResult;
}

const UNPARSED_TOOL_CALL_LITERAL = /^\s*<tool_call\b[\s\S]*?<\/tool_call>\s*$/iu;
const UNAVAILABLE_SKILL_REPORT =
  /^\s*(?:the\s+)?(?:requested\s+)?skill\b[^.!?\n]{0,100}\b(?:is\s+)?(?:not\s+available|unavailable|missing)\b[\s\S]{0,2000}\s*$/iu;
