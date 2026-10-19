// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Whether a first-pass rejection may be corrected before the request stops.
 *
 * `model-correctable`: the answer broke a rule the first-pass prompt states,
 * and a hinted correction round in the knowledge first pass can repair it, up
 * to `retry.maxRetries` rounds per request. A test keeps the knowledge
 * `FIRST_PASS_CORRECTIONS` hint keys equal to this set. Every check still
 * applies to every answer.
 *
 * `terminal`: security, authority, operator input, producer defects,
 * infrastructure, bounds, and answers no rule can be stated for. They stop the
 * request whatever budget remains.
 *
 * A dependency-free leaf; it imports one type only.
 */
import type { FirstPassFailureRule } from "./pre-record-failure.js";

export type FirstPassRejectionRetryability = "model-correctable" | "terminal";

export interface FirstPassRejectionRetryabilityEntry {
  readonly retry: FirstPassRejectionRetryability;
  readonly reason: string;
}

const correctable = (
  reason: string,
): FirstPassRejectionRetryabilityEntry & { readonly retry: "model-correctable" } =>
  Object.freeze({ retry: "model-correctable", reason });
const terminal = (
  reason: string,
): FirstPassRejectionRetryabilityEntry & { readonly retry: "terminal" } =>
  Object.freeze({ retry: "terminal", reason });

const PRODUCER = terminal(
  "DocsFab's own first-pass binding failed; no model answer can repair a host defect.",
);
const MODEL_ACCESS = terminal(
  "The governed model could not be reached or stopped abnormally; the operator recovers access, not the model's answer.",
);
const BOUND = terminal(
  "A configured first-pass bound was reached; another model turn would spend past it.",
);
const UNSTATED = terminal("The refusal names no finer rule, so no hint can state what to repair.");

export const FIRST_PASS_REJECTION_RETRYABILITY = Object.freeze({
  // Assessment answer rules. The hint names the rule and location.
  "evidence-span-binding": correctable(
    "An assessment cites a span that was not offered, or repeats one. The hint names each offending span ID and the offered span ID set, both host-owned.",
  ),
  "obligation-binding": correctable(
    "An assessment names an obligation that is unknown or repeated; the prompt lists the mandatory obligation IDs.",
  ),
  "decomposition-omission": correctable(
    "The assessment omitted a mandatory obligation; the prompt lists every one it must assess.",
  ),
  status: correctable("An assessment status is outside the five the prompt states."),
  "detail-shape": correctable("An assessment detail exceeds the bound the hint states."),
  "contradiction-sides": correctable(
    "A contradicted assessment's sides break the shape the prompt states: too few or too many, a span the assessment does not cite, an empty or oversized value, or no two values that differ.",
  ),
  // Shape rules shared by every model phase.
  "schema-v1": correctable(
    "The answer's schema version or top-level shape differs from the prompt's.",
  ),
  "closed-schema": correctable("The answer adds or omits a documented key."),
  // Obligation rules.
  "completion-consistency": correctable(
    "The completeness flag contradicts the answer's own list of omissions.",
  ),
  "obligation-shape": correctable(
    "A proposed obligation breaks the id, origin, condition, or type contract the prompt states.",
  ),
  "target-binding": correctable(
    "A proposed obligation names a target outside Exact write targets, which the prompt lists.",
  ),
  "authority-expansion": correctable(
    "Wording hygiene on an inferred condition (#1123): the host, not this check, is the authority boundary, and the hint asks the model to rephrase or drop the item.",
  ),
  "explicit-quote-binding": correctable(
    "An explicit obligation does not quote the instruction verbatim; the prompt carries the instruction.",
  ),
  "inferred-origin-binding": correctable("An inferred obligation carries a request quote."),
  "evidence-status-inference": correctable(
    "A proposed omission infers evidence status instead of naming a requirement.",
  ),
  // Answers that are not the JSON the prompt asks for.
  "strict-json": correctable(
    "The answer is not strict JSON; the hint asks for one JSON object with nothing around it.",
  ),
  "assessment-binding-response-json": correctable(
    "The runtime model boundary could not parse the assessment answer as JSON; the hint asks for one JSON object with nothing around it.",
  ),
  "assessment-binding-response-shape": correctable(
    "The assessment answer is a JSON value other than an object; the prompt states the object shape.",
  ),
  "assessment-binding-response-rows": correctable(
    "The assessment answer has no assessments array; the prompt states it.",
  ),
  "response-truncated": correctable(
    "The answer reached the output bound (finish reason length) before its JSON closed; the hint asks for the complete answer in fewer tokens, and the bound is unchanged.",
  ),
  "response-size": terminal(
    "The answer was empty or larger than the first-pass bound; #1123 does not re-ask it.",
  ),
  "invalid-response": UNSTATED,
  "assessment-invalid": UNSTATED,
  // Security and authority.
  "credential-material": terminal(
    "A configured credential in the request or evidence is a security refusal and is never re-asked.",
  ),
  "unsafe-target": terminal("An unsafe or out-of-root target is an authority refusal (#1128)."),
  // Operator input and planning.
  "bound-source-unavailable": terminal(
    "A selected source is not readable at the revision; only the operator can fix the selection.",
  ),
  "insufficient-evidence": terminal(
    "No admissible evidence supports the request; a model answer cannot add evidence.",
  ),
  // DocsFab producer defects.
  "assessment-binding-prompt-shape": PRODUCER,
  "assessment-binding-provenance": PRODUCER,
  "assessment-binding-source-spans": PRODUCER,
  "identity-binding": PRODUCER,
  "identity-shape": PRODUCER,
  "evidence-frame-nonce-source": PRODUCER,
  // Infrastructure.
  "model-unavailable": MODEL_ACCESS,
  "model-connection-failed": MODEL_ACCESS,
  "model-profile-unavailable": MODEL_ACCESS,
  "provider-call-failed": MODEL_ACCESS,
  "provider-stop-reason": MODEL_ACCESS,
  // Bounds.
  "budget-exhausted": BOUND,
  "model-cumulative-token-budget-exhausted": BOUND,
  "model-deadline-exhausted": BOUND,
  "model-input-budget-exhausted": BOUND,
  "model-turn-budget-exhausted": BOUND,
  "output-policy-limit": terminal(
    "The output cap is below the request policy's minimum; the host administrator changes the policy or profile.",
  ),
  "repository-read-budget-exhausted": BOUND,
  "repository-read-deadline-exhausted": BOUND,
} as const satisfies Record<FirstPassFailureRule, FirstPassRejectionRetryabilityEntry>);

/** Rules the table lets a hinted correction round repair. */
export type ModelCorrectableFirstPassRule = {
  [Rule in FirstPassFailureRule]: (typeof FIRST_PASS_REJECTION_RETRYABILITY)[Rule]["retry"] extends "model-correctable"
    ? Rule
    : never;
}[FirstPassFailureRule];

/** Whether the table classifies `rule` as model-correctable; any other text is terminal. */
export function isModelCorrectableFirstPassRule(
  rule: string,
): rule is ModelCorrectableFirstPassRule {
  return (
    Object.hasOwn(FIRST_PASS_REJECTION_RETRYABILITY, rule) &&
    FIRST_PASS_REJECTION_RETRYABILITY[rule as FirstPassFailureRule].retry === "model-correctable"
  );
}
