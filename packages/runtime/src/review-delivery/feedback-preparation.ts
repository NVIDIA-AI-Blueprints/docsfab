// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Scenario policy over the retained inventory and the existing placement planner. */
import { deepFreeze } from "../contract-kit/index.js";
import type { ChangeSourceV1 } from "../inputs/change-source.js";
import type { ReviewDeliveryFinding, ReviewDeliveryPlanInput } from "./contracts.js";
import {
  composeReviewPlacement,
  type ReviewPlacementComposition,
  type ReviewPresentationRow,
} from "./placement.js";

export type ReviewFeedbackScenario = "pr-review" | "editorial-coaching" | "audit";

export type ReviewFeedbackBasis =
  | {
      readonly kind: "mandatory-rule";
      readonly reason: string;
      readonly sourceId: string;
      readonly locator: string;
    }
  | {
      readonly kind: "optional-polish";
      readonly reason: string;
      readonly sourceId: string;
      readonly locator: string;
    }
  | { readonly kind: "unknown"; readonly reason: string };

export interface ReviewFeedbackOverride {
  readonly kind: "post" | "group" | "defer" | "dismiss";
  readonly reason: string;
  /** Required for dismissal; must name retained evidence for the same finding. */
  readonly evidence?: { readonly sourceId: string; readonly locator: string };
}

export interface ReviewFeedbackPreparationPolicy {
  readonly scenario: ReviewFeedbackScenario;
  /** Keys are retained inventory IDs, never model-generated display positions. */
  readonly basisByInventoryId?: Readonly<Record<string, ReviewFeedbackBasis>>;
  readonly overrideByInventoryId?: Readonly<Record<string, ReviewFeedbackOverride>>;
}

export interface PreparedReviewFeedbackRow {
  readonly finding: ReviewDeliveryFinding;
  readonly presentation: ReviewPresentationRow;
  readonly basis: ReviewFeedbackBasis;
  readonly disposition:
    | { readonly kind: "post"; readonly reason: string; readonly actionId: string }
    | {
        readonly kind: "group";
        readonly reason: string;
        readonly representativeId: string;
        /** The representative's action; this row's original plan remains in presentation. */
        readonly actionId: string;
      }
    | { readonly kind: "defer" | "dismiss"; readonly reason: string };
}

export interface PreparedReviewFeedback {
  readonly kind: "docsfab-prepared-review-feedback";
  readonly scenario: ReviewFeedbackScenario;
  readonly placement: ReviewPlacementComposition;
  readonly rows: readonly PreparedReviewFeedbackRow[];
  readonly publicationConfirmed: false;
}

function nonempty(value: string, name: string): string {
  if (value.trim().length === 0)
    throw new Error(`Review feedback preparation requires a nonempty ${name} value.`);
  return value;
}

function matchesEvidence(
  row: ReviewPresentationRow,
  evidence: { readonly sourceId: string; readonly locator: string },
): boolean {
  return row.evidence?.sourceId === evidence.sourceId && row.evidence.locator === evidence.locator;
}

function assertKnownKeys(
  values: Readonly<Record<string, unknown>> | undefined,
  ids: ReadonlySet<string>,
  field: string,
): void {
  for (const id of Object.keys(values ?? {}))
    if (!ids.has(id))
      throw new Error(`Review feedback preparation rejected unknown ${field} ID ${id}.`);
}

/** Pure preparation. Its action IDs describe intent; only delivery receipts establish a post. */
export function prepareReviewFeedback(
  input: ReviewDeliveryPlanInput<ChangeSourceV1>,
  policy: ReviewFeedbackPreparationPolicy,
): PreparedReviewFeedback {
  if (!["pr-review", "editorial-coaching", "audit"].includes(policy.scenario))
    throw new Error(
      "Review feedback preparation requires a supported, explicitly selected scenario.",
    );
  const baseline = composeReviewPlacement(input);
  const byId = new Map(baseline.manifest.rows.map((row) => [row.inventoryId, row]));
  const ids = new Set(byId.keys());
  assertKnownKeys(policy.basisByInventoryId, ids, "basis");
  assertKnownKeys(policy.overrideByInventoryId, ids, "override");
  const basisById = new Map<string, ReviewFeedbackBasis>();
  const intentById = new Map<string, ReviewFeedbackOverride>();
  for (const row of baseline.manifest.rows) {
    const basis = policy.basisByInventoryId?.[row.inventoryId] ?? {
      kind: "unknown" as const,
      reason: "Rule applicability was not established in the retained review.",
    };
    if (!["mandatory-rule", "optional-polish", "unknown"].includes(basis.kind))
      throw new Error(`Review feedback basis for ${row.inventoryId} has an unsupported kind.`);
    nonempty(basis.reason, `basis reason for ${row.inventoryId}`);
    if (basis.kind !== "unknown" && !matchesEvidence(row, basis))
      throw new Error(
        `Review feedback basis for ${row.inventoryId} lacks matching retained evidence.`,
      );
    if (basis.kind !== "unknown") {
      const finding = baseline.plan.findings.find((item) => item.inventoryId === row.inventoryId)!;
      const context = baseline.plan.sourceContexts?.find(
        (item) => item.id === finding.sourceContextId,
      );
      if (
        row.factRefs.length === 0 ||
        !context ||
        row.factRefs.some((ref) => context.dimensions[ref.dimensionIndex]?.status !== "applicable")
      )
        throw new Error(
          `Review feedback basis for ${row.inventoryId} has unverified applicability.`,
        );
    }
    basisById.set(row.inventoryId, basis);
    const requested = policy.overrideByInventoryId?.[row.inventoryId];
    if (requested) {
      if (!["post", "group", "defer", "dismiss"].includes(requested.kind))
        throw new Error(
          `Review feedback disposition for ${row.inventoryId} has an unsupported kind.`,
        );
      nonempty(requested.reason, `disposition reason for ${row.inventoryId}`);
      if (
        requested.kind === "dismiss" &&
        (!requested.evidence || !matchesEvidence(row, requested.evidence))
      )
        throw new Error(
          `Review feedback dismissal for ${row.inventoryId} lacks matching retained evidence.`,
        );
      if (requested.kind === "group" && row.groupMemberIds.length < 2)
        throw new Error(`Review feedback grouping for ${row.inventoryId} has no admitted peer.`);
      intentById.set(row.inventoryId, requested);
    }
  }
  const placement = composeReviewPlacement(input, {
    select(finding, proposed) {
      const intent = intentById.get(finding.inventoryId);
      if (intent?.kind === "defer" || intent?.kind === "dismiss") return "retained";
      // Preserve placement's retained-only exclusion even when a scenario requests a summary.
      if (proposed === "retained") return "retained";
      if (policy.scenario === "audit") return "summary";
      if (policy.scenario === "editorial-coaching")
        return basisById.get(finding.inventoryId)?.kind === "mandatory-rule" ? proposed : "summary";
      return proposed;
    },
  });
  const rows = placement.manifest.rows.map((row, index): PreparedReviewFeedbackRow => {
    const finding = placement.plan.findings[index]!;
    const basis = basisById.get(row.inventoryId)!;
    const intent = intentById.get(row.inventoryId);
    let disposition: PreparedReviewFeedbackRow["disposition"];
    if (intent?.kind === "dismiss" || intent?.kind === "defer")
      disposition = { kind: intent.kind, reason: intent.reason };
    else if (row.plannedActionId === null)
      disposition = {
        kind: "defer",
        reason: `No supported publication action was planned: ${row.reason}.`,
      };
    else if (intent?.kind === "group")
      disposition = {
        kind: "group",
        reason: intent.reason,
        representativeId: row.groupRepresentativeId,
        actionId: row.plannedActionId,
      };
    else
      disposition = {
        kind: "post",
        reason:
          intent?.reason ??
          (policy.scenario === "audit"
            ? "Include the retained finding in the audit summary."
            : policy.scenario === "editorial-coaching"
              ? "Present the retained finding with its qualification for editorial coaching."
              : "Present the retained finding in the PR review."),
        actionId: row.plannedActionId,
      };
    return { finding, presentation: row, basis, disposition };
  });
  if (rows.length !== baseline.manifest.rows.length)
    throw new Error("Review feedback preparation lost one or more retained inventory rows.");
  const preparedById = new Map(rows.map((row) => [row.finding.inventoryId, row]));
  const resolvedRows = rows.map((row): PreparedReviewFeedbackRow => {
    if (row.disposition.kind !== "group") return row;
    const peers = row.presentation.groupMemberIds
      .map((id) => preparedById.get(id))
      .filter((member) => member?.disposition.kind === "post");
    const representative =
      peers.find(
        (member) => member?.finding.inventoryId === row.presentation.groupRepresentativeId,
      ) ?? peers[0];
    if (!representative || representative.disposition.kind !== "post")
      throw new Error(
        `Review feedback grouping for ${row.finding.inventoryId} has no publishable peer.`,
      );
    return {
      ...row,
      disposition: {
        ...row.disposition,
        representativeId: representative.finding.inventoryId,
        actionId: representative.disposition.actionId,
      },
    };
  });
  return deepFreeze({
    kind: "docsfab-prepared-review-feedback" as const,
    scenario: policy.scenario,
    placement,
    rows: resolvedRows,
    publicationConfirmed: false as const,
  });
}
