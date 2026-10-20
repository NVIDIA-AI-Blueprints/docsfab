// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared operator remediation catalog for init, doctor, and error envelopes.
 * Keep text content-minimized and credential-free; codes stay stable for JSON.
 */
import {
  catalogRemediationText,
  isOperatorRemediationId,
  OPERATOR_REMEDIATION_IDS,
  remediationIdForDoctorDiagnostic as catalogRemediationIdForDoctorDiagnostic,
  remediationIdForSituation,
  type OperatorRemediationId,
} from "./situation-catalog.js";
import type { InitRemediationId } from "./remediation-contracts.js";

export { isOperatorRemediationId, OPERATOR_REMEDIATION_IDS };
export type { InitRemediationId, OperatorRemediationId };

export function remediationText(id: OperatorRemediationId): string {
  return catalogRemediationText(id);
}

/** Human line used by init plans and doctor readiness output. */
export function formatRemediationLine(id: OperatorRemediationId): string {
  return `Next action: ${catalogRemediationText(id)}`;
}

/** Next-action text for a doctor diagnostic; a shared remediation id gives init's wording. */
export function doctorDiagnosticRemediation(code: string, fallbackCommand: string): string {
  const id = catalogRemediationIdForDoctorDiagnostic(code);
  return id ? catalogRemediationText(id) : fallbackCommand;
}

export function remediationIdForDoctorDiagnostic(code: string): OperatorRemediationId | undefined {
  return catalogRemediationIdForDoctorDiagnostic(code);
}

/**
 * Duck-typed `ModelProfileMigrationError` "no-profile" detector, so operator
 * code does not import the model layer. Only this shape routes `do`/`run` to
 * `docsfab profile seed` instead of `profile inspect`.
 */
function isMissingModelProfileError(error: Error): boolean {
  const candidate = error as { code?: unknown; reason?: unknown; origin?: unknown };
  return (
    candidate.code === "migration-required" &&
    candidate.reason === "no-profile" &&
    candidate.origin !== "fresh"
  );
}

function isFreshMissingModelProfileError(error: Error): boolean {
  const candidate = error as { code?: unknown; reason?: unknown; origin?: unknown };
  return (
    candidate.code === "migration-required" &&
    candidate.reason === "no-profile" &&
    candidate.origin === "fresh"
  );
}

function isMissingPrimaryModelCredentialError(error: Error): boolean {
  const candidate = error as { code?: unknown; reason?: unknown };
  return (
    candidate.code === "migration-required" && candidate.reason === "missing-primary-credential"
  );
}

function operatorErrorCode(error: Error): string | undefined {
  const candidate = (error as { code?: unknown }).code;
  return typeof candidate === "string" ? candidate : undefined;
}

/**
 * Infer a shared remediation from an operator-facing error. Typed `error.code`
 * wins. Do not add message-regex branches; existing ones serve older installed
 * runtimes and saved logs.
 */
export function inferRemediationId(error: unknown): OperatorRemediationId | undefined {
  if (!(error instanceof Error)) return undefined;
  // Typed publication codes win over message regexes. Factory denial contains
  // "GitLab project" and must not look like a glab access or re-init hint.
  const code = operatorErrorCode(error);
  if (code) {
    const fromCatalog = remediationIdForSituation(code);
    if (fromCatalog) return fromCatalog;
  }
  const message = error.message;
  if (/init --json requires|Unknown init option|duplicated init/iu.test(message)) {
    return "init-cli-usage";
  }
  if (
    /unknown (?:or duplicated )?(?:doctor |test |profile )?option/iu.test(message) ||
    /requires --/iu.test(message) ||
    /cannot use --json/iu.test(message) ||
    /must not be duplicated/iu.test(message) ||
    /Unknown command/iu.test(message)
  ) {
    return "cli-usage";
  }
  if (/INFERENCE_HUB_METADATA/u.test(message)) {
    return undefined;
  }
  if (/glab auth|gitlab authentication|authentication is missing/iu.test(message)) {
    return "glab-auth-login";
  }
  if (/gitlab project|project access/iu.test(message)) {
    return "verify-gitlab-project-access";
  }
  if (isMissingPrimaryModelCredentialError(error)) {
    return "profile-setup";
  }
  if (isFreshMissingModelProfileError(error)) {
    return "profile-setup";
  }
  if (isMissingModelProfileError(error)) {
    return "profile-seed";
  }
  // Profile settings are named MODEL_* or JUDGE_*; a longer name that merely
  // contains MODEL_, such as another owner's host setting, is not one.
  if (/profile/iu.test(message) || /\b(?:MODEL|JUDGE)_/u.test(message)) {
    return "profile-inspect";
  }
  if (/doctor|readiness|configuration|private storage|journal/iu.test(message)) {
    return "doctor";
  }
  return undefined;
}

/** Default fallback when doctor mapping has no more specific remediation. */
export function doctorFallbackRemediationText(): string {
  return "Run `docsfab doctor` after correcting the reported condition; use `docsfab profile inspect` when profile provenance is incomplete.";
}
