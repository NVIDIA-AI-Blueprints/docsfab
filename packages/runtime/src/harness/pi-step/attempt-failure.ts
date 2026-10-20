// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Preserve coded provider failures and exact lease settlement on a failed prompt. */
import { WORKFLOW_CANCELLED } from "../../execution/cancellation.js";
import {
  inferenceFailureConditionOf,
  InferenceStepError,
  type ExecutionLeaseRuntimeTerminalDisposition,
} from "../../execution/contracts.js";
import type { ExecutionTerminalReason } from "../../execution/index.js";
import { classifyModelFailure } from "../../model/context-budget.js";
import type { OutboundProxyRefusal } from "../../model/outbound-http-policy.js";
import { ProviderResponseLimitError } from "../../model/provider.js";
import type { CredentialBoundaryError } from "../../security/credential-isolation.js";
import { copyQualityResponseCorrection } from "../../workflow-execution/quality-response-correction.js";

interface PiAttemptFailureContext {
  readonly error: unknown;
  readonly sessionEventError: unknown;
  readonly skillExpansionRefusal?: InferenceStepError;
  readonly inputSignalAborted: boolean;
  readonly sessionSignalAborted: boolean;
  readonly attemptTimedOut: boolean;
  readonly settlementRefusals: WeakSet<object>;
  readonly phase: () => "active" | "batch-pending" | "checkpoint-required" | "terminal";
  readonly complete: () => void;
  readonly stopExecution: (
    reason: Exclude<ExecutionTerminalReason, "completed">,
    disposition?: Exclude<ExecutionLeaseRuntimeTerminalDisposition, "completed">,
  ) => void;
  readonly credentialRefusedTurns: WeakMap<Error, CredentialBoundaryError>;
  readonly responseLimitRefusedTurns: WeakMap<Error, ProviderResponseLimitError>;
  readonly proxyRefusedTurns: WeakMap<Error, OutboundProxyRefusal>;
  readonly lastResponseLimitRefusal?: () => ProviderResponseLimitError | undefined;
  readonly collectAttemptEvidence: (
    selectedResponseLimit?: ProviderResponseLimitError,
  ) => NonNullable<InferenceStepError["evidence"]>;
  readonly redact: (error: unknown) => string;
}

export function throwPiAttemptFailure({
  error,
  sessionEventError,
  skillExpansionRefusal,
  inputSignalAborted,
  sessionSignalAborted,
  attemptTimedOut,
  settlementRefusals,
  phase,
  complete,
  stopExecution,
  credentialRefusedTurns,
  responseLimitRefusedTurns,
  proxyRefusedTurns,
  lastResponseLimitRefusal,
  collectAttemptEvidence,
  redact,
}: PiAttemptFailureContext): never {
  const checkpointCoordinatorFailure =
    sessionEventError instanceof InferenceStepError &&
    sessionEventError.category === "host-runtime-failure";
  const primaryError =
    inputSignalAborted && !checkpointCoordinatorFailure
      ? new Error(WORKFLOW_CANCELLED)
      : (skillExpansionRefusal ?? sessionEventError ?? error);
  // A submission refused at its turn's settlement is the attempt's own
  // contract outcome, not a provider failure: it keeps its message,
  // code, condition, and retry repair, and gains the attempt evidence.
  if (primaryError instanceof InferenceStepError && settlementRefusals.has(primaryError)) {
    // The provider work completed and the answer was refused, as when a
    // text answer is refused after its last turn; a cut has already
    // stopped the lease.
    if (phase() === "active" || phase() === "checkpoint-required") {
      complete();
    } else if (phase() !== "terminal") {
      stopExecution("provider-terminal", "provider-failed");
    }
    const refusal = new InferenceStepError(
      primaryError.message,
      primaryError.category,
      primaryError.retryable,
      collectAttemptEvidence(),
      primaryError.rejection,
      inferenceFailureConditionOf(primaryError),
    );
    copyQualityResponseCorrection(primaryError, refusal);
    throw refusal;
  }
  if (
    primaryError instanceof InferenceStepError &&
    primaryError.category === "host-runtime-failure"
  ) {
    throw new InferenceStepError(
      primaryError.message,
      primaryError.category,
      false,
      collectAttemptEvidence(),
      undefined,
      { hostFailureOrigin: primaryError.hostFailureOrigin },
    );
  }
  let terminalizationError: unknown;
  if (phase() !== "terminal") {
    try {
      const failure = classifyModelFailure(primaryError);
      if (attemptTimedOut) {
        // The deadline fired before the provider returned attributable
        // usage. Do not invent elapsed lease evidence.
        stopExecution("provider-terminal", "provider-failed");
      } else if (inputSignalAborted || sessionSignalAborted) {
        stopExecution("cancellation-requested", "cancelled");
      } else if (failure.category === "context-exhausted") {
        stopExecution("context-exhausted", "context-exhausted");
      } else {
        stopExecution("provider-terminal", "provider-failed");
      }
    } catch (candidate) {
      terminalizationError = candidate;
    }
  }
  // Handles only an attempt whose first error is the turn a proxy
  // refused with 403 or 407, or a proxy setting refused as invalid or
  // not turned on: each answers the same on every retry, so the step
  // ends with the refusal's own code. A cancellation, or an attempt
  // timer that fired before any turn reported an error, is a different
  // primary error and keeps its outcome; a failed lease terminalization
  // keeps its combined report; an unreachable proxy may recover, so it
  // stays as the text rule reads it.
  // A turn DocsFab refused because the request payload or the provider's
  // response held one of its own configured credentials ends the
  // step with that refusal, coded, rather than as a connection error a
  // retry would repeat.
  const credentialRefusal =
    primaryError instanceof Error ? credentialRefusedTurns.get(primaryError) : undefined;
  if (credentialRefusal !== undefined && terminalizationError === undefined) {
    const coded = new InferenceStepError(
      `Model request failed [provider-terminal; retryable=false]: ${credentialRefusal.message}`,
      "provider-terminal",
      false,
      collectAttemptEvidence(),
    );
    // The failure class and next action are read from the refusal's
    // code. Non-enumerable, so no record or log copies the refusal.
    Object.defineProperty(coded, "cause", {
      value: credentialRefusal,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    throw coded;
  }
  const responseLimit =
    (primaryError instanceof ProviderResponseLimitError
      ? primaryError
      : primaryError instanceof Error
        ? responseLimitRefusedTurns.get(primaryError)
        : undefined) ??
    (primaryError === error &&
    skillExpansionRefusal === undefined &&
    sessionEventError === undefined
      ? lastResponseLimitRefusal?.()
      : undefined);
  if (responseLimit !== undefined) {
    // Pi may flatten the typed refusal into a connection error. Preserve the
    // primary transport retry policy while retaining the typed cause/evidence.
    const failure = classifyModelFailure(primaryError);
    const coded = new InferenceStepError(
      `Model request failed [${failure.category}; retryable=${failure.retryable}]: ${responseLimit.message}${
        terminalizationError === undefined ? "" : " (lease terminalization also failed)"
      }`,
      failure.category,
      failure.retryable,
      collectAttemptEvidence(responseLimit),
    );
    Object.defineProperty(coded, "cause", {
      value:
        terminalizationError === undefined
          ? responseLimit
          : new AggregateError(
              [responseLimit, terminalizationError],
              "Provider response limit and lease terminalization both failed.",
            ),
      enumerable: false,
      writable: false,
      configurable: false,
    });
    throw coded;
  }
  const proxyRefusal =
    primaryError instanceof Error ? proxyRefusedTurns.get(primaryError) : undefined;
  if (
    proxyRefusal !== undefined &&
    proxyRefusal.kind !== "unreachable" &&
    terminalizationError === undefined
  ) {
    const coded = new InferenceStepError(
      `Model request failed [provider-terminal; retryable=false]: ${redact(proxyRefusal)}`,
      "provider-terminal",
      false,
      collectAttemptEvidence(),
    );
    // The failure class is read from the refusal's code. Non-enumerable,
    // so no record or log copies the refusal.
    Object.defineProperty(coded, "cause", {
      value: proxyRefusal,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    throw coded;
  }
  const failure = classifyModelFailure(primaryError);
  const reportedError =
    terminalizationError === undefined
      ? primaryError
      : new AggregateError(
          [primaryError, terminalizationError],
          "Provider/runtime failure and exact lease terminalization both failed.",
        );
  throw new InferenceStepError(
    `Model request failed [${failure.category}; retryable=${failure.retryable}]: ${redact(reportedError)}`,
    failure.category,
    failure.retryable,
    collectAttemptEvidence(),
    // Carry the coded rejection of a cut turn through the wrap.
    primaryError instanceof InferenceStepError ? primaryError.rejection : undefined,
    // The host's own attempt timer is a different condition from a
    // provider timeout; the record keeps which one fired.
    attemptTimedOut && failure.category === "timeout"
      ? { condition: "attempt-deadline" }
      : inferenceFailureConditionOf(primaryError),
  );
}
