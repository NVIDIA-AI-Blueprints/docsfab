// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type NativePilotRunnerErrorCode =
  | "artifact-binding-mismatch"
  | "artifact-path-invalid"
  | "artifact-permissions-invalid"
  | "attempt-binding-mismatch"
  | "attempt-replay"
  | "attempt-set-mismatch"
  | "campaign-phase-invalid"
  | "corpus-binding-mismatch"
  | "context-binding-mismatch"
  | "credential-material"
  | "evaluation-binding-mismatch"
  | "evaluation-replay"
  | "executable-drift"
  | "host-operation-failed"
  | "invalid-shape"
  | "invalid-value"
  | "model-identity-mismatch"
  | "migration-required"
  | "native-preflight-failed"
  | "output-limit"
  | "path-policy"
  | "pi-record-invalid"
  | "process-failed"
  | "process-not-settled"
  | "provider-request-count-mismatch"
  | "report-replay"
  | "replay-detected"
  | "re-attestation-failed"
  | "review-independence-failed"
  | "schema-mismatch"
  | "session-replay"
  | "step-set-mismatch"
  | "workspace-mutation"
  | "write-boundary-failed";

export class NativePilotRunnerError extends Error {
  public constructor(public readonly code: NativePilotRunnerErrorCode) {
    super(`Native pilot runner rejected (${code}).`);
    this.name = "NativePilotRunnerError";
  }
}

export function fail(code: NativePilotRunnerErrorCode): never {
  throw new NativePilotRunnerError(code);
}
