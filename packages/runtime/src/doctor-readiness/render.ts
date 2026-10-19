// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describeSkippedHostLimitFile } from "../config/host-limit-file.js";
import type { SkippedHostLimitFile } from "../config/limit-resolution.js";
import {
  formatLocalSessionStorageSummary,
  type LocalSessionStorageSummaryV1,
} from "../live-agent/local-sessions.js";
import { type DoctorDraftMrReadiness } from "../doctor-publication-readiness.js";
import {
  describeUncomparedConfiguredCredential,
  type UncomparedConfiguredCredential,
} from "../security/configured-credentials.js";
import { formatOutboundProxy, type OutboundProxyReport } from "../model/outbound-http-policy.js";
import {
  formatEndpointCompatibility,
  type EndpointCompatibilityReport,
} from "../profile/endpoint-compatibility.js";
import {
  formatCheckGrid,
  pushSectionHeader,
  type CliFormatOptions,
} from "../operator/cli-format.js";
import { sanitizeDisplayText } from "../operator/error-envelope.js";
import { DOCUMENTATION_SOURCE_CAPABILITIES } from "../repository/documentation-source-support.js";
import type { DoctorReadinessResult } from "../doctor-readiness.js";

export function formatDoctorReadiness(
  result: DoctorReadinessResult,
  options: CliFormatOptions = {},
): string {
  const readiness = result.draftMrReadiness;
  const lines: string[] = [
    `DocsFab readiness: ${result.status}${result.selectedUse ? ` (${result.selectedUse})` : ""}`,
    `Evaluated repository: ${result.repositoryPath ?? "unavailable"}`,
    `Repository revision: ${result.repositoryRevision ?? "unavailable"}`,
    `Checkout: ${result.checkoutBranch ?? "unavailable"} @ ${result.checkoutRevision ?? "unavailable"}`,
    readiness.state === "not-observed"
      ? "GitLab target: not observed"
      : `GitLab target: ${result.gitlabTargetBranch ?? "unavailable"} @ ${
          result.gitlabTargetRevision ?? "unavailable"
        } (${checkoutRelationText(readiness.checkoutRelation)})`,
    `Draft-MR publication observation: ${readiness.state}. ${readiness.reason}`,
  ];
  if (result.projectConfiguration) {
    const config = result.projectConfiguration;
    lines.push(
      `Project configuration: ${config.authority} authority${config.effectiveRevision ? ` at ${config.effectiveRevision}` : ""}; checkout ${config.checkout}`,
      `Effective documentation roots: ${config.authority === "invalid" ? "unavailable" : config.effectiveRoots.join(", ") || "none"}`,
    );
  }
  if (result.useReadiness) {
    for (const use of ["local-review", "local-patch", "draft-mr"] as const) {
      const view = result.useReadiness[use];
      lines.push(
        `${use} readiness: ${view.status}; blockers: ${view.blockers?.join(", ") || "none"}`,
      );
    }
  }
  if (result.remediationArgv) {
    lines.push(`Draft-MR remediation: ${result.remediationArgv.join(" ")}`);
  }
  pushSectionHeader(lines, "DOCUMENTATION GENERATORS", options);
  if ((result.documentationGenerators ?? []).length === 0) {
    lines.push("No generator identified from tracked repository files.");
  }
  for (const generator of result.documentationGenerators ?? []) {
    lines.push(
      `Generator: ${generator.generator} (root ${sanitizeDisplayText(generator.root)}; configuration ${generator.configurationPaths.map(sanitizeDisplayText).join(", ") || "none"})`,
    );
    const capabilities = generator.capabilities;
    if (!capabilities) {
      lines.push("  Adapter: unavailable in the installed registry");
      continue;
    }
    lines.push(
      ...DOCUMENTATION_SOURCE_CAPABILITIES.map(
        (capability) => `  ${capability}: ${capabilities[capability]}`,
      ),
    );
  }
  pushSectionHeader(lines, "CHECKS", options);
  lines.push(...formatCheckGrid(result.checks, options));
  for (const diagnostic of result.diagnostics) {
    pushSectionHeader(lines, "DIAGNOSTIC", options);
    lines.push(
      `Code: ${diagnostic.code}`,
      `Explanation: ${diagnostic.explanation}`,
      `Next action: ${diagnostic.nextCommand}`,
    );
  }
  for (const limitation of result.limitations ?? []) {
    lines.push(
      `LIMITATION ${limitation.code}: ${limitation.explanation} Next action: ${limitation.nextCommand}`,
    );
  }
  lines.push(`Auto modes ready: ${result.autoModesReady.join(", ") || "none"}`);
  lines.push(
    "Validation execution: deferred; trusted delivery selects the built-in validator from workflow, changed paths, and host policy.",
  );
  lines.push(
    result.validationScope
      ? "Validation scope: prerequisites only. Delivery confinement: not checked; checked during delivery."
      : "Validation scope: not reported. Delivery confinement: not reported.",
  );
  lines.push(
    `Live connectivity: requested=${result.liveConnectivity.requested}, ` +
      `provider=${result.liveConnectivity.provider}, gitlab=${result.liveConnectivity.gitlab}`,
  );
  if (result.outboundProxy) lines.push(...formatOutboundProxy(result.outboundProxy));
  if (result.liveAgentSessions) {
    lines.push(formatLocalSessionStorageSummary(result.liveAgentSessions));
  }
  for (const entry of result.configuredCredentialsNotCompared ?? []) {
    lines.push(describeUncomparedConfiguredCredential(entry));
  }
  if (result.hostLimitsFile) lines.push(describeSkippedHostLimitFile(result.hostLimitsFile));
  if (result.endpointCompatibility) {
    lines.push(...formatEndpointCompatibility(result.endpointCompatibility));
  }
  if (result.status === "ready") lines.push("NEXT docsfab list");
  return lines.join("\n");
}

function checkoutRelationText(relation: DoctorDraftMrReadiness["checkoutRelation"]): string {
  switch (relation) {
    case "at-target":
      return "level with checkout";
    case "behind-target":
      return "ahead of checkout";
    case "ahead-of-target":
      return "behind checkout";
    case "diverged-from-target":
      return "diverged from checkout";
    default:
      return "not compared";
  }
}
