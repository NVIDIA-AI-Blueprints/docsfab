// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Pure presentation decisions over D1's retained, already anchored review plan. */
import { canonicalJson, sha256 } from "../content-ir/canonical.js";
import { deepFreeze } from "../contract-kit/index.js";
import type { ChangeSourceV1 } from "../inputs/change-source.js";
import type { ReviewIssueV3, ReviewIssueV4, ReviewFindingV1 } from "../review/contracts.js";
import { createReviewDeliveryPlan } from "./plan.js";
import type {
  ReviewDeliveryAction,
  ReviewDeliveryDisposition,
  ReviewDeliveryFinding,
  ReviewDeliveryPlan,
  ReviewDeliveryPlanInput,
} from "./contracts.js";

export type ReviewFactTuple = readonly [string, number, number, string];

export interface ReviewPresentationRow {
  readonly inventoryId: string;
  readonly logicalIssueId: string;
  readonly observationId: string;
  readonly retained: ReviewDeliveryFinding["retained"];
  readonly retainedActionSha256: string | null;
  readonly retainedRichSha256: string | null;
  readonly canonicalIssueId: string | null;
  readonly producerOriginalId: string | null;
  readonly producerStepId: string | null;
  readonly producerSkill: string | null;
  readonly evidence: ReviewIssueV3["evidence"] | null;
  readonly factRefs: ReviewIssueV3["factRefs"];
  readonly factTuples: readonly ReviewFactTuple[];
  readonly groupKey: string;
  readonly groupRepresentativeId: string;
  readonly groupMemberIds: readonly string[];
  readonly baselineDisposition: ReviewDeliveryDisposition;
  readonly finalDisposition: ReviewDeliveryDisposition;
  readonly reason: string;
  readonly limitations: readonly string[];
  readonly uncertainty: readonly string[];
  readonly causality: "unknown";
  readonly consequence: "unknown";
  readonly verification: "unknown";
  readonly plannedActionId: string | null;
  readonly unpublished: boolean;
}

export interface ReviewPresentationManifest {
  readonly kind: "docsfab-review-presentation-manifest";
  readonly targetSha256: string;
  readonly sourceSha256: string;
  readonly snapshotSha256: string;
  readonly resultSha256: string;
  readonly actor: ReviewDeliveryPlan["actor"];
  readonly artifact: ReviewDeliveryPlan["artifact"];
  readonly capabilities: ReviewDeliveryPlan["capabilities"];
  readonly reviewedHeadSha: string;
  readonly actionSetSha256: string;
  readonly rows: readonly ReviewPresentationRow[];
  readonly affectedPaths: readonly string[];
  readonly reviewScope: ReviewDeliveryPlan["reviewScope"];
  readonly skippedPaths: readonly { readonly path: string; readonly reason: string }[];
  readonly hostedReportUrlCandidate: string | null;
  readonly inventoryStatus: "summary-planned" | "inline-union-only" | "retrieval-unavailable";
  readonly publicationConfirmed: false;
}

export interface ReviewPlacementComposition {
  readonly plan: ReviewDeliveryPlan<ChangeSourceV1>;
  readonly manifest: ReviewPresentationManifest;
}

/** A caller may narrow placement; the D1 planner still enforces provider capability. */
export interface ReviewPlacementSelection {
  select(
    finding: Readonly<ReviewDeliveryFinding>,
    proposed: "inline" | "summary" | "retained",
  ): "inline" | "summary" | "retained";
}

export interface ReviewFindingAssociation {
  issue: ReviewIssueV3 | ReviewIssueV4 | null;
  legacy: ReviewFindingV1 | null;
  facts: readonly ReviewFactTuple[];
  uncertainty: readonly string[];
  mismatch: boolean;
}

/** Re-resolve retained fact lineage when a renderer checks its manifest row. */
export function reviewFindingAssociation(
  plan: ReviewDeliveryPlan,
  finding: ReviewDeliveryFinding,
): ReviewFindingAssociation {
  const result = plan.result;
  const retained = finding.retained;
  const mismatch = {
    issue: null,
    legacy: null,
    facts: [],
    uncertainty: [],
    mismatch: true,
  } as const;
  if (
    retained.resultSha256 !== result.originalResultSha256 ||
    retained.index !== finding.sourceIndex ||
    retained.collection !== (finding.source === "issue" ? "issues" : "findings")
  )
    return mismatch;
  if (finding.source === "finding") {
    const legacy = result.findings[retained.index];
    if (!legacy || legacy.id !== finding.originalId || legacy.summary !== finding.text)
      return mismatch;
    return { issue: null, legacy, facts: [], uncertainty: [], mismatch: false };
  }
  const issue = result.issues?.[retained.index];
  if (!issue || issue.id !== finding.originalId || issue.finding !== finding.text) return mismatch;
  const context =
    issue.sourceContextId === null
      ? null
      : result.sourceContexts?.find((item) => item.id === issue.sourceContextId);
  if (issue.sourceContextId !== null && !context) return mismatch;
  const facts: ReviewFactTuple[] = [];
  const uncertainty = [...issue.limitations, ...(context?.limitations ?? [])];
  for (const ref of issue.factRefs) {
    const dimension = context?.dimensions[ref.dimensionIndex];
    const fact = dimension?.facts[ref.factIndex];
    if (!fact || !fact.issueIds.includes(issue.originalId)) return mismatch;
    facts.push([context!.id, ref.dimensionIndex, ref.factIndex, fact.id]);
    if (dimension?.status === "unverified")
      uncertainty.push(`unverified:${dimension.dimension}:${dimension.reason}`);
    if (fact.uncertainty) uncertainty.push(fact.uncertainty);
  }
  facts.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return { issue, legacy: null, facts, uncertainty, mismatch: false };
}

function anchorOrder(left: ReviewDeliveryFinding, right: ReviewDeliveryFinding): number {
  const a = left.disposition;
  const b = right.disposition;
  if (a.kind !== "inline-candidate" || b.kind !== "inline-candidate") return 0;
  return (
    a.anchor.path.localeCompare(b.anchor.path) ||
    a.anchor.side.localeCompare(b.anchor.side) ||
    a.anchor.startLine - b.anchor.startLine ||
    left.inventoryId.localeCompare(right.inventoryId)
  );
}

function sameCore(left: ReviewDeliveryFinding, right: ReviewDeliveryFinding): boolean {
  const { disposition: _left, ...leftCore } = left;
  const { disposition: _right, ...rightCore } = right;
  return canonicalJson(leftCore) === canonicalJson(rightCore);
}

function groupAction(issue: ReviewIssueV3 | ReviewIssueV4) {
  if (!("rich" in issue)) return { kind: "legacy-issue", requiredChange: issue.requiredChange };
  if (issue.rich.status === "unavailable")
    return {
      kind: "rich-unavailable",
      reason: issue.rich.reason,
      requiredChange: issue.requiredChange,
    };
  return { kind: "rich", proposedEdit: issue.rich.proposedEdit, grounding: issue.rich.grounding };
}

function assertUnchanged(baseline: ReviewDeliveryPlan, final: ReviewDeliveryPlan): void {
  for (const key of [
    "target",
    "source",
    "result",
    "snapshotSha256",
    "actor",
    "artifact",
    "capabilities",
    "requestedActions",
  ] as const) {
    if (canonicalJson(baseline[key]) !== canonicalJson(final[key]))
      throw new Error(`Review presentation refused because D1 ${key} changed between plans.`);
  }
  if (baseline.findings.length !== final.findings.length)
    throw new Error(
      "Review presentation refused because D1 inventory length changed between plans.",
    );
  for (const [index, finding] of baseline.findings.entries()) {
    const next = final.findings[index]!;
    if (!sameCore(finding, next))
      throw new Error(
        `Review presentation refused because D1 inventory row ${finding.inventoryId} changed between plans.`,
      );
    if (
      next.disposition.kind === "inline-candidate" &&
      (finding.disposition.kind !== "inline-candidate" ||
        canonicalJson(finding.disposition.anchor) !== canonicalJson(next.disposition.anchor))
    )
      throw new Error(
        `Review presentation refused because D1 anchor ${finding.inventoryId} changed between plans.`,
      );
  }
}

/** Compose deterministic L1 placement without changing any D1 contract or effect. */
export function composeReviewPlacement(
  input: ReviewDeliveryPlanInput<ChangeSourceV1>,
  selection?: ReviewPlacementSelection,
): ReviewPlacementComposition {
  const baseline = createReviewDeliveryPlan({ ...input, extensions: undefined });
  const associations = new Map(
    baseline.findings.map((row) => [row.inventoryId, reviewFindingAssociation(baseline, row)]),
  );
  const groups = new Map<string, ReviewDeliveryFinding[]>();
  const keys = new Map<string, string>();
  for (const row of baseline.findings) {
    const linked = associations.get(row.inventoryId)!;
    const groupable = linked.issue && linked.facts.length > 0 && !linked.mismatch;
    const issue = linked.issue;
    const key =
      groupable && issue
        ? sha256(
            canonicalJson({
              action: groupAction(issue),
              evidence: issue.evidence,
              facts: linked.facts,
            }),
          )
        : `single:${row.inventoryId}`;
    keys.set(row.inventoryId, key);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const decisions = new Map<string, "inline" | "summary" | "retained">();
  const representatives = new Map<string, string>();
  for (const [key, members] of groups) {
    const anchored = members
      .filter((row) => row.disposition.kind === "inline-candidate")
      .sort(anchorOrder);
    const representative =
      anchored[0] ?? [...members].sort((a, b) => a.inventoryId.localeCompare(b.inventoryId))[0]!;
    representatives.set(key, representative.inventoryId);
    for (const row of members) {
      const linked = associations.get(row.inventoryId)!;
      if (linked.mismatch) decisions.set(row.inventoryId, "retained");
      else if (linked.legacy && linked.legacy.recommendation === undefined)
        decisions.set(row.inventoryId, baseline.capabilities.summary ? "summary" : "retained");
      else if (row.disposition.kind !== "inline-candidate")
        decisions.set(row.inventoryId, "inline");
      else if (
        baseline.capabilities.summary &&
        members.length > 1 &&
        row.inventoryId !== representative.inventoryId
      )
        decisions.set(row.inventoryId, "summary");
      else decisions.set(row.inventoryId, "inline");
    }
  }
  const final = createReviewDeliveryPlan({
    ...input,
    extensions: {
      presentation: {
        select: (row) => {
          const proposed = decisions.get(row.inventoryId) ?? "retained";
          const requested = selection?.select(row, proposed) ?? proposed;
          if (requested === "inline" && proposed !== "inline")
            throw new Error(
              `Review placement cannot promote retained finding ${row.inventoryId} to inline.`,
            );
          if (proposed === "retained" && requested !== "retained")
            throw new Error(
              `Review placement cannot promote retained finding ${row.inventoryId} to publication.`,
            );
          if (requested !== "inline" && requested !== "summary" && requested !== "retained")
            throw new Error(
              `Review placement selection for retained finding ${row.inventoryId} is invalid.`,
            );
          return requested;
        },
      },
    },
  });
  assertUnchanged(baseline, final);
  const actionByFinding = new Map<string, ReviewDeliveryAction>();
  for (const action of final.actions) {
    for (const id of action.kind === "publish-inline" ? [action.findingId] : action.findingIds)
      actionByFinding.set(id, action);
  }
  const rows: ReviewPresentationRow[] = final.findings.map((row, index) => {
    const initial = baseline.findings[index]!;
    const linked = associations.get(row.inventoryId)!;
    const key = keys.get(row.inventoryId)!;
    const group = groups.get(key)!;
    const action = actionByFinding.get(row.inventoryId);
    const retainedAction = linked.issue?.requiredChange ?? linked.legacy?.recommendation ?? null;
    const absentAction = linked.legacy !== null && linked.legacy.recommendation === undefined;
    const reason = linked.mismatch
      ? "retained-association-mismatch"
      : absentAction
        ? "action-unavailable"
        : row.disposition.kind === "summary-candidate"
          ? row.disposition.reason
          : row.disposition.kind === "unsupported"
            ? row.disposition.reason
            : "proposed-action";
    return {
      inventoryId: row.inventoryId,
      logicalIssueId: row.logicalIssueId,
      observationId: row.observationId,
      retained: row.retained,
      retainedActionSha256: retainedAction === null ? null : sha256(retainedAction),
      retainedRichSha256:
        linked.issue && "rich" in linked.issue ? sha256(canonicalJson(linked.issue.rich)) : null,
      canonicalIssueId: linked.issue?.id ?? null,
      producerOriginalId: linked.issue?.originalId ?? null,
      producerStepId: linked.issue?.producerStepId ?? null,
      producerSkill: linked.issue?.producerSkill ?? null,
      evidence: linked.issue?.evidence ?? null,
      factRefs: linked.issue?.factRefs ?? [],
      factTuples: linked.facts,
      groupKey: key,
      groupRepresentativeId: representatives.get(key)!,
      groupMemberIds: group.map((member) => member.inventoryId).sort(),
      baselineDisposition: initial.disposition,
      finalDisposition: row.disposition,
      reason,
      limitations: row.limitations,
      uncertainty: linked.uncertainty,
      causality: "unknown" as const,
      consequence: "unknown" as const,
      verification: "unknown" as const,
      plannedActionId: action?.id ?? null,
      unpublished: action === undefined,
    };
  });
  const hasSummary = final.actions.some((action) => action.kind === "publish-summary");
  const allInline = rows.every((row) =>
    final.actions.some(
      (action) => action.kind === "publish-inline" && action.findingId === row.inventoryId,
    ),
  );
  const manifest: ReviewPresentationManifest = {
    kind: "docsfab-review-presentation-manifest",
    targetSha256: final.target.targetSha256,
    sourceSha256: final.source.changeSourceSha256,
    snapshotSha256: final.snapshotSha256,
    resultSha256: final.result.originalResultSha256,
    actor: final.actor,
    artifact: final.artifact,
    capabilities: final.capabilities,
    reviewedHeadSha: final.result.reviewedHeadSha,
    actionSetSha256: sha256(canonicalJson(final.actions)),
    rows,
    affectedPaths: final.affectedPaths,
    reviewScope: final.reviewScope,
    skippedPaths: final.result.skippedPaths ?? [],
    hostedReportUrlCandidate: final.result.hostedReportUrl ?? null,
    inventoryStatus: hasSummary
      ? "summary-planned"
      : allInline
        ? "inline-union-only"
        : "retrieval-unavailable",
    publicationConfirmed: false,
  };
  return deepFreeze({ plan: final, manifest });
}
