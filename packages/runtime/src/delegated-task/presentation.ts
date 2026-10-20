// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  presentResult,
  type PresentationDocument,
  type PresentationField,
  type PresentationSection,
} from "../operator/index.js";
import { escapeUndisplayable } from "../shared/display-text.js";
import type { DelegatedTaskResultV1 } from "./result-contract.js";

export interface DelegatedTaskPresentationOptions {
  readonly answer?: string;
  readonly limitNotice?: string;
  readonly includeAnswer?: boolean;
}

function field(label: string, value: string): PresentationField {
  return { label, evidence: { state: "known", value } };
}

function artifactDescription(artifact: DelegatedTaskResultV1["artifacts"][number]): string {
  const applied = artifact.persistence === "applied" && artifact.supportClass === "supported";
  const classifications = [
    artifact.persistence,
    ...(artifact.supportClass === "unsupported-draft" ? ["unsupported-draft"] : []),
    ...(applied ? ["successful-local-artifact"] : []),
  ];
  return `${artifact.locator} (${classifications.join(", ")})`;
}

function childDescription(child: DelegatedTaskResultV1["children"][number]): string {
  const quality =
    child.formalQuality === "failed" ? "formal-quality-failure" : "quality-not-established";
  const failure = child.failureCode ? `, ${child.failureCode}` : "";
  return `${child.workflow} ${child.status}${failure}, ${quality}`;
}

function checkDescription(result: DelegatedTaskResultV1): string {
  if (result.checkState === "not-requested") return "not-requested";
  if (result.checkState === "incomplete" || result.checkState === "not-run") {
    return `${result.checkState} (incomplete-requested-checks)`;
  }
  const details = result.checks.map((check) => `${check.checkId}=${check.state}`).join("; ");
  return details ? `${result.checkState} (${details})` : result.checkState;
}

function persistenceDescription(result: DelegatedTaskResultV1): string {
  if (result.persistenceState === "persistence-failed") {
    return "persistence-failed (local-candidate-not-applied)";
  }
  if (result.persistenceState === "candidate") {
    return "candidate (local-candidate-not-applied)";
  }
  return result.persistenceState;
}

/** Map the task-owned result contract into shared semantic primitives without reclassifying it. */
export function delegatedTaskPresentation(
  result: DelegatedTaskResultV1,
  options: DelegatedTaskPresentationOptions = {},
): PresentationDocument {
  const limitations: PresentationField[] = [];
  if (result.unmetRequirementIds.length > 0) {
    limitations.push({
      ...field("Unmet requirements", result.unmetRequirementIds.join(", ")),
      importance: "material",
    });
  } else {
    limitations.push(field("Unmet requirements", "none"));
  }
  if (options.limitNotice) {
    limitations.push({ ...field("Limit", options.limitNotice), importance: "material" });
  }

  const sections: PresentationSection[] = [
    {
      title: "Children",
      fields:
        result.children.length === 0
          ? [field("Children", "none")]
          : result.children.map((child) => field(child.childId, childDescription(child))),
    },
    {
      title: "Artifacts",
      fields:
        result.artifacts.length === 0
          ? [field("Artifacts", "none")]
          : result.artifacts.map((artifact) =>
              field(artifact.locator, artifactDescription(artifact)),
            ),
    },
  ];
  if (options.includeAnswer && options.answer?.trim()) {
    const answerLines = options.answer.trimEnd().split(/\r?\n/u).map(escapeUndisplayable);
    sections.push({ title: "Answer", text: answerLines });
  }

  return presentResult({
    title: `Delegated task: ${result.taskId}`,
    outcome: field("Fulfillment", result.fulfillment),
    statusPlanes: [
      field("Stop reason", result.stopReason),
      {
        ...field(
          "Pending questions",
          result.pendingQuestionIds.length > 0 ? result.pendingQuestionIds.join(", ") : "none",
        ),
        ...(result.pendingQuestionIds.length > 0 ? { importance: "material" as const } : {}),
      },
      field("Delivery", result.deliveryState),
      field("Persistence", persistenceDescription(result)),
      field("Checks", checkDescription(result)),
      field("Usage", `tokens=${result.usage.total} turns=${result.usage.turns}`),
    ],
    limitations,
    sections,
    primaryAction: {
      kind: "instruction",
      text: `Next action: ${result.nextAction.code} (${result.nextAction.command})`,
    },
    attention:
      result.fulfillment === "complete" && result.stopReason === "finished"
        ? null
        : {
            message: [
              `Delegated task ${result.taskId} is ${result.fulfillment} (${result.stopReason}).`,
              ...(result.unmetRequirementIds.length > 0
                ? [`Unmet requirements: ${result.unmetRequirementIds.join(", ")}.`]
                : []),
              ...(result.checkState === "incomplete" || result.checkState === "not-run"
                ? ["Requested checks are incomplete or not run."]
                : []),
              ...(result.persistenceState === "persistence-failed"
                ? ["Artifact persistence failed; local candidates were not applied."]
                : []),
            ].join(" "),
          },
  });
}
