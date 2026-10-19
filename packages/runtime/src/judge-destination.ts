// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared HTTPS judge-destination comparison for acceptance `--judge` and
 * campaign semantic judge. Callers keep distinct authorization flags.
 */

export type ApprovedHttpsUrlCode =
  | "invalid-url"
  | "not-https"
  | "embedded-credentials"
  | "query-or-fragment";

export type JudgeDestinationField = "configured" | "environment" | "approved";

export type JudgeDestinationFailure =
  | { kind: "missing" }
  | { kind: "mismatch" }
  | { kind: "invalid"; field: JudgeDestinationField; code: ApprovedHttpsUrlCode };

export type JudgeDestinationResult =
  | { ok: true; url: string }
  | { ok: false; failure: JudgeDestinationFailure };

export function normalizeApprovedHttpsUrl(
  value: string,
): { ok: true; url: string } | { ok: false; code: ApprovedHttpsUrlCode } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, code: "invalid-url" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, code: "not-https" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, code: "embedded-credentials" };
  }
  if (url.search !== "" || url.hash !== "") {
    return { ok: false, code: "query-or-fragment" };
  }
  return { ok: true, url: url.toString().replace(/\/$/u, "") };
}

export function assertApprovedJudgeDestination(input: {
  configured: string;
  environment?: string;
  approved?: string;
}): JudgeDestinationResult {
  const environment = input.environment?.trim();
  if (!input.configured || !environment || !input.approved) {
    return { ok: false, failure: { kind: "missing" } };
  }
  const configured = normalizeField(input.configured, "configured");
  if (!configured.ok) return configured;
  const environmentUrl = normalizeField(environment, "environment");
  if (!environmentUrl.ok) return environmentUrl;
  const approved = normalizeField(input.approved, "approved");
  if (!approved.ok) return approved;
  if (configured.url !== environmentUrl.url || configured.url !== approved.url) {
    return { ok: false, failure: { kind: "mismatch" } };
  }
  return { ok: true, url: configured.url };
}

function normalizeField(value: string, field: JudgeDestinationField): JudgeDestinationResult {
  const result = normalizeApprovedHttpsUrl(value);
  return result.ok ? result : { ok: false, failure: { kind: "invalid", field, code: result.code } };
}
