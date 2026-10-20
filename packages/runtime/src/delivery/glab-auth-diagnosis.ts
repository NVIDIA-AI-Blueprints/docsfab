// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Hostname-scoped glab failure class. Stderr/stdout are classified internally
 * and must never be copied into operator envelopes.
 */

import { redactCredentialMaterial } from "../security/credential-material.js";

export type GlabTokenProbeStatus = "present" | "missing" | "unverified";

export type GlabCommandFailureClass = "unauthenticated" | "unreachable" | "invalid";

const NETWORK_FAILURE =
  /connection reset|econnreset|connection refused|econnrefused|etimedout|timed out|timeout|no route to host|network is unreachable|tls handshake|certificate|ssl|eof|read tcp|i\/o timeout/iu;

const UNAUTHENTICATED =
  /\b401\b|unauthorized|unauthorised|no token|not logged in|http.?401|authentication required|invalid token/iu;

export function classifyGlabCommandFailure(input: {
  readonly kind: "auth-status" | "api";
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly tokenProbe?: GlabTokenProbeStatus;
}): "ok" | GlabCommandFailureClass {
  if (input.exitCode === 0) return "ok";
  const text = classificationText(input.stdout, input.stderr);
  if (NETWORK_FAILURE.test(text)) return "unreachable";
  if (UNAUTHENTICATED.test(text)) return "unauthenticated";
  if (input.kind === "api") return "invalid";
  if (input.tokenProbe === "missing") return "unauthenticated";
  if (input.tokenProbe === "present") return "unreachable";
  return "unauthenticated";
}

export function publicationCodeForGlabAuthClass(
  cls: Exclude<ReturnType<typeof classifyGlabCommandFailure>, "ok">,
): "gitlab-unauthenticated" | "gitlab-unreachable" | "gitlab-response-invalid" {
  if (cls === "unreachable") return "gitlab-unreachable";
  if (cls === "unauthenticated") return "gitlab-unauthenticated";
  return "gitlab-response-invalid";
}

export function tokenProbeFromExitCode(exitCode: number): GlabTokenProbeStatus {
  if (exitCode === 0) return "present";
  if (exitCode === 1) return "missing";
  return "unverified";
}

function classificationText(stdout?: string, stderr?: string): string {
  return redactCredentialMaterial(`${stderr ?? ""}\n${stdout ?? ""}`);
}
