// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Why DocsFab refuses its own outbound provider payload: one closed
 * vocabulary, each reason with its failure class and the operator's next
 * action. An installed request policy raises most of them; the output-limit,
 * payload-shape, tool-history, and send-gate checks run on every route. The
 * turn ledger records them, and failure classification, `docsfab why`, and the
 * diagnosis docs read them from here.
 *
 * Append only: a recorded reason keeps its meaning for the life of its records.
 * No model or endpoint change repairs a refusal of DocsFab's own request; only
 * `policy-subject` points at the installation.
 */
import type { FailureClass } from "../operator/failure-class.js";

interface RequestPolicyRefusalEntry {
  readonly failureClass: FailureClass;
  /** What the refusal means, in one sentence. */
  readonly meaning: string;
  /** What the operator does next. */
  readonly next: string;
}

const REPORT =
  "Report this DocsFab defect with the diagnosis JSON; a rerun builds the same request and is refused the same way.";

export const REQUEST_POLICY_REFUSALS = Object.freeze({
  "payload-shape": {
    failureClass: "contract-shape",
    meaning:
      "The request carried a top-level field, model, stream setting, or reasoning control the policy does not admit.",
    next: REPORT,
  },
  "system-instruction": {
    failureClass: "contract-shape",
    meaning:
      "The request's system message was missing, out of order, not DocsFab's installed instruction, or carried a reasoning control token.",
    next: REPORT,
  },
  "output-limit": {
    failureClass: "contract-shape",
    meaning: "The request asked for more output tokens than the governed turn was granted.",
    next: REPORT,
  },
  "tool-shape": {
    failureClass: "contract-shape",
    meaning: "A tool declaration or the tool choice did not match the shape the policy admits.",
    next: REPORT,
  },
  "tool-history-without-tools": {
    failureClass: "contract-shape",
    meaning:
      "The conversation held tool calls or tool results, but the request offered no tools, which some routes refuse.",
    next: REPORT,
  },
  "message-shape": {
    failureClass: "contract-shape",
    meaning:
      "A conversation message carried a field the policy does not admit for its role, or empty content where content is required.",
    next: REPORT,
  },
  "message-role": {
    failureClass: "contract-shape",
    meaning: "A conversation message had a role the policy does not admit.",
    next: REPORT,
  },
  "message-tool-call": {
    failureClass: "contract-shape",
    meaning: "A replayed assistant tool call did not match the shape the policy admits.",
    next: REPORT,
  },
  "policy-subject": {
    failureClass: "operator-input",
    meaning:
      "The installed request policy does not verify against its digest, route, or the sealed values this DocsFab admits.",
    next: "Reinstall DocsFab so the installed composition and its request policy verify, then rerun; `docsfab composition list` shows the installed compositions.",
  },
  "payload-authority": {
    failureClass: "contract-shape",
    meaning:
      "The payload being finalized did not match the evidence the turn ledger already recorded for this turn.",
    next: REPORT,
  },
  "payload-send": {
    failureClass: "contract-shape",
    meaning:
      "The payload about to be sent was not the one the policy finalized and recorded for this turn.",
    next: REPORT,
  },
  "payload-resend": {
    failureClass: "contract-shape",
    meaning:
      "The transport tried to send a finalized payload a second time; each finalized payload is sent at most once.",
    next: REPORT,
  },
} as const satisfies Record<string, RequestPolicyRefusalEntry>);

export type RequestPolicyRefusal = keyof typeof REQUEST_POLICY_REFUSALS;

/** Every refusal id, for closed-vocabulary readers of saved records. */
export const REQUEST_POLICY_REFUSAL_IDS: readonly RequestPolicyRefusal[] = Object.freeze(
  Object.keys(REQUEST_POLICY_REFUSALS) as RequestPolicyRefusal[],
);

export const REQUEST_POLICY_FAILURE_CODE_PREFIX = "request-policy-";

export function isRequestPolicyRefusal(value: unknown): value is RequestPolicyRefusal {
  return typeof value === "string" && Object.hasOwn(REQUEST_POLICY_REFUSALS, value);
}

/**
 * Refusals the send gate raises. It only ever holds a sealed payload, so they
 * appear only on a turn that recorded `finalPayloadSha256`.
 */
const SEND_GATE_REFUSALS: ReadonlySet<RequestPolicyRefusal> = new Set([
  "payload-send",
  "payload-resend",
]);

/**
 * Whether a turn row may carry `refusal`. Before sealing, any reason but a
 * send-gate one. After sealing, only the ledger check on a replay
 * (`payload-authority`) or the send gate: a replay rebuilds the sealed request,
 * so the shape checks cannot refuse it. The writer and every record reader
 * share this rule, so a written record always reads back.
 */
export function isAdmissibleRequestPolicyRefusal(refusal: unknown, sealed: boolean): boolean {
  if (!isRequestPolicyRefusal(refusal)) return false;
  return sealed
    ? refusal === "payload-authority" || SEND_GATE_REFUSALS.has(refusal)
    : !SEND_GATE_REFUSALS.has(refusal);
}

/** The failure code a refusal is recorded under: `request-policy-<refusal>`. */
export function requestPolicyFailureCode(refusal: RequestPolicyRefusal): string {
  return `${REQUEST_POLICY_FAILURE_CODE_PREFIX}${refusal}`;
}

/** The refusal a recorded failure code names, or `undefined` for any other code. */
export function requestPolicyRefusalOfCode(code: unknown): RequestPolicyRefusal | undefined {
  if (typeof code !== "string" || !code.startsWith(REQUEST_POLICY_FAILURE_CODE_PREFIX)) {
    return undefined;
  }
  const refusal = code.slice(REQUEST_POLICY_FAILURE_CODE_PREFIX.length);
  return isRequestPolicyRefusal(refusal) ? refusal : undefined;
}
