// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  INSECURE_MODEL_ENDPOINT_CODE,
  INSECURE_MODEL_ENDPOINT_NEXT_ACTION,
  InsecureModelEndpointError,
} from "../model/endpoint-transport.js";
import { ModelSettingCredentialError } from "../config/model-settings.js";
import {
  OUTBOUND_PROXY_INVALID_CODE,
  OUTBOUND_PROXY_INVALID_NEXT_ACTION,
  OUTBOUND_PROXY_NOT_ENABLED_CODE,
  OUTBOUND_PROXY_NOT_ENABLED_NEXT_ACTION,
  OutboundProxyRefusal,
  type OutboundProxyReport,
} from "../model/outbound-http-policy.js";
import {
  EndpointCompatibilityError,
  firstFailedCheck,
  type EndpointCompatibilityReport,
} from "../profile/endpoint-compatibility.js";
import { doctorDiagnosticRemediation } from "../operator/remediation.js";
import { type DoctorDiagnosticCode, type SituationId } from "../operator/situation-catalog.js";
import { QualityPackError } from "../quality-pack/manifest.js";
import { sanitizeDisplayText } from "../operator/error-envelope.js";
import type { DoctorDiagnostic, DoctorReadinessArea } from "../doctor-readiness.js";

export type DoctorReadinessDiagnosticCode =
  | DoctorDiagnosticCode
  | Extract<SituationId, "no-supported-gitlab-remote">;

export function liveCompatibilityOf(value: unknown): EndpointCompatibilityReport | null {
  if (value === null || typeof value !== "object") return null;
  const live = (value as { live?: { compatibility?: EndpointCompatibilityReport } }).live;
  return live?.compatibility ?? null;
}

/**
 * One diagnostic for the first failed compatibility check. A capacity refusal
 * keeps the transient `provider-live-unavailable` code; every other failure
 * means this endpoint cannot run DocsFab as configured.
 */
export function endpointCompatibilityDiagnostic(
  error: EndpointCompatibilityError,
): DoctorDiagnostic {
  const failed = firstFailedCheck(error.report);
  const quoted = failed?.providerMessage ? ` Provider said: "${failed.providerMessage}".` : "";
  const owner = failed?.owner ? ` Owner: ${failed.owner}.` : "";
  return diag(
    "provider",
    failed?.owner === "provider-capacity" ? "provider-live-unavailable" : "endpoint-incompatible",
    `${error.message}${quoted}${owner}`,
    error.nextAction,
  );
}

export function diag(
  area: DoctorReadinessArea,
  code: DoctorReadinessDiagnosticCode,
  explanation: string,
  nextCommand: string,
): DoctorDiagnostic {
  return Object.freeze({
    area,
    code,
    explanation,
    nextCommand: doctorDiagnosticRemediation(code, nextCommand),
  });
}

/**
 * A retired model selection is its own named stop (#1512), not an invalid
 * profile: report the refusal's message and its successor remediation.
 * Duck-typed so doctor does not import the composition layer.
 */
export function retiredSelectionDiagnostic(error: unknown): DoctorDiagnostic | undefined {
  if (!(error instanceof Error) || (error as { code?: unknown }).code !== "composition-retired") {
    return undefined;
  }
  const nextAction = (error as { nextAction?: unknown }).nextAction;
  return diag(
    "provider",
    "composition-retired",
    error.message,
    typeof nextAction === "string" && nextAction.trim() ? nextAction : "docsfab setup",
  );
}

/**
 * A model setting that holds a configured credential: the load's own refusal,
 * which names the setting and its source, never the value.
 */
export function modelSettingCredentialDiagnostic(error: unknown): DoctorDiagnostic | undefined {
  if (!(error instanceof ModelSettingCredentialError)) return undefined;
  return diag("provider", "provider-configuration-invalid", error.message, error.nextAction);
}

/** Plain HTTP to a host that is not loopback keeps its transport code and next action. */
export function insecureEndpointDiagnostic(error: unknown): DoctorDiagnostic | undefined {
  if (!(error instanceof InsecureModelEndpointError)) return undefined;
  return diag(
    "provider",
    INSECURE_MODEL_ENDPOINT_CODE,
    sanitizeDisplayText(error.message),
    INSECURE_MODEL_ENDPOINT_NEXT_ACTION,
  );
}

/**
 * A quality-pack refusal keeps the code `run` reports and its restore step.
 * The explanation is the code's own table text, so no host path is forwarded.
 */
export function qualityPackDiagnostic(error: QualityPackError): DoctorDiagnostic {
  return diag(
    "installation",
    error.code,
    new QualityPackError(error.code).message,
    error.nextAction,
  );
}

/** A proxy refusal on the live check keeps its own code and next action. */
export function outboundProxyDiagnostic(error: OutboundProxyRefusal): DoctorDiagnostic {
  return diag("provider", error.code, sanitizeDisplayText(error.message), error.nextAction);
}

/** Proxy settings DocsFab refuses, read from the environment alone. */
export function outboundProxyConfigurationDiagnostics(
  report: OutboundProxyReport,
): DoctorDiagnostic[] {
  const diagnostics: DoctorDiagnostic[] = [];
  if (report.issues.length > 0) {
    diagnostics.push(
      diag(
        "configuration",
        OUTBOUND_PROXY_INVALID_CODE,
        `DocsFab refuses outbound requests that would use these proxy settings: ${report.issues
          .map((issue) => `${issue.variable} ${issue.problem}`)
          .join("; ")}.`,
        OUTBOUND_PROXY_INVALID_NEXT_ACTION,
      ),
    );
  }
  if (
    report.support === "unsupported" &&
    (report.http.state === "proxy" || report.https.state === "proxy")
  ) {
    diagnostics.push(
      diag(
        "configuration",
        OUTBOUND_PROXY_NOT_ENABLED_CODE,
        "A proxy variable is set, but this Node.js release has no built-in proxy support, so DocsFab refuses requests that would use the proxy.",
        OUTBOUND_PROXY_NOT_ENABLED_NEXT_ACTION,
      ),
    );
  }
  return diagnostics;
}

export function profileIssues(error: unknown): string[] {
  if (!error || typeof error !== "object" || !("issues" in error) || !Array.isArray(error.issues))
    return [];
  return error.issues.flatMap((issue) =>
    issue && typeof issue === "object" && "field" in issue && typeof issue.field === "string"
      ? [issue.field]
      : [],
  );
}

/** Inference Hub Metadata is a distinct credential family. */
export function isInferenceHubMetadataField(field: string): boolean {
  return field.includes("INFERENCE_HUB_METADATA");
}
