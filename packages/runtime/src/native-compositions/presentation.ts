// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  presentCollection,
  presentInspection,
  presentResult,
  type CollectionPresentationFacts,
  type InspectionPresentationFacts,
  type PresentationDocument,
  type PresentationEvidence,
  type PresentationField,
  type ResultPresentationFacts,
} from "../operator/index.js";
import type { CompositionComparisonReportV1 } from "../model-composition/comparison.js";
import type { InstalledModelCompositionSummary } from "../model-composition/index.js";
import type { NativePreflightObservationV1 } from "./contracts.js";
import type { PilotCampaignCliResultV1 } from "./pilot-cli.js";

function known(value: string): PresentationEvidence<string> {
  return { state: "known", value };
}

export function projectCompositionList(
  compositions: readonly InstalledModelCompositionSummary[],
): PresentationDocument {
  const entries = compositions.map((composition) => ({
    label: composition.compositionId,
    evidence: known(
      [
        `status=${composition.status}`,
        `class=${composition.executionClass}`,
        `model=${composition.modelId}`,
        `route=${composition.routeId}`,
        `harness=${composition.harnessId}`,
        ...(composition.retirement
          ? [
              `retirement=${composition.retirement.reason} (${composition.retirement.effectiveAt.replace(/T.*$/u, "")})`,
              ...(composition.retirement.successorCompositionId
                ? [`successor=${composition.retirement.successorCompositionId}`]
                : []),
            ]
          : []),
      ].join("; "),
    ),
  }));
  const facts: CollectionPresentationFacts = {
    title: "Installed compositions",
    entries,
    sections: [
      {
        title: "Qualification",
        fields: [
          { label: "Technical approval", evidence: known("not established") },
          { label: "Release eligible", evidence: known("no") },
        ],
      },
      ...(compositions.length === 0
        ? [{ title: "Result", text: ["No installed compositions were found."] }]
        : []),
    ],
    attention: null,
  };
  return presentCollection(facts);
}

export function projectCompositionPreflight(
  result: NativePreflightObservationV1,
): PresentationDocument {
  const ready = result.terminalCode === "preflight-ready";
  const facts: ResultPresentationFacts = {
    title: "Composition preflight",
    outcome: { label: "Preflight", evidence: known(result.terminalCode) },
    scope: { label: "Requested model", evidence: known(result.requestedModel) },
    statusPlanes: [
      { label: "Harness", evidence: known(result.harnessId) },
      { label: "Authentication", evidence: known(result.authentication.status) },
      { label: "Catalog", evidence: known(result.catalog.availability) },
      { label: "Model egress", evidence: known("unavailable") },
      { label: "Workflow execution", evidence: known("unavailable") },
      { label: "Evidence digest", evidence: known(result.preflightSha256) },
    ],
    limitations: ready
      ? []
      : [{ label: "Preflight", evidence: known(result.terminalCode), importance: "material" }],
    attention: ready
      ? null
      : { message: `The composition preflight reported ${result.terminalCode}.` },
  };
  return presentResult(facts);
}

export function projectCompositionComparison(
  report: CompositionComparisonReportV1,
): PresentationDocument {
  const fields: PresentationField[] = [
    { label: "Comparable", evidence: known(report.comparable ? "yes" : "no") },
    { label: "Mismatch", evidence: known(report.mismatchCode ?? "none") },
    ...report.runs.map((run) => ({
      label: run.compositionId,
      evidence: known(
        [
          `duration=${run.durationMs} ms`,
          `tokens=${run.usage.total}`,
          `turns=${run.usage.turns}`,
          `tools=${run.tools.totalCalls}/${run.tools.failedCalls} calls/failed`,
          `product=${run.productDisposition}`,
          `quality=${run.quality.score === null ? "unavailable" : String(run.quality.score)}`,
        ].join("; "),
      ),
    })),
    {
      label: "Winner",
      evidence: known("unavailable; admitted records do not contain quality efficacy evidence"),
      importance: "material",
    },
    { label: "Evidence digest", evidence: known(report.reportSha256) },
  ];
  const facts: InspectionPresentationFacts = {
    title: "Composition comparison",
    subject: known(
      report.comparable ? "Selected records are comparable" : "Selected records are not comparable",
    ),
    findings: fields,
    attention: report.comparable
      ? null
      : {
          message: `The records are not comparable (${report.mismatchCode ?? "unknown mismatch"}).`,
        },
  };
  return presentInspection(facts);
}

export function projectPilotCampaignResult(result: PilotCampaignCliResultV1): PresentationDocument {
  const fields: PresentationField[] = [
    { label: "Evidence class", evidence: known(result.evidenceClass) },
    { label: "Fixture digest", evidence: known(result.fixtureSha256) },
    { label: "Attempts", evidence: known(String(result.attemptReceiptSha256s.length)) },
    { label: "Unattested proxy artifacts", evidence: known(String(result.proxyArtifactCount)) },
    {
      label: "Reliability",
      evidence: known(
        `${result.reliability.succeeded} succeeded, ${result.reliability.failed} failed`,
      ),
    },
    { label: "Quality comparison", evidence: known(result.qualityComparisonStatus) },
    {
      label: "Common evaluation",
      evidence: known(result.commonEvaluationEstablished ? "established" : "not established"),
    },
    {
      label: "Winner",
      evidence: known("unavailable; development pilot cannot rank compositions"),
      importance: "material",
    },
    { label: "Report digest", evidence: known(result.reportSha256) },
    { label: "Technical approval", evidence: known(result.technicalApproval) },
    { label: "Role qualification", evidence: known(result.roleQualification) },
    { label: "Release eligible", evidence: known(result.releaseEligible ? "yes" : "no") },
  ];
  const facts: ResultPresentationFacts = {
    title: "Cross-harness pilot campaign",
    outcome: { label: "Campaign", evidence: known(result.status) },
    statusPlanes: fields,
    limitations: [
      {
        label: "Qualification",
        evidence: known("development evidence is uncontained and proxy evaluation is unattested"),
        importance: "material",
      },
    ],
    attention: {
      message:
        "This development pilot does not establish technical approval, role qualification, or release eligibility.",
    },
  };
  return presentResult(facts);
}
