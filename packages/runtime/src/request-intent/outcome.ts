// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Turn a model-output fault into its result arm. The arm and the retry
 * disposition come from the catalog row, never from the call site.
 */
import { OUTPUT_RULES } from "../contracts/model-output.js";
import type {
  RequestIntentAuthorityCode,
  RequestIntentDisclosureCode,
  RequestIntentRefused,
  RequestIntentRejected,
} from "./contract.js";
import { RequestIntentFault } from "./kit.js";

/**
 * Handles only a `RequestIntentFault` whose catalog row is model-correctable.
 * A terminal fault, a host fault, an operational-limit refusal, or any other
 * error is rethrown unchanged.
 */
export function rejectedOutcome(error: unknown): RequestIntentRejected {
  if (!(error instanceof RequestIntentFault)) throw error;
  const rule = OUTPUT_RULES[error.code];
  if (rule.retry !== "model-correctable") throw error;
  return {
    outcome: "rejected",
    code: error.code as RequestIntentRejected["code"],
    // The strict inert walk runs over the whole proposal, so its faults sit at the root.
    location: error.location ?? "$",
    at: error.at ?? "$",
    retry: rule.retry,
    ...(error.bound ? { bound: error.bound } : {}),
  };
}

/**
 * Handles a model-correctable `RequestIntentFault` and a terminal one whose
 * catalog row is a disclosure or authority refusal. Any other terminal fault
 * (the model's own question is built by admission, never raised) is a defect
 * in this module, not the model's, and is rethrown with every other error.
 */
export function faultOutcome(error: unknown): RequestIntentRejected | RequestIntentRefused {
  if (error instanceof RequestIntentFault) {
    const rule = OUTPUT_RULES[error.code];
    const base = {
      outcome: "refused",
      location: error.location ?? "$",
      at: error.at ?? "$",
      retry: "terminal",
    } as const;
    if (rule.retry === "terminal" && rule.kind === "disclosure") {
      return { ...base, code: error.code as RequestIntentDisclosureCode };
    }
    // An authority refusal without its boundary could not tell the operator what to change.
    if (rule.retry === "terminal" && rule.kind === "authority" && error.boundary) {
      return {
        ...base,
        code: error.code as RequestIntentAuthorityCode,
        boundary: error.boundary,
      };
    }
  }
  return rejectedOutcome(error);
}
