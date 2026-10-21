// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Recognize a provider request that failed because the configured endpoint
 * could not be connected to at all: nothing listens on the port, the host name
 * does not resolve, or no route reaches the host. Each fails in milliseconds
 * and answers the same way a few seconds later, so the transport-retry ladder
 * built for throttling and 5xx bursts only delays the operator's fix.
 *
 * Recognized by Node's errno code on the error or its `cause` chain, never by
 * message text. A reset, a timeout, and a temporary lookup failure
 * (`EAI_AGAIN`) are left out: each can clear on a fresh attempt.
 */
import { failureMembers } from "./outbound-proxy-classifier.js";

/** Connect and lookup codes that describe the endpoint, not a passing fault. */
const DEFINITIVE_CONNECT_FAILURES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

/** True when `error` is a fetch failure carrying a definitive connect code. */
export function isDefinitiveConnectFailure(error: unknown): boolean {
  return failureMembers(error).some(
    (member) => typeof member.code === "string" && DEFINITIVE_CONNECT_FAILURES.has(member.code),
  );
}
