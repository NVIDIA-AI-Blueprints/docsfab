// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Human projections for advanced commands. Domain records remain the machine contracts. */
import {
  presentResult,
  renderPresentation,
  resolveProcessPresentationCapabilities,
  type PresentationCapabilities,
  type PresentationDetail,
  type PresentationDocument,
  type PresentationField,
  type ResultPresentationFacts,
} from "../operator/presentation/index.js";
import type { EvaluationResult } from "../quality-evaluation/contracts.js";
import type {
  AutoDryRunResultV1,
  AutoDryRunNeedsInputV1,
  AutoDryRunSourceV1,
} from "../autonomy/dry-run.js";
import type { AutoCycleOnceRecordV1 } from "../autonomy/once.js";
import type { ManagedCyclePublishOutcomeV1 } from "../autonomy/managed-publish.js";
import type { MultiUnitCampaignDryRunResultV1 } from "../autonomy/multi-unit-campaign-run.js";
import type {
  IssueLifecycleApplicationResult,
  IssueLifecyclePreflightV1,
} from "../roadmap/issue-lifecycle.js";

function field(
  label: string,
  value: string | number,
  detail: PresentationDetail = "normal",
  material = false,
): PresentationField {
  return {
    label,
    evidence: { state: "known", value: String(value) },
    detail,
    ...(material ? { importance: "material" as const } : {}),
  };
}

function joined(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

/** The shared renderer owns escaping, wrapping, color, and terminal capability policy. */
export function renderAdvancedPresentation(
  document: PresentationDocument,
  capabilities: PresentationCapabilities = resolveProcessPresentationCapabilities(),
): string {
  const rendered = renderPresentation(document, capabilities);
  return rendered.stdout.trimEnd();
}

export function projectEvaluationPresentation(
  fixtureName: string,
  result: EvaluationResult,
  detail: PresentationDetail = "normal",
): PresentationDocument {
  const assertionFields = result.structural.results.map((assertion, index) =>
    field(
      `Assertion ${index + 1}`,
      `${assertion.passed ? "PASS" : "FAIL"}${assertion.recordId ? ` [${assertion.recordId}]` : ""} ${assertion.message}`,
      "normal",
      true,
    ),
  );
  const judge = result.judge;
  return presentResult(
    {
      title: `Evaluation: ${fixtureName}`,
      outcome: field("Verdict", result.passed ? "PASS" : "FAIL", "quiet"),
      scope: field("Fixture", fixtureName, "quiet"),
      statusPlanes: [field("Records", result.structural.recordCount, "quiet")],
      sections: [
        { title: "ASSERTIONS", fields: assertionFields, importance: "material" },
        ...(judge
          ? [
              {
                title: "ADVISORY JUDGE",
                fields: [
                  field("Status", judge.status),
                  field("Rubric", `${judge.rubric.id}@${judge.rubric.version}`),
                  ...(judge.model
                    ? [field("Model", `${judge.model.provider}/${judge.model.model}`)]
                    : []),
                  ...("score" in judge ? [field("Score", judge.score)] : []),
                  ...("rationale" in judge ? [field("Rationale", judge.rationale)] : []),
                  ...("reason" in judge ? [field("Reason", judge.reason)] : []),
                ],
              },
            ]
          : []),
      ],
      attention: result.passed ? null : { message: "Structural assertions failed." },
    },
    { detail },
  );
}

export function projectAutoDryRunPresentation(
  result: AutoDryRunResultV1,
  detail: PresentationDetail = "normal",
): PresentationDocument {
  const facts: ResultPresentationFacts = {
    title: "Autonomous dry-run",
    outcome: field("Assessment", result.decision.disposition, "quiet"),
    scope: field("Repository", result.repository.path, "quiet"),
    statusPlanes: [
      field("Workflow", result.decision.workflow ?? "none", "quiet"),
      field("Confidence", result.decision.confidence, "quiet"),
      field("Reason", result.decision.reasonCode, "quiet"),
    ],
    effects: [
      field("Writes performed", "none", "quiet", true),
      field("Authorization", "none", "quiet", true),
      field("Previewed operations", result.operations.length, "quiet", true),
    ],
    sections: [
      {
        title: "PLAN",
        fields: result.operations.map((operation) =>
          field(operation.key, `${operation.action} ${operation.target.kind}`, "normal", true),
        ),
      },
      {
        title: "READINESS",
        fields: [
          field("Repository revision", result.repository.revision),
          field(
            "Inventory",
            `${result.repository.inventoryStatus} ${result.repository.inventorySha256}`,
          ),
          field("Evidence", joined(result.decision.evidenceIds)),
          field(
            "Dependencies",
            joined(result.decision.dependencies.map((item) => `${item.id}=${item.state}`)),
          ),
          field("Paths", joined(result.decision.pathScope)),
          field("Validation", joined(result.decision.expectedValidation)),
          field("Open inputs", joined(result.decision.openInputIds), "normal", true),
          field(
            "Draft MR target",
            result.draftMergeRequestDestination?.targetBranch ?? "needs input",
          ),
        ],
      },
    ],
    primaryAction: { kind: "instruction", text: result.nextAction },
    attention:
      result.decision.disposition === "execute"
        ? null
        : { message: `No cycle is authorized: ${result.decision.reasonCode}.` },
  };
  return presentResult(facts, { detail });
}

export function projectAutoGatePresentation(
  mode: "once" | "publish",
  assessment:
    | { readonly status: "needs-input"; readonly input: AutoDryRunNeedsInputV1 }
    | { readonly status: "ready"; readonly source: AutoDryRunSourceV1 },
  detail: PresentationDetail = "normal",
): PresentationDocument {
  if (assessment.status === "needs-input") {
    return presentResult(
      {
        title: `Auto ${mode}`,
        outcome: field("Disposition", "needs-input", "quiet"),
        scope: field("Repository", assessment.input.repositoryPath, "quiet"),
        statusPlanes: [field("Reason", assessment.input.reasonCode, "quiet")],
        effects: [field("Writes performed", "none", "quiet", true)],
        sections: [
          {
            title: "OPEN INPUTS",
            fields: assessment.input.openInputIds.map((id, index) =>
              field(`Input ${index + 1}`, id, "normal", true),
            ),
          },
        ],
        attention: { message: "Required input is unavailable; no write was performed." },
      },
      { detail },
    );
  }
  return presentResult(
    {
      title: `Auto ${mode} proposal`,
      outcome: field("Disposition", assessment.source.decision.disposition, "quiet"),
      scope: field("Repository", assessment.source.repositoryPath, "quiet"),
      statusPlanes: [field("Target branch", assessment.source.targetBranch, "quiet")],
      effects: [
        field("Writes performed", "none", "quiet", true),
        field("Authorization", "confirmation required", "quiet", true),
        field(
          "Proposed effect",
          mode === "publish"
            ? "one bounded documentation publish cycle"
            : "one bounded documentation cycle",
          "quiet",
          true,
        ),
      ],
      primaryAction: {
        kind: "instruction",
        text: `Re-run with --confirm-cycle to authorize ${mode === "publish" ? "one bounded documentation publish cycle" : "one bounded documentation cycle"}.`,
      },
      attention: null,
    },
    { detail },
  );
}

export function projectAutoOncePresentation(
  record: AutoCycleOnceRecordV1,
  detail: PresentationDetail = "normal",
): PresentationDocument {
  const eligibility = record.publicationEligibility;
  return presentResult(
    {
      title: `Auto cycle: ${record.cycleId}`,
      outcome: field("Disposition", record.disposition, "quiet"),
      scope: field("Run", record.runRecordId ?? "none", "quiet"),
      statusPlanes: [
        field("Execution", record.terminalResult.workflowExecutionStatus, "quiet"),
        field("Checkpoints", record.checkpoints.length, "quiet"),
      ],
      effects: [
        field("Terminal record", record.terminalResult.terminalResultSha256, "normal", true),
        ...(eligibility
          ? [
              field(
                "Publication eligibility",
                eligibility.eligible ? "eligible" : "ineligible",
                "quiet",
                true,
              ),
            ]
          : []),
      ],
      sections: [
        {
          title: "AUTHORIZATION",
          fields: [
            field("Request", record.requestSha256),
            ...(record.authorizationProjection
              ? [
                  field("Authorization", record.authorizationProjection.authorizationSha256),
                  field("Workflow", record.authorizationProjection.workflow),
                  field("Delivery mode", record.authorizationProjection.deliveryMode),
                ]
              : []),
          ],
        },
        {
          title: "VALIDATION",
          fields: [
            ...record.terminalResult.validation.map((check) =>
              field(check.id, check.status, "normal", check.status !== "passed"),
            ),
            ...(eligibility?.diagnostics.map((code) =>
              field("Publication diagnostic", code, "normal", true),
            ) ?? []),
          ],
        },
      ],
      ...(record.runRecordId
        ? {
            primaryAction: {
              kind: "argv" as const,
              label: "Inspect saved run",
              executable: "docsfab",
              args: ["runs", "show", record.runRecordId],
            },
          }
        : {}),
      attention:
        record.disposition === "executed-succeeded" || record.disposition === "no-action"
          ? null
          : { message: `Cycle stopped with disposition ${record.disposition}.` },
    },
    { detail },
  );
}

export function projectAutoPublishPresentation(
  outcome: ManagedCyclePublishOutcomeV1,
  detail: PresentationDetail = "normal",
): PresentationDocument {
  const publish = outcome.publish;
  const link = outcome.cycle.link;
  return presentResult(
    {
      title: `Managed cycle: ${outcome.cycle.selection.cycleId}`,
      outcome: field("Publication", publish?.status ?? "none", "quiet"),
      scope: field(
        "Selected issue",
        outcome.cycle.selection.selected ? `!${outcome.cycle.selection.selected.issueIid}` : "none",
        "quiet",
      ),
      statusPlanes: [
        ...(link
          ? [
              field("Disposition", link.disposition, "quiet"),
              field("Lifecycle target", link.lifecycleTarget, "quiet"),
            ]
          : []),
      ],
      effects: [
        field(
          "Patch preserved",
          publish?.patchEvidencePreserved ? "yes" : "not recorded",
          "quiet",
          publish?.status === "deferred",
        ),
      ],
      ...(publish?.mergeRequest
        ? {
            artifacts: [
              {
                kind: "link" as const,
                label: `Draft MR !${publish.mergeRequest.iid}`,
                href: publish.mergeRequest.url,
              },
            ],
          }
        : {}),
      ...(publish?.nextAction
        ? { primaryAction: { kind: "instruction" as const, text: publish.nextAction } }
        : {}),
      ...(publish?.recoveryCommand
        ? {
            nextActions: [
              { kind: "instruction" as const, text: `Recovery: ${publish.recoveryCommand}` },
            ],
          }
        : {}),
      attention:
        publish?.status === "deferred"
          ? { message: `Publication deferred: ${publish.failureCode ?? "unknown failure"}.` }
          : publish === null
            ? { message: "No ready issue or executable cycle; publication was not attempted." }
            : null,
    },
    { detail },
  );
}

export function projectCampaignPresentation(
  result: MultiUnitCampaignDryRunResultV1,
  detail: PresentationDetail = "normal",
): PresentationDocument {
  return presentResult(
    {
      title: `Multi-unit campaign: ${result.campaignId}`,
      outcome: field("Stop reason", result.stopReason, "quiet"),
      scope: field("Source revision", result.sourceRevision, "quiet"),
      statusPlanes: [
        field("Mode", "dry-run", "quiet"),
        field("Units processed", result.unitsProcessed, "quiet"),
        field("Queue index", result.queueIndex, "quiet"),
        field("Campaign attempts", result.campaignAttempts, "quiet"),
      ],
      effects: [
        field(
          "Source checkout unchanged",
          result.sourceCheckoutUnchanged ? "yes" : "no",
          "quiet",
          true,
        ),
      ],
      limitations:
        result.stopReason === "cap-exhausted"
          ? [field("Campaign attempt cap", "exhausted", "quiet", true)]
          : [],
      sections: [
        {
          title: "RETAINED PROGRESS",
          fields: [field("Progress digest", result.progressDigest, "normal", true)],
        },
      ],
      attention:
        result.stopReason === "complete"
          ? null
          : {
              message: `Campaign stopped at queue index ${result.queueIndex}; progress remains retained.`,
            },
    },
    { detail },
  );
}

export function projectIssuePreflightPresentation(
  result: IssueLifecyclePreflightV1,
  detail: PresentationDetail = "normal",
): PresentationDocument {
  return presentResult(
    {
      title: "Roadmap issue preflight",
      outcome: field("Status", result.status, "quiet"),
      scope: field("Project", result.project.fullPath, "quiet"),
      statusPlanes: [field("Operations", result.operations.length, "quiet")],
      effects: [
        field("Writes performed", "none", "quiet", true),
        field("Authorization", "required for apply", "quiet", true),
      ],
      sections: [
        {
          title: "PROPOSED EFFECTS",
          fields: result.operations.map((operation) =>
            field(operation.operationKey, operation.action, "normal", true),
          ),
        },
        {
          title: "EVIDENCE",
          fields: [field("Plan", result.planDigest), field("Preflight", result.digest)],
        },
      ],
      attention: null,
    },
    { detail },
  );
}

export function projectIssueApplyPresentation(
  result: IssueLifecycleApplicationResult,
  detail: PresentationDetail = "normal",
): PresentationDocument {
  const { receipt } = result;
  return presentResult(
    {
      title: "Roadmap issue application",
      outcome: field("Status", receipt.terminal, "quiet"),
      scope: field("Project", result.preflight.project.fullPath, "quiet"),
      statusPlanes: [
        field("Attempts", receipt.attempts.length, "quiet"),
        field("Remaining", receipt.remainingOperationKeys.length, "quiet"),
        field("Next safe action", result.nextSafeAction, "quiet"),
      ],
      effects: [
        field("Receipt", receipt.digest, "normal", true),
        field("Remaining operation keys", joined(receipt.remainingOperationKeys), "normal", true),
      ],
      sections: [
        {
          title: "EVIDENCE",
          fields: [
            field("Plan", receipt.planDigest),
            field("Authorization", receipt.authorizationDigest),
            ...(receipt.lastConfirmedOperationKey
              ? [field("Last confirmed", receipt.lastConfirmedOperationKey)]
              : []),
          ],
        },
      ],
      attention:
        receipt.terminal === "complete"
          ? null
          : {
              message: `Application ${receipt.terminal}; inspect the retained receipt before ${result.nextSafeAction}.`,
            },
    },
    { detail },
  );
}
