// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { deepFreeze } from "../contract-kit/index.js";
import type { ReviewDeliveryFinding } from "./contracts.js";

export type OfflineTechnicalStatusV1 = "persists" | "fixed" | "obsolete" | "unverified";
export interface OfflineHumanDispositionV1 {
  readonly kind: "deferred" | "author-dismissed";
  readonly reason: string;
  readonly actorRef: string;
  readonly scopeRef: string;
}
export type OfflineRevisionStatusV1 = OfflineTechnicalStatusV1 | OfflineHumanDispositionV1["kind"];

interface OfflineReviewInventoryV1 {
  readonly reviewRef: string;
  readonly targetRef: string;
  readonly sourceRef: string;
  readonly findings: readonly ReviewDeliveryFinding[];
}
interface OfflineRevisionBindingV1 {
  readonly beforeReviewRef: string;
  readonly afterReviewRef: string;
  readonly earlierInventoryId: string;
}

/** Local fixture descriptions, never canonical continuity, verification or authority. */
export interface OfflineRevisionInputV1 {
  readonly before: OfflineReviewInventoryV1;
  readonly after: OfflineReviewInventoryV1;
  readonly links: readonly (OfflineRevisionBindingV1 & {
    readonly kind: "synthetic-continuity";
    readonly laterInventoryId: string;
    readonly relation: "same-location" | "move" | "rename" | "ambiguous" | "unavailable";
  })[];
  readonly rechecks: readonly (OfflineRevisionBindingV1 & {
    readonly kind: "synthetic-recheck";
    readonly outcome: "repair" | "persists" | "obsolete" | "unavailable";
    readonly coverage: "complete" | "partial" | "unknown";
    readonly source: "available" | "inaccessible";
    readonly check: "succeeded" | "failed" | "unavailable";
  })[];
  readonly dispositions: readonly (OfflineRevisionBindingV1 & {
    readonly kind: "synthetic-disposition";
    readonly disposition: OfflineHumanDispositionV1["kind"];
    readonly reason: string;
    readonly actorRef: string;
    readonly scopeRef: string;
  })[];
  readonly changeState: "open" | "closed" | "merged" | "unknown";
}

interface OfflineRevisionDecisionV1 {
  readonly earlierInventoryId: string;
  readonly candidateInventoryIds: readonly string[];
  readonly laterInventoryIds: readonly string[];
  readonly status: OfflineRevisionStatusV1;
  readonly technicalStatus: OfflineTechnicalStatusV1;
  readonly disposition: OfflineHumanDispositionV1 | null;
  readonly reasons: readonly string[];
}
export interface OfflineRevisionPreviewV1 extends OfflineRevisionInputV1 {
  readonly kind: "offline-review-revision-preview";
  readonly evidence: "synthetic-inputs-only";
  readonly dispatch: "unavailable";
  readonly decisions: readonly OfflineRevisionDecisionV1[];
  readonly current: readonly {
    readonly inventoryId: string;
    readonly disposition: "associated" | "new" | "ambiguous";
    readonly earlierInventoryIds: readonly string[];
  }[];
  readonly limitations: readonly string[];
}

function inventoryCounts(findings: readonly ReviewDeliveryFinding[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of findings) counts.set(row.inventoryId, (counts.get(row.inventoryId) ?? 0) + 1);
  return counts;
}

/** Effect-free preview only. Real evidence admission and lifecycle integration remain external. */
export function planReviewRevisionsV1(original: OfflineRevisionInputV1): OfflineRevisionPreviewV1 {
  const input = structuredClone(original);
  const beforeIds = inventoryCounts(input.before.findings);
  const afterIds = inventoryCounts(input.after.findings);
  const sameTarget = input.before.targetRef === input.after.targetRef;
  const bound = (row: OfflineRevisionBindingV1): boolean =>
    sameTarget &&
    row.beforeReviewRef === input.before.reviewRef &&
    row.afterReviewRef === input.after.reviewRef &&
    beforeIds.has(row.earlierInventoryId);
  const inventoryAmbiguous = [...beforeIds.values(), ...afterIds.values()].some((n) => n !== 1);
  const limitations = ["lifecycle-contract-unavailable"];
  if (!sameTarget) limitations.push("binding-mismatch");
  if (inventoryAmbiguous) limitations.push("inventory-ambiguous");
  if (input.changeState !== "open") limitations.push("change-terminal");
  if ([...input.links, ...input.rechecks, ...input.dispositions].some((row) => !bound(row))) {
    if (!limitations.includes("binding-mismatch")) limitations.push("binding-mismatch");
  }

  const decisions = input.before.findings.map((earlier): OfflineRevisionDecisionV1 => {
    const reasons: string[] = [];
    const links = input.links.filter((row) => row.earlierInventoryId === earlier.inventoryId);
    const candidates = [...new Set(links.map((row) => row.laterInventoryId))];
    const bindingMismatch =
      !sameTarget || links.some((row) => !bound(row) || !afterIds.has(row.laterInventoryId));
    if (bindingMismatch) reasons.push("binding-mismatch");
    if (inventoryAmbiguous) reasons.push("inventory-ambiguous");
    const competing = links.some((candidate) =>
      input.links.some(
        (row) =>
          bound(row) &&
          row.laterInventoryId === candidate.laterInventoryId &&
          row.earlierInventoryId !== earlier.inventoryId,
      ),
    );
    const ambiguous =
      links.length > 1 || competing || links.some((row) => row.relation === "ambiguous");
    if (ambiguous) reasons.push("lineage-ambiguous");
    const unavailable = links.length === 0 || links.some((row) => row.relation === "unavailable");
    if (unavailable) reasons.push("source-relation-unavailable");
    const associated = !bindingMismatch && !inventoryAmbiguous && !ambiguous && !unavailable;

    const rechecks = input.rechecks.filter((row) => row.earlierInventoryId === earlier.inventoryId);
    const recheck = rechecks.length === 1 ? rechecks[0] : undefined;
    if (rechecks.length > 1) reasons.push("recheck-ambiguous");
    if (recheck && !bound(recheck)) reasons.push("binding-mismatch");
    if (
      !recheck ||
      recheck.check !== "succeeded" ||
      recheck.source !== "available" ||
      recheck.outcome === "unavailable"
    )
      reasons.push("recheck-unavailable");
    if (recheck && recheck.coverage !== "complete") reasons.push("coverage-incomplete");
    const checked =
      !!recheck &&
      bound(recheck) &&
      recheck.check === "succeeded" &&
      recheck.source === "available" &&
      recheck.coverage === "complete";
    let technicalStatus: OfflineTechnicalStatusV1 = "unverified";
    const validLinks = links.filter((row) => bound(row) && afterIds.has(row.laterInventoryId));
    if (checked && !inventoryAmbiguous && !ambiguous) {
      if (recheck.outcome === "persists" && associated) technicalStatus = "persists";
      if (recheck.outcome === "repair" || recheck.outcome === "obsolete") {
        if (validLinks.length > 0) reasons.push("recheck-conflict");
        else technicalStatus = recheck.outcome === "repair" ? "fixed" : "obsolete";
      }
    }

    const human = input.dispositions.filter(
      (row) => row.earlierInventoryId === earlier.inventoryId,
    );
    let disposition: OfflineHumanDispositionV1 | null = null;
    if (human.length > 1) reasons.push("disposition-ambiguous");
    const decision = human.length === 1 ? human[0] : undefined;
    if (decision) {
      if (!bound(decision)) reasons.push("binding-mismatch");
      else if (
        ![decision.reason, decision.actorRef, decision.scopeRef].every(
          (value) => value.trim().length > 0,
        )
      )
        reasons.push("disposition-unavailable");
      else if (!inventoryAmbiguous)
        disposition = {
          kind: decision.disposition,
          reason: decision.reason,
          actorRef: decision.actorRef,
          scopeRef: decision.scopeRef,
        };
    }
    return {
      earlierInventoryId: earlier.inventoryId,
      candidateInventoryIds: candidates,
      laterInventoryIds: associated ? candidates : [],
      status: disposition?.kind ?? technicalStatus,
      technicalStatus,
      disposition,
      reasons: [...new Set(reasons)],
    };
  });
  const current = input.after.findings.map((row) => {
    const associated = decisions.filter((decision) =>
      decision.laterInventoryIds.includes(row.inventoryId),
    );
    const candidates = decisions.filter((decision) =>
      decision.candidateInventoryIds.includes(row.inventoryId),
    );
    return {
      inventoryId: row.inventoryId,
      disposition:
        associated.length === 1
          ? ("associated" as const)
          : candidates.length > 0 || inventoryAmbiguous
            ? ("ambiguous" as const)
            : ("new" as const),
      earlierInventoryIds: candidates.map((decision) => decision.earlierInventoryId),
    };
  });
  return deepFreeze({
    ...input,
    kind: "offline-review-revision-preview",
    evidence: "synthetic-inputs-only",
    dispatch: "unavailable",
    decisions,
    current,
    limitations,
  });
}
