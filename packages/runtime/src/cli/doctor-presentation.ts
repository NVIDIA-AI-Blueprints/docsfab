// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  presentResult,
  renderPresentation,
  resolveProcessPresentationCapabilities,
  type PresentationAction,
  type PresentationDetail,
  type PresentationField,
  type ResultPresentationFacts,
} from "../operator/index.js";
import { describeSkippedHostLimitFile } from "../config/host-limit-file.js";
import { formatDoctorReadiness, type DoctorReadinessResult } from "../doctor-readiness.js";
import { formatDoctorResult, type DoctorResult } from "../doctor.js";
import { formatLocalSessionStorageSummary } from "../live-agent/local-sessions.js";
import { formatOutboundProxy } from "../model/outbound-http-policy.js";
import { describeUncomparedConfiguredCredential } from "../security/configured-credentials.js";

export interface DoctorPresentationInput {
  readonly readiness: DoctorReadinessResult;
  readonly result?: DoctorResult;
  readonly detail?: PresentationDetail;
}

function field(label: string, value: string, detail?: PresentationDetail): PresentationField {
  return {
    label,
    evidence: { state: "known", value },
    ...(detail === undefined ? {} : { detail }),
  };
}

function selectedUseFacts(readiness: DoctorReadinessResult): {
  readonly use: string;
  readonly status: string;
  readonly blockers: readonly string[];
  readonly diagnostics: DoctorReadinessResult["diagnostics"];
} {
  const use = readiness.selectedUse ?? "selected use";
  const view = readiness.selectedUse ? readiness.useReadiness?.[readiness.selectedUse] : undefined;
  return {
    use,
    status: view?.status ?? readiness.status,
    blockers: view?.blockers ?? readiness.diagnostics.map((diagnostic) => diagnostic.code),
    diagnostics: view?.diagnostics ?? readiness.diagnostics,
  };
}

function selectedBlockerDiagnostic(
  selected: ReturnType<typeof selectedUseFacts>,
): DoctorReadinessResult["diagnostics"][number] | undefined {
  return selected.diagnostics.find((diagnostic) => selected.blockers.includes(diagnostic.code));
}

function nextAction(
  readiness: DoctorReadinessResult,
  selected: ReturnType<typeof selectedUseFacts>,
): PresentationAction {
  if (selected.status === "ready") {
    return { kind: "argv", label: "Continue", executable: "docsfab", args: ["list"] };
  }
  if (readiness.selectedUse === "draft-mr" && readiness.remediationArgv) {
    const [executable, ...args] = readiness.remediationArgv;
    if (executable) {
      return { kind: "argv", label: "Prepare draft MR", executable, args };
    }
  }
  const diagnostic = selectedBlockerDiagnostic(selected);
  return diagnostic
    ? { kind: "instruction", text: `Next action: ${diagnostic.nextCommand}` }
    : {
        kind: "instruction",
        text: "Review the attention details and resolve the reported blocker.",
      };
}

function liveInference(result: DoctorResult | undefined, readiness: DoctorReadinessResult): string {
  if (result?.live) return `ready (${result.live.latencyMs} ms)`;
  const observed = result?.liveObservation ?? readiness.liveConnectivity.provider;
  switch (observed) {
    case "passed":
      return "passed (checked by --live)";
    case "failed":
      return "failed (checked by --live; see the provider diagnostic)";
    case "not-attempted":
      return "not attempted (offline readiness is blocked)";
    case "not-requested":
      return "not requested (use --live)";
  }
}

/** Project already-observed doctor facts. This function performs no probes or other I/O. */
export function doctorPresentationFacts(input: DoctorPresentationInput): ResultPresentationFacts {
  const { readiness, result } = input;
  const selected = selectedUseFacts(readiness);
  const diagnostic = selectedBlockerDiagnostic(selected);
  const optionalDraftMr = readiness.useReadiness?.["draft-mr"];
  const optionalDraftDiagnostics = (optionalDraftMr?.diagnostics ?? []).filter((entry) =>
    (optionalDraftMr?.blockers ?? []).includes(entry.code),
  );
  const configuredCredentialWarnings = (readiness.configuredCredentialsNotCompared ?? []).map(
    describeUncomparedConfiguredCredential,
  );
  const configuredCredentialWarningSet = new Set(configuredCredentialWarnings);
  const selectedDiagnostics = selected.diagnostics.filter((entry) =>
    selected.blockers.includes(entry.code),
  );
  const proxyDetails = readiness.outboundProxy ? formatOutboundProxy(readiness.outboundProxy) : [];
  const limitationLines = (readiness.limitations ?? []).map(
    (limitation) =>
      `LIMITATION ${limitation.code}: ${limitation.explanation} Next action: ${limitation.nextCommand}`,
  );
  const hostLimitsWarning = readiness.hostLimitsFile
    ? describeSkippedHostLimitFile(readiness.hostLimitsFile)
    : undefined;
  const sessionWarning =
    readiness.liveAgentSessions &&
    (readiness.liveAgentSessions.state === "unreadable" ||
      readiness.liveAgentSessions.maxAgeDays === null)
      ? formatLocalSessionStorageSummary(readiness.liveAgentSessions)
      : undefined;
  const resultLines = result ? formatDoctorResult(result).split("\n") : [];
  const resultWarnings = resultLines.filter(
    (line) =>
      line.startsWith("  Review overdue:") ||
      line.startsWith("  Limit clamp:") ||
      line.startsWith("Retry categories:") ||
      line.startsWith("  Warning:") ||
      line.startsWith("    Warning:") ||
      (line.startsWith("  Limit reason:") && !line.includes("none (approved metadata is current)")),
  );
  const materialWarnings = [
    ...limitationLines,
    ...(hostLimitsWarning ? [hostLimitsWarning] : []),
    ...(sessionWarning ? [sessionWarning] : []),
    ...resultWarnings,
  ];
  const selectedDetails = [
    `${selected.use} readiness: ${selected.status}; blockers: ${selected.blockers.join(", ") || "none"}`,
    ...(resultLines.length > 0 ? [resultLines[0] ?? ""] : []),
    ...proxyDetails,
  ];
  const allDetails = [
    formatDoctorReadiness(readiness)
      .split("\n")
      .filter((line) => !configuredCredentialWarningSet.has(line))
      .join("\n"),
    ...(result ? [formatDoctorResult(result)] : []),
  ];
  const attentionDetails: PresentationField[] = [
    ...Array.from(
      new Set([...(diagnostic ? [diagnostic.code] : []), ...selected.blockers]),
      (code) => field("Code", code),
    ),
    ...selectedDiagnostics.flatMap((entry) => [
      field("Explanation", entry.explanation),
      field("Next action", entry.nextCommand),
    ]),
    ...materialWarnings.map((warning) => field("Warning", warning)),
  ];
  const detailPointer: PresentationAction = {
    kind: "argv",
    label: "Details",
    executable: "docsfab",
    args: [
      "doctor",
      ...(readiness.repositoryPath ? ["--repo", readiness.repositoryPath] : []),
      ...(readiness.selectedUse ? ["--use", readiness.selectedUse] : []),
      "--verbose",
    ],
  };
  const connectivitySummary = `requested=${readiness.liveConnectivity.requested}, provider=${readiness.liveConnectivity.provider}, gitlab=${readiness.liveConnectivity.gitlab}`;
  const connectivityIsMaterial =
    readiness.liveConnectivity.provider === "failed" ||
    readiness.liveConnectivity.gitlab === "failed";
  const inferenceSummary = liveInference(result, readiness);
  const inferenceIsMaterial =
    inferenceSummary.startsWith("failed") || inferenceSummary.startsWith("not attempted");
  const connectivityField = field("Live connectivity", connectivitySummary);
  const inferenceField = field("Live inference", inferenceSummary);
  if (connectivityIsMaterial) attentionDetails.push(connectivityField);
  if (inferenceIsMaterial) attentionDetails.push(inferenceField);
  const liveDetails = [
    ...(!connectivityIsMaterial ? [connectivityField] : []),
    ...(!inferenceIsMaterial ? [inferenceField] : []),
  ];
  const attention =
    readiness.status === "blocked"
      ? {
          message: diagnostic?.explanation ?? `The selected use ${selected.use} is blocked.`,
          details: attentionDetails,
        }
      : selected.use !== "draft-mr" && optionalDraftMr?.status === "blocked"
        ? {
            message: `The selected use ${selected.use} is ready; optional draft-MR readiness is blocked.`,
            details: [
              ...(optionalDraftMr.blockers ?? []).map((blocker) =>
                field("Optional draft-MR blocker", blocker),
              ),
              ...optionalDraftDiagnostics.flatMap((entry) => [
                field("Optional draft-MR explanation", entry.explanation),
                field("Optional draft-MR next action", entry.nextCommand),
              ]),
              ...materialWarnings.map((warning) => field("Warning", warning)),
              ...(connectivityIsMaterial ? [connectivityField] : []),
              ...(inferenceIsMaterial ? [inferenceField] : []),
            ],
          }
        : connectivityIsMaterial || inferenceIsMaterial
          ? {
              message: "A requested live check did not complete successfully.",
              details: attentionDetails,
            }
          : materialWarnings.length > 0
            ? {
                message: "Doctor found material warnings that may affect the selected use.",
                details: attentionDetails,
              }
            : null;
  return {
    title: "DocsFab doctor",
    outcome: field("Result", `${selected.status} for ${selected.use}`),
    ...(configuredCredentialWarnings.length > 0
      ? { summary: configuredCredentialWarnings.join("\n") }
      : {}),
    scope: {
      label: "Repository",
      evidence: readiness.repositoryPath
        ? { state: "known", value: readiness.repositoryPath }
        : { state: "unknown", explanation: "no repository was resolved" },
    },
    statusPlanes: [
      ...(readiness.checks.length > 0
        ? [
            field(
              "Checks",
              readiness.checks.map(({ area, status }) => `${area} ${status}`).join(", "),
              "quiet",
            ),
          ]
        : []),
      field(
        "Validation scope",
        readiness.validationScope ? "prerequisites only" : "not reported",
        "quiet",
      ),
      field(
        "Delivery confinement",
        readiness.validationScope ? "not checked; checked during delivery" : "not reported",
        "quiet",
      ),
    ],
    attention,
    primaryAction: nextAction(readiness, selected),
    sections: [
      ...((input.detail ?? "normal") === "normal"
        ? [
            {
              title: "DETAILS",
              actions: [detailPointer],
              fields: liveDetails,
              detail: "normal" as const,
            },
            {
              title: "READINESS",
              text: selectedDetails.flatMap((text) => text.split("\n").filter(Boolean)),
              detail: "normal" as const,
            },
          ]
        : []),
      ...((input.detail ?? "normal") === "verbose"
        ? [
            {
              title: "Doctor details",
              text: allDetails.flatMap((text) => text.split("\n").filter(Boolean)),
              detail: "verbose" as const,
            },
          ]
        : []),
    ],
  };
}

export function renderDoctorPresentation(input: DoctorPresentationInput): {
  readonly stdout: string;
  readonly stderr: string;
} {
  const document = presentResult(doctorPresentationFacts(input), {
    detail: input.detail ?? "normal",
  });
  return renderPresentation(document, resolveProcessPresentationCapabilities());
}
