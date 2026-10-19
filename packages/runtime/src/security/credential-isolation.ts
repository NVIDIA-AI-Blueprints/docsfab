// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type ConfiguredCredentialMatch,
  describeConfiguredCredentialMatch,
  findConfiguredCredentialInValue,
} from "./configured-credentials.js";

/**
 * Governed boundary that DocsFab's own configured credentials must not cross.
 * Each maps to one content-free next action, so a rejection never echoes the value.
 *
 * Only an exact match against a configured credential stops here (#1807).
 * Repository or request content that merely looks like a credential is a
 * `credential-like-content` finding in the run record, never a refusal.
 */
export type CredentialIsolationBoundary =
  | "model-request"
  | "model-response"
  | "confined-tool-result";

const NEXT_ACTION: Record<CredentialIsolationBoundary, string> = {
  "model-request":
    "Remove the configured credential from the prompt, context packet, or tool-result source, such as the repository file or --source that holds it; host credentials belong only in transport authentication.",
  "model-response":
    "Withhold the provider response and inspect the upstream account or context for credential exposure before retrying.",
  "confined-tool-result":
    "Fail the confined tool without returning the matched bytes; the inference step may continue. Host credentials belong only in transport authentication.",
};

/**
 * Fail closed at a credential-isolation boundary with one stable code and one
 * next action. Neither the rejected value nor rule identifiers are surfaced, and
 * no repository-wide authority or scanner override is implied.
 */
export class CredentialBoundaryError extends Error {
  public readonly boundary: CredentialIsolationBoundary;
  public readonly code = "credential-isolation-boundary" as const;
  public readonly nextAction: string;
  /** Where the matched credential is configured, such as an environment variable name; never its value. */
  public readonly credentialSource?: string;
  /**
   * The message stays the same for every match, because a confined tool hands
   * it to the model; only the operator's next action names where the matched
   * credential is configured.
   */
  public constructor(boundary: CredentialIsolationBoundary, match?: ConfiguredCredentialMatch) {
    super(
      "DocsFab rejected data at a governed credential-isolation boundary before host credential material could escape.",
    );
    this.boundary = boundary;
    this.name = "CredentialBoundaryError";
    this.nextAction = match
      ? `${NEXT_ACTION[boundary]} It matched ${describeConfiguredCredentialMatch(match)}.`
      : NEXT_ACTION[boundary];
    if (match) this.credentialSource = match.source;
  }
}

/**
 * C-04 exact outbound credential guard over the serialized message graph about to
 * reach the model endpoint: it refuses any configured credential, in any form
 * the registry matches. The provider adapter applies the transport
 * authorization header out of band, so the inference credential is not
 * inspected here. A request that cannot be serialized fails closed.
 */
export function assertModelRequestCredentialFree(context: unknown): void {
  assertSerializedCredentialFree(context, "model-request");
}

/** Fail closed before provider output is emitted, persisted, or used as a tool request. */
export function assertModelResponseCredentialFree(response: unknown): void {
  assertSerializedCredentialFree(response, "model-response");
}

/**
 * C-04 confined-tool intercept: inspect a successful tool result before it is
 * injected into the next model request; the outbound guard still applies.
 * Callers at the confined-tool boundary remap this error to a content-free tool
 * failure so the inference step may continue; other callers handle it
 * themselves.
 */
export function assertConfinedToolResultCredentialFree(result: unknown): void {
  assertSerializedCredentialFree(result, "confined-tool-result");
}

function assertSerializedCredentialFree(
  value: unknown,
  boundary: CredentialIsolationBoundary,
): void {
  let serializedValue: unknown;
  try {
    const serialized = JSON.stringify(value);
    serializedValue = serialized === undefined ? undefined : JSON.parse(serialized);
  } catch {
    // hygiene: ok
    throw new CredentialBoundaryError(boundary);
  }
  // Inspect decoded transport values, not JSON-escaped text. Only DocsFab's own
  // configured credentials stop here; a credential shape alone does not.
  const match = findConfiguredCredentialInValue(serializedValue);
  if (match) {
    // hygiene: ok
    throw new CredentialBoundaryError(boundary, match);
  }
}
