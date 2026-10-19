// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator wording for a live-agent turn that ended on a sent provider error.
 *
 * The class and status come from the transport's typed observation, never from
 * the provider's message text, so a provider body (which can echo a key
 * fragment or account id) never reaches the terminal.
 */
import type { ProviderRetryNotice } from "../model/provider.js";
import type { InferenceFailureCategory, ProviderErrorTelemetryV1 } from "../records/contracts.js";

/** Statuses that mean the endpoint serves no such API path. */
const WRONG_PATH_STATUSES: ReadonlySet<number> = new Set([404, 405]);

function answeredStatus(error: Pick<ProviderErrorTelemetryV1, "httpStatus" | "streamErrorStatus">) {
  const status = error.httpStatus ?? error.streamErrorStatus;
  return status === undefined ? "" : ` (HTTP ${status})`;
}

function classReason(error: ProviderErrorTelemetryV1): string | undefined {
  const status = answeredStatus(error);
  switch (error.class) {
    case "auth":
      if (error.httpStatus === 407) {
        return `A proxy between DocsFab and the model provider required authentication${status}. Check the proxy settings and credentials, then retry.`;
      }
      return `The model provider refused the API key or its access to this model${status}. Check the key and model name with docsfab setup, then retry.`;
    case "rate-limit":
      return `The model provider is rate-limiting this API key, or the key's quota or spend budget is used up${status}. Check the key's limits with your provider, then retry.`;
    case "invalid-request":
      return WRONG_PATH_STATUSES.has(error.httpStatus ?? 0)
        ? `The model endpoint does not serve this API or model${status}. Rerun docsfab setup and check the model name, the selected API, and that the endpoint is a base URL (often ending in /v1), not a full request URL.`
        : `The model provider rejected the request${status}. Check the model name and API with docsfab setup, then retry.`;
    case "server":
      return `The model provider had a server error${status}. Retry later.`;
    case "timeout":
      return `The model provider did not answer in time${status}. Retry; if it persists, check connectivity to the endpoint.`;
    case "network":
      return "DocsFab could not reach the model endpoint. Check the network, VPN, or proxy, and the endpoint shown by docsfab setup, then retry.";
    case "stream-incomplete":
      return "The model's response stream closed before the answer finished. Retry.";
    case "content-filter":
      return "The model provider's content filter stopped this answer. Rephrase the request, then retry.";
    case "unknown":
      return undefined;
  }
}

/** The failure line for one provider error, or `undefined` for an `unknown` class. */
export function providerFailureReason(
  error: ProviderErrorTelemetryV1,
  attempts = 1,
): string | undefined {
  const reason = classReason(error);
  if (reason === undefined) return undefined;
  return attempts > 1 ? `${reason} DocsFab tried ${attempts} times.` : reason;
}

/** Readable causes for a retried failure that carried no HTTP status. */
const UNANSWERED_RETRY_CAUSES: Readonly<Partial<Record<InferenceFailureCategory, string>>> = {
  "provider-transient": "connection or server error",
  throttled: "rate limited",
  timeout: "timed out",
  "blank-response": "empty answer",
};

/** The activity label from a failed request until its replay answers. */
export function providerRetryLabel(notice: ProviderRetryNotice): string {
  const cause =
    notice.httpStatus === undefined
      ? (UNANSWERED_RETRY_CAUSES[notice.category] ?? "request failed")
      : `HTTP ${notice.httpStatus}`;
  return `Retrying model request: ${cause}, attempt ${notice.attempt + 1} of ${notice.maxAttempts}`;
}
