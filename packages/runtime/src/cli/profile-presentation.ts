// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  presentInspection,
  presentResult,
  type InspectionPresentationFacts,
  type PresentationDocument,
  type PresentationEvidence,
  type PresentationField,
  type PresentationSection,
  type ResultPresentationFacts,
} from "../operator/index.js";
import type { ProfileDraftRecord } from "./profile-draft.js";
import type { ProfileProbeObservation } from "./profile-probe.js";
import type {
  ModelProfileInspectionPreflightV1,
  ModelProfileInspectionV1,
} from "../model/profile-inspection.js";
import { isReviewOverdue } from "../model/configuration.js";

type ProfileCell = ModelProfileInspectionV1["fields"][number]["effective"];

function known(value: string): PresentationEvidence<string> {
  return { state: "known", value };
}

function profileCell(value: ProfileCell): string {
  switch (value.state) {
    case "known":
      return typeof value.value === "object"
        ? (JSON.stringify(value.value) ?? "unavailable")
        : String(value.value);
    case "unknown":
      return `unknown (${value.reason})`;
    case "unsupported":
      return `unsupported (${value.reason})`;
    case "redacted":
      return "redacted";
    case "conflicting":
      return `conflicting${value.selected === undefined ? "" : `; selected=${JSON.stringify(value.selected)}`}`;
  }
}

function profileProbeCommand(locator: string): string {
  const separator = locator.indexOf(":");
  if (separator < 1 || separator === locator.length - 1) {
    return "Rerun this `docsfab profile probe` command with `--live`, retaining its `--route` and `--model` arguments, when provider contact is intended.";
  }
  const route = locator.slice(0, separator);
  const model = locator.slice(separator + 1).replaceAll("'", "'\\''");
  return `When provider contact is intended, rerun this probe with: \`docsfab profile probe --route ${route} --model '${model}' --live\`.`;
}

export function projectProfileInspection(
  report: ModelProfileInspectionV1,
  detailed = false,
  boundProfile?: string,
): PresentationDocument {
  const sourceFact = (source: "inference" | "metadata"): string => {
    const value = report.catalog.sources.find((item) => item.source === source);
    return value ? `${value.status}${value.code ? ` (${value.code})` : ""}` : "unknown";
  };
  const fields = report.fields;
  const reconciliation = report.catalog.reconciliation;
  const effective = (name: string): string => {
    const field = fields.find((item) => item.field === name);
    return field ? profileCell(field.effective) : "unknown";
  };
  const reviewAfter = report.runtime.configuredClaim.reviewAfter;
  const reviewAdvisory =
    reviewAfter && isReviewOverdue(reviewAfter, new Date(report.generatedAt))
      ? `Review overdue: the profile review date ${reviewAfter} has passed. This is a reminder only; DocsFab still uses the configured limits, capabilities, and prices.`
      : null;
  const findings: PresentationField[] = [
    ...(boundProfile ? [{ label: "Bound execution profile", evidence: known(boundProfile) }] : []),
    {
      label: "Purpose",
      evidence: known(report.purpose === "policy" ? "Documentation workflows" : "Quality judge"),
    },
    { label: "Profile status", evidence: known(report.runtime.profileStatus) },
    { label: "Effective limit state", evidence: known(report.runtime.effectiveLimitReason) },
    { label: "Fallback", evidence: known(report.runtime.fallbackApplied ? "active" : "inactive") },
    { label: "Configured approval claim", evidence: known(report.runtime.configuredApprovalClaim) },
    { label: "Claim freshness", evidence: known(report.runtime.configuredClaim.freshness) },
    { label: "Claim verification", evidence: known(report.runtime.configuredClaim.verification) },
    { label: "Verified approval", evidence: known(report.runtime.verifiedApproval) },
    { label: "Effective input limit", evidence: known(effective("maxInputTokens")) },
    { label: "Effective output limit", evidence: known(effective("maxOutputTokens")) },
    { label: "Effective context window", evidence: known(effective("contextWindow")) },
    { label: "Catalog requested", evidence: known(report.catalog.requested ? "yes" : "no") },
    { label: "Inference catalog", evidence: known(sourceFact("inference")) },
    { label: "Metadata catalog", evidence: known(sourceFact("metadata")) },
    {
      label: "Catalog reconciliation",
      evidence: known(report.catalog.reconciliation?.decision.disposition ?? "unavailable"),
    },
    ...(reviewAdvisory ? [{ label: "Review advisory", evidence: known(reviewAdvisory) }] : []),
  ];
  const sections: PresentationSection[] = [];
  if (detailed) {
    sections.push({
      title: "Field Evidence",
      detail: "verbose",
      fields: fields.map((field) => ({
        label: field.field,
        evidence: known(
          [
            `configured=${profileCell(field.configured)}`,
            `effective=${profileCell(field.effective)}`,
            `observed=${field.observed.length === 0 ? "none" : field.observed.map((item) => `${item.source}:${profileCell(item.evidence)}`).join(" | ")}`,
            `proposed=${profileCell(field.proposed)}`,
            `approved=${profileCell(field.approved)}`,
            `drift=${field.drift.status}`,
            ...(field.drift.reasons.length > 0
              ? [`reasons=${field.drift.reasons.join(", ")}`]
              : []),
          ].join("; "),
        ),
      })),
    });
    sections.push(
      {
        title: "Inspection Evidence",
        detail: "verbose",
        fields: [
          { label: "Generated at", evidence: known(report.generatedAt) },
          { label: "Inspection digest", evidence: known(report.sha256) },
          {
            label: "Configured source digest",
            evidence: known(report.runtime.configuredClaim.approvedSourceSha256 ?? "unknown"),
          },
          {
            label: "Effective date",
            evidence: known(report.runtime.configuredClaim.effectiveDate ?? "unknown"),
          },
          {
            label: "Review after",
            evidence: known(report.runtime.configuredClaim.reviewAfter ?? "unknown"),
          },
          {
            label: "Reconciliation decision",
            evidence: known(report.catalog.reconciliation?.decision.disposition ?? "unavailable"),
          },
          ...(reconciliation
            ? [{ label: "Decision digest", evidence: known(reconciliation.decision.sha256) }]
            : []),
          ...(reconciliation?.status === "proposed" &&
          reconciliation.proposal &&
          reconciliation.proposalProvenance
            ? [
                { label: "Proposal digest", evidence: known(reconciliation.proposal.sha256) },
                {
                  label: "Proposal provenance digest",
                  evidence: known(reconciliation.proposalProvenance.sha256),
                },
              ]
            : []),
        ],
        text:
          report.reasons.length > 0
            ? report.reasons.map((reason) => `Reason: ${reason}`)
            : ["Reasons: none"],
      },
      {
        title: "Remediation",
        detail: "verbose",
        text: report.remediation.length > 0 ? report.remediation : ["No remediation was recorded."],
      },
    );
  }
  const facts: InspectionPresentationFacts = {
    title: "Model profile",
    subject: known(`${report.subject.provider}/${report.subject.model}`),
    findings,
    sections,
    attention:
      report.runtime.profileStatus === "current" &&
      report.runtime.effectiveLimitReason === "none" &&
      report.reasons.length === 0
        ? null
        : {
            message: `Profile evidence requires review: ${report.runtime.profileStatus}; ${report.runtime.effectiveLimitReason}.`,
          },
    actions:
      report.remediation.length > 0
        ? report.remediation.map((text) => ({ kind: "instruction" as const, text }))
        : [{ kind: "instruction", text: "No additional remediation is recorded." }],
  };
  return presentInspection(facts, { detail: detailed ? "verbose" : "normal" });
}

export function projectProfileProbe(observation: ProfileProbeObservation): PresentationDocument {
  const live = observation.live;
  const compatibility = observation.compatibility;
  const findings: PresentationField[] = [
    { label: "Locator", evidence: known(observation.locator) },
    { label: "Live probe", evidence: known(live ? "requested" : "not requested") },
    { label: "Verdict", evidence: known(observation.verdict) },
    ...(compatibility
      ? [
          { label: "Endpoint compatibility", evidence: known(compatibility.verdict) },
          {
            label: "Maximum output tokens",
            evidence: known(String(compatibility.maxOutputTokens)),
          },
          ...compatibility.checks.flatMap((check) => [
            {
              label: check.id,
              evidence: known(`${check.status} (${check.finding}); ${check.detail}`),
            },
            ...(check.providerMessage
              ? [
                  {
                    label: "Provider said",
                    evidence: known(
                      `"${check.providerMessage}"${check.providerMessageTruncated ? " (truncated)" : ""}`,
                    ),
                  },
                ]
              : []),
            ...(check.owner
              ? [
                  {
                    label: `${check.id} owner`,
                    evidence: known(`${check.owner} (cause ${check.cause ?? "unknown"})`),
                  },
                ]
              : []),
            ...(check.nextAction
              ? [{ label: `${check.id} next action`, evidence: known(check.nextAction) }]
              : []),
          ]),
        ]
      : []),
  ];
  const facts: ResultPresentationFacts = {
    title: "Profile probe",
    outcome: {
      label: "Probe outcome",
      evidence: known(live ? observation.verdict : "not requested"),
    },
    scope: { label: "Locator", evidence: known(observation.locator) },
    effects: [{ label: "Configuration", evidence: known("unchanged") }],
    limitations: live
      ? []
      : [
          {
            label: "Live evidence",
            evidence: known("not collected; --live was not requested"),
            importance: "material",
          },
        ],
    sections: compatibility
      ? [{ title: "Endpoint Compatibility", fields: findings.slice(3), detail: "normal" }]
      : [],
    nextActions: live
      ? []
      : [
          {
            kind: "instruction",
            text: profileProbeCommand(observation.locator),
          },
        ],
    attention:
      live && observation.verdict === "unreachable"
        ? { message: `The live probe reported ${observation.verdict}.` }
        : null,
  };
  return presentResult(facts);
}

export function projectProfileInspectionPreflight(
  report: ModelProfileInspectionPreflightV1,
): PresentationDocument {
  return presentResult({
    title: "Model profile inspection",
    outcome: { label: "Inspection", evidence: known(report.disposition) },
    scope: {
      label: "Purpose",
      evidence: known(report.purpose === "policy" ? "Documentation workflows" : "Quality judge"),
    },
    statusPlanes: [
      { label: "API format", evidence: known(`${report.apiDisposition} (${report.reason})`) },
      { label: "Configuration field", evidence: known(report.field) },
      { label: "Evidence digest", evidence: known(report.sha256) },
    ],
    limitations: [
      {
        label: "Inspection limitation",
        evidence: known(report.remediation),
        importance: "material",
      },
    ],
    nextActions: [{ kind: "instruction", text: report.remediation }],
    attention: { message: "The selected profile API format is unsupported." },
  });
}

export function projectProfileDraft(draft: ProfileDraftRecord): PresentationDocument {
  return presentResult({
    title: "Profile composition draft",
    outcome: { label: "Draft", evidence: known(draft.composition.compositionId) },
    scope: { label: "Locator", evidence: known(draft.locator) },
    statusPlanes: [
      { label: "Probe verdict", evidence: known(draft.verdict) },
      {
        label: "Request policy",
        evidence: known(
          draft.composition.requestPolicy ? "measured chat-template kwarg" : "omitted",
        ),
      },
      { label: "Registry", evidence: known(draft.registryUnchanged ? "unchanged" : "changed") },
    ],
    limitations: [
      { label: "Approval", evidence: known("not established by draft"), importance: "material" },
    ],
    sections: [
      {
        title: "Composition Evidence",
        fields: [
          { label: "Provider", evidence: known(draft.composition.deployment.provider) },
          { label: "Model", evidence: known(draft.composition.model.resolvedId) },
          { label: "Route", evidence: known(draft.composition.deployment.routeId) },
        ],
      },
    ],
    nextActions: [
      {
        kind: "instruction",
        text: `After an authorized registry edit, run ${draft.resealCommand} from packages/runtime (${draft.resealScript}), then run npm run check:composition-digests. This command does not merge the registry.`,
      },
    ],
    attention: null,
  });
}
