// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Literal, effect-free Markdown for an exact D1 transport action. */
import { canonicalJson, sha256 } from "../content-ir/canonical.js";
import type { ReviewIssueV3, ReviewIssueV4 } from "../review/contracts.js";
import type { ReviewDeliveryAction, ReviewDeliveryFinding } from "./contracts.js";
import {
  reviewFindingAssociation,
  type ReviewPlacementComposition,
  type ReviewPresentationRow,
} from "./placement.js";

export interface TrustedReviewLinkContext {
  readonly scmProvider: "gitlab" | "github";
  readonly host: string;
  readonly httpsOrigin: string;
  readonly repositoryId: number;
  readonly baseSha: string;
  readonly headSha: string;
}

export interface ReviewRenderedBody {
  readonly body: string | null;
  readonly diagnostic:
    | "action-mismatch"
    | "manifest-mismatch"
    | "retained-association-mismatch"
    | null;
  readonly publicationConfirmed: false;
}

function safeLabel(value: string): string {
  return (
    value
      .replace(/[\\`*_{}\[\]()#+!|~]/gu, "\\$&")
      .replace(
        /[&<>"']/gu,
        (character) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          })[character]!,
      )
      // GFM resolves character references before its extended autolink pass.
      // The zero-width separator also prevents email and provider mention links.
      .replace(/@/gu, "&#64;&#8203;")
      .replace(/https?:\/\//giu, (scheme) => `${scheme.slice(0, -3)}&#58;//`)
      .replace(/www\./giu, (prefix) => `${prefix.slice(0, -1)}&#46;`)
      .replace(/\r\n|\r|\n/gu, "&#10;")
  );
}

/** A producer value is always inert, including multiline commands and Markdown. */
function literal(value: string): string {
  let longest = 2;
  for (const match of value.matchAll(/~+/gu)) longest = Math.max(longest, match[0].length);
  const fence = "~".repeat(longest + 1);
  return `${fence}text\n${value}${value.endsWith("\n") || value.endsWith("\r") ? "" : "\n"}${fence}`;
}

function exactAction(
  composition: ReviewPlacementComposition,
  action: ReviewDeliveryAction,
): boolean {
  const { plan, manifest } = composition;
  if (
    manifest.actionSetSha256 !== sha256(canonicalJson(plan.actions)) ||
    manifest.targetSha256 !== plan.target.targetSha256 ||
    manifest.sourceSha256 !== plan.source.changeSourceSha256 ||
    manifest.snapshotSha256 !== plan.snapshotSha256 ||
    manifest.resultSha256 !== plan.result.originalResultSha256 ||
    manifest.reviewedHeadSha !== plan.result.reviewedHeadSha ||
    canonicalJson(manifest.actor) !== canonicalJson(plan.actor) ||
    canonicalJson(manifest.artifact) !== canonicalJson(plan.artifact) ||
    canonicalJson(manifest.capabilities) !== canonicalJson(plan.capabilities)
  )
    return false;
  const planned = plan.actions.find((member) => member.id === action.id);
  return planned !== undefined && canonicalJson(planned) === canonicalJson(action);
}

function trustedSourceLink(
  composition: ReviewPlacementComposition,
  finding: ReviewDeliveryFinding,
  context: TrustedReviewLinkContext | undefined,
): string | null {
  if (!context || finding.disposition.kind !== "inline-candidate") return null;
  const { plan } = composition;
  const target = plan.target;
  if (
    context.scmProvider !== target.scmProvider ||
    context.host !== target.host ||
    context.httpsOrigin !== `https://${target.host}` ||
    context.headSha !== target.headSha ||
    context.baseSha !== target.baseSha
  )
    return null;
  const anchor = finding.disposition.anchor;
  if (anchor.side !== "after" || anchor.path !== finding.path) return null;
  let repositoryPath: string;
  if (target.scmProvider === "gitlab") {
    if (
      target.sourceFork ||
      context.repositoryId !== target.projectId ||
      plan.source.source.kind !== "gitlab-merge-request" ||
      plan.source.source.projectId !== target.projectId
    )
      return null;
    repositoryPath = `${plan.source.source.projectPath}/-/blob`;
  } else {
    if (
      target.headRepositoryId === null ||
      target.headRepositoryId !== target.repositoryId ||
      context.repositoryId !== target.repositoryId ||
      plan.source.source.kind !== "github-pull-request" ||
      plan.source.source.repositoryId !== target.repositoryId
    )
      return null;
    repositoryPath = `${plan.source.source.fullName}/blob`;
  }
  // encodeURIComponent leaves parentheses intact, but they delimit Markdown links.
  const encodeSegment = (value: string) =>
    encodeURIComponent(value).replace(/\(/gu, "%28").replace(/\)/gu, "%29");
  const encodePath = (value: string) => value.split("/").map(encodeSegment).join("/");
  return `${context.httpsOrigin}/${encodePath(repositoryPath)}/${encodeSegment(target.headSha)}/${encodePath(anchor.path)}#L${anchor.startLine}`;
}

function retained(
  composition: ReviewPlacementComposition,
  row: ReviewPresentationRow,
): {
  finding: ReviewDeliveryFinding;
  action: string | null;
  title: string;
  issue: ReviewIssueV3 | ReviewIssueV4 | null;
} | null {
  const finding = composition.plan.findings.find((entry) => entry.inventoryId === row.inventoryId);
  if (
    !finding ||
    finding.retained.resultSha256 !== composition.plan.result.originalResultSha256 ||
    canonicalJson(finding.retained) !== canonicalJson(row.retained) ||
    canonicalJson(finding.limitations) !== canonicalJson(row.limitations)
  )
    return null;
  const linked = reviewFindingAssociation(composition.plan, finding);
  if (
    linked.mismatch ||
    canonicalJson(row.factRefs) !== canonicalJson(linked.issue?.factRefs ?? []) ||
    canonicalJson(row.factTuples) !== canonicalJson(linked.facts) ||
    canonicalJson(row.uncertainty) !== canonicalJson(linked.uncertainty)
  )
    return null;
  const collection =
    finding.source === "issue" ? composition.plan.result.issues : composition.plan.result.findings;
  const original = collection?.[finding.retained.index];
  if (
    !original ||
    original.id !== finding.originalId ||
    finding.sourceIndex !== finding.retained.index
  )
    return null;
  if (finding.source === "issue") {
    const issue = composition.plan.result.issues?.[finding.retained.index];
    if (
      !issue ||
      issue.id !== row.canonicalIssueId ||
      issue.originalId !== row.producerOriginalId ||
      issue.producerStepId !== row.producerStepId ||
      issue.producerSkill !== row.producerSkill ||
      issue.finding !== finding.text ||
      canonicalJson(issue.evidence) !== canonicalJson(row.evidence) ||
      row.retainedActionSha256 !== sha256(issue.requiredChange) ||
      row.retainedRichSha256 !== ("rich" in issue ? sha256(canonicalJson(issue.rich)) : null)
    )
      return null;
    return { finding, action: issue.requiredChange, title: issue.finding, issue };
  }
  const legacy = composition.plan.result.findings[finding.retained.index];
  if (
    !legacy ||
    legacy.summary !== finding.text ||
    row.canonicalIssueId !== null ||
    row.retainedRichSha256 !== null
  )
    return null;
  const recommendation = legacy.recommendation ?? null;
  if (row.retainedActionSha256 !== (recommendation === null ? null : sha256(recommendation)))
    return null;
  return { finding, action: recommendation, title: legacy.summary, issue: null };
}

function completeManifestInventory(composition: ReviewPlacementComposition): boolean {
  const findings = new Map(
    composition.plan.findings.map((finding) => [finding.inventoryId, finding]),
  );
  if (
    findings.size !== composition.plan.findings.length ||
    composition.manifest.rows.length !== findings.size
  )
    return false;
  const seen = new Set<string>();
  for (const row of composition.manifest.rows) {
    const finding = findings.get(row.inventoryId);
    if (
      !finding ||
      seen.has(row.inventoryId) ||
      row.logicalIssueId !== finding.logicalIssueId ||
      row.observationId !== finding.observationId ||
      canonicalJson(row.finalDisposition) !== canonicalJson(finding.disposition)
    )
      return false;
    seen.add(row.inventoryId);
  }
  return true;
}

function renderRow(
  composition: ReviewPlacementComposition,
  row: ReviewPresentationRow,
  linkContext: TrustedReviewLinkContext | undefined,
  summaryPlanned = false,
): string {
  const source = retained(composition, row);
  if (!source || row.reason === "retained-association-mismatch")
    return `### Review item unavailable\n\nThe retained evidence does not match this item, so no action text is available.\n\n<details>\n<summary>Review evidence and limitations</summary>\n\nInventory: ${safeLabel(row.inventoryId)}\nReason: retained-association-mismatch\n\n</details>`;
  const { finding, action, title, issue } = source;
  const rich = issue && "rich" in issue ? issue.rich : null;
  const admitted = rich?.status === "admitted" ? rich : null;
  const heading = admitted?.title ?? title;
  const lines = [`### ${safeLabel(heading.split(/\r\n|\r|\n/u)[0] ?? row.inventoryId)}`, ""];
  if (heading.includes("\n") || heading.includes("\r"))
    lines.push("Full title:", literal(heading), "");
  if (admitted) {
    lines.push(
      "Proposed reader consequence:",
      literal(admitted.readerConsequence),
      "",
      "Proposed edit:",
    );
    const edit = admitted.proposedEdit;
    if (edit.kind === "advice") lines.push("Advice:", literal(edit.text));
    else {
      lines.push(
        "Replacement explanation:",
        literal(edit.text),
        "",
        `Proposed path: ${safeLabel(edit.path)}`,
        "",
        "Original span:",
        literal(edit.originalText),
        "",
        "Replacement span:",
        literal(edit.replacementText),
      );
      if (edit.replacementText === "") lines.push("", "Deletion: proposed replacement is empty.");
    }
  } else if (action !== null && row.reason !== "action-unavailable")
    lines.push("Proposed action:", literal(action));
  else lines.push("Proposed action unavailable; this item needs a reviewed recommendation.");
  if (!admitted && (title.includes("\n") || title.includes("\r")))
    lines.push("", "Full finding:", literal(title));
  for (const limitation of row.limitations) {
    if (limitation === "legacy-finding-lineage-unavailable")
      lines.push("", "Qualification: this legacy finding has no canonical source lineage.");
    else lines.push("", "Qualification:", literal(limitation));
  }
  const contextLimitations =
    composition.plan.result.sourceContexts?.find(
      (context) => context.id === finding.sourceContextId,
    )?.limitations ?? [];
  for (const uncertainty of row.uncertainty) {
    if (uncertainty === "none" || row.limitations.includes(uncertainty)) continue;
    lines.push(
      "",
      contextLimitations.includes(uncertainty) ? "Qualification:" : "Uncertainty:",
      literal(uncertainty),
    );
  }
  const sourceLink = trustedSourceLink(composition, finding, linkContext);
  if (sourceLink) lines.push("", `Source: [${safeLabel(finding.path!)}](${sourceLink})`);
  if (row.unpublished) lines.push("", "This item has no planned publish action.");
  if (summaryPlanned)
    lines.push(
      "",
      "More findings and coverage are planned in the review summary; posting has not been confirmed.",
    );
  lines.push(
    "",
    "<details>",
    "<summary>Review evidence and limitations</summary>",
    "",
    `Inventory: ${safeLabel(row.inventoryId)} · issue: ${safeLabel(row.canonicalIssueId ?? "legacy finding")}`,
    `Consequence: ${row.consequence} · change relationship: ${row.causality} · verification: ${row.verification}`,
    `Placement: ${safeLabel(row.reason)}; D1: ${safeLabel(row.baselineDisposition.kind === "inline-candidate" ? "inline-candidate" : row.baselineDisposition.reason)}`,
    `Group: ${safeLabel(row.groupRepresentativeId)} (${row.groupMemberIds.map(safeLabel).join(", ")})`,
    `Retained: ${safeLabel(row.retained.collection)}[${row.retained.index}] · ${safeLabel(row.retained.resultSha256)}`,
    `Planned action: ${safeLabel(row.plannedActionId ?? "none")}`,
  );
  if (row.producerOriginalId !== null)
    lines.push(
      `Producer: ${safeLabel(row.producerOriginalId)} · ${safeLabel(row.producerStepId!)} · ${safeLabel(row.producerSkill!)}`,
    );
  if (row.evidence)
    lines.push(
      `Evidence: ${safeLabel(row.evidence.sourceId)} · ${safeLabel(row.evidence.locator)}`,
    );
  if (admitted) {
    lines.push("Legacy finding:", literal(title), "Legacy proposed action:", literal(action!));
    for (const ground of admitted.grounding) {
      lines.push(
        "Supplied grounding:",
        `Fact ID: ${safeLabel(ground.factId)} · recorded status: ${safeLabel(ground.status)}`,
        "Rationale:",
        literal(ground.rationale),
        "Qualification:",
        literal(ground.qualification),
      );
      for (const locator of ground.sourceLocators) lines.push("Source locator:", literal(locator));
    }
  } else if (rich?.status === "unavailable")
    lines.push(`Rich proposal unavailable: ${safeLabel(rich.reason)}`);
  for (const tuple of row.factTuples)
    lines.push(`Fact: ${tuple.map((part) => safeLabel(String(part))).join(" / ")}`);
  for (const limitation of row.limitations)
    if (limitation === "legacy-finding-lineage-unavailable")
      lines.push(`Limitation: ${limitation}`);
  lines.push("", "</details>");
  return lines.join("\n");
}

/** Called with the exact plan/action at a future provider inline transport seam. */
export function renderInlinePresentation(
  composition: ReviewPlacementComposition,
  action: Extract<ReviewDeliveryAction, { kind: "publish-inline" }>,
  linkContext?: TrustedReviewLinkContext,
): ReviewRenderedBody {
  if (!exactAction(composition, action))
    return { body: null, diagnostic: "action-mismatch", publicationConfirmed: false };
  if (!completeManifestInventory(composition))
    return { body: null, diagnostic: "manifest-mismatch", publicationConfirmed: false };
  const row = composition.manifest.rows.find((entry) => entry.inventoryId === action.findingId);
  if (!row || row.plannedActionId !== action.id || row.finalDisposition.kind !== "inline-candidate")
    return { body: null, diagnostic: "manifest-mismatch", publicationConfirmed: false };
  if (!retained(composition, row) || row.reason === "retained-association-mismatch")
    return { body: null, diagnostic: "retained-association-mismatch", publicationConfirmed: false };
  const summary = composition.plan.actions.find((member) => member.kind === "publish-summary");
  return {
    body: renderRow(composition, row, linkContext, summary !== undefined),
    diagnostic: null,
    publicationConfirmed: false,
  };
}

/** One complete ordinary provider summary body for every retained row and scope. */
export function renderSummaryPresentation(
  composition: ReviewPlacementComposition,
  action: Extract<ReviewDeliveryAction, { kind: "publish-summary" }>,
  linkContext?: TrustedReviewLinkContext,
): ReviewRenderedBody {
  if (!exactAction(composition, action))
    return { body: null, diagnostic: "action-mismatch", publicationConfirmed: false };
  if (!completeManifestInventory(composition))
    return { body: null, diagnostic: "manifest-mismatch", publicationConfirmed: false };
  if (
    composition.manifest.rows.some(
      (row) =>
        row.plannedActionId !==
          composition.plan.actions.find(
            (member) => member.kind === "publish-inline" && member.findingId === row.inventoryId,
          )?.id &&
        row.plannedActionId !== action.id &&
        row.plannedActionId !== null,
    )
  )
    return { body: null, diagnostic: "manifest-mismatch", publicationConfirmed: false };
  const manifest = composition.manifest;
  const lines = [
    "## DocsFab review",
    "",
    manifest.reviewScope
      ? `Coverage: ${manifest.reviewScope.reviewedCount} reviewed${manifest.reviewScope.corpusFileCount === null ? "" : ` of ${manifest.reviewScope.corpusFileCount}`} files; ${manifest.reviewScope.deferredPaths.length} deferred.`
      : "Coverage was not recorded.",
  ];
  const associationMismatch = manifest.rows.some(
    (row) => !retained(composition, row) || row.reason === "retained-association-mismatch",
  );
  for (const row of manifest.rows) lines.push("", renderRow(composition, row, linkContext));
  lines.push(
    "",
    "<details>",
    "<summary>Review evidence and limitations</summary>",
    "",
    `Reviewed head: ${safeLabel(manifest.reviewedHeadSha)}`,
    `Presentation: ${manifest.inventoryStatus}; publication unconfirmed.`,
    `Affected paths: ${manifest.affectedPaths.map(safeLabel).join(", ") || "none recorded"}`,
    `Coverage: ${manifest.reviewScope ? `${safeLabel(manifest.reviewScope.scope)}; reviewed ${manifest.reviewScope.reviewedCount}; deferred ${manifest.reviewScope.deferredPaths.map(safeLabel).join(", ") || "none"}` : "not recorded"}`,
  );
  for (const skipped of manifest.skippedPaths)
    lines.push(`Skipped: ${safeLabel(skipped.path)} · ${safeLabel(skipped.reason)}`);
  for (const page of manifest.reviewScope?.templateCoverage?.pages ?? []) {
    lines.push(
      `Template coverage: ${safeLabel(page.path)} · mapping ${page.mapping}${page.templateId === null ? "" : ` (${safeLabel(page.templateId)})`} · applicability ${page.applicability} · conformance ${page.conformance} · ${safeLabel(page.reason)}; rubric ${page.rubric.status} (${safeLabel(page.rubric.reason)}).`,
    );
    for (const rule of page.rules)
      lines.push(
        `Template rule: ${safeLabel(page.path)} · ${safeLabel(rule.rule)} · ${rule.severity} · expected ${safeLabel(rule.expected)}${rule.line === null ? "" : ` · line ${rule.line}`}.`,
      );
    for (const id of page.suggestionIds)
      lines.push(`Template suggestion: ${safeLabel(page.path)} · ${safeLabel(id)}.`);
  }
  if (manifest.hostedReportUrlCandidate)
    lines.push(
      `Hosted report candidate (access and L1 inventory unconfirmed):\n${literal(manifest.hostedReportUrlCandidate)}`,
    );
  lines.push("", "</details>");
  return {
    body: lines.join("\n"),
    diagnostic: associationMismatch ? "retained-association-mismatch" : null,
    publicationConfirmed: false,
  };
}
