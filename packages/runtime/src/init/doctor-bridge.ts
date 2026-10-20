// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Doctor / provider bridge seam for DocsFab init.
 */
import { ModelProfileMigrationError } from "../model/configuration.js";
import { loadConfig, loadModelEndpointForInspection } from "../config/runtime-loader.js";
import { diagnose } from "../doctor.js";
import {
  COMMIT_DOCSFAB_JSON_ACTION,
  type InitApplyNextAction,
  type InitDoctorStatus,
  type InitNextAction,
  type InitProviderStatus,
  type DocsFabInitPlan,
} from "./types.js";

function isInferenceHubMetadataField(field: string): boolean {
  return field.includes("INFERENCE_HUB_METADATA");
}

export async function inspectHostProvider(): Promise<{
  status: InitProviderStatus;
  profileStatus: DocsFabInitPlan["profileStatus"];
}> {
  try {
    const endpoint = loadModelEndpointForInspection("policy");
    return { status: "ready", profileStatus: endpoint.profile.metadata.status };
  } catch (error) {
    if (!(error instanceof ModelProfileMigrationError))
      return { status: "partial", profileStatus: "unavailable" };
    const inferenceIssues = error.issues.filter(
      (issue) => !isInferenceHubMetadataField(issue.field),
    );
    // Metadata-only gaps are not an inference-provider init block.
    if (error.issues.length > 0 && inferenceIssues.length === 0) {
      return { status: "ready", profileStatus: "unavailable" };
    }
    const endpointFields = new Set([
      "MODEL_PROVIDER",
      "MODEL_BASE_URL",
      "MODEL_ID",
      "MODEL_API_KEY",
    ]);
    const missing = inferenceIssues.filter(
      (issue) =>
        endpointFields.has(issue.field) &&
        issue.message === "missing required environment variable",
    ).length;
    return {
      status: missing === endpointFields.size ? "missing" : "partial",
      profileStatus: "unavailable",
    };
  }
}

/** Host-profile `diagnose(loadConfig())`. Not repository `docsfab doctor`. */
export async function checkSharedDoctor(): Promise<InitDoctorStatus> {
  try {
    await diagnose(loadConfig());
    return "ready";
  } catch (error) {
    if (
      error instanceof ModelProfileMigrationError &&
      error.issues.length > 0 &&
      error.issues.every((issue) => isInferenceHubMetadataField(issue.field))
    ) {
      return "ready";
    }
    return error instanceof ModelProfileMigrationError
      ? "profile-diagnostics-required"
      : "diagnostics-required";
  }
}

/** Repository doctor via `inspectDoctorReadiness`. Used after apply when `checkDoctor` is unset. */
export async function checkSharedProductDoctor(repositoryPath: string): Promise<InitDoctorStatus> {
  const { inspectDoctorReadiness } = await import("../doctor-readiness.js");
  const result = await inspectDoctorReadiness({ cwd: repositoryPath });
  if (result.status === "ready") return "ready";
  return result.diagnostics.some(
    (diagnostic) =>
      diagnostic.code === "provider-credentials-missing" ||
      diagnostic.code === "provider-configuration-invalid" ||
      diagnostic.code === "provider-runtime-unavailable",
  )
    ? "profile-diagnostics-required"
    : "diagnostics-required";
}

export function normalizeDoctorStatus(value: boolean | InitDoctorStatus): InitDoctorStatus {
  if (value === true) return "ready";
  if (value === false) return "diagnostics-required";
  return value;
}

export function nextActions(
  authentication: DocsFabInitPlan["gitlabAuthentication"],
  project: DocsFabInitPlan["gitlabProject"],
  doctor: InitDoctorStatus,
): InitNextAction[] {
  const result: InitNextAction[] = [];
  if (authentication === "missing") result.push("glab-auth-login");
  else if (authentication === "unreachable") result.push("retry-gitlab-api");
  else if (project === "unavailable") result.push("verify-gitlab-project-access");
  if (doctor === "profile-diagnostics-required") result.push("profile-inspect");
  else if (doctor === "diagnostics-required") result.push("doctor");
  return result;
}

/** Post-apply next steps: commit project config first, then remaining remediations. */
export function applySuccessNextActions(
  authentication: DocsFabInitPlan["gitlabAuthentication"],
  project: DocsFabInitPlan["gitlabProject"],
  doctor: InitDoctorStatus,
): InitApplyNextAction[] {
  return [COMMIT_DOCSFAB_JSON_ACTION, ...nextActions(authentication, project, doctor)];
}
