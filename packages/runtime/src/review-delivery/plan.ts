// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalJson, sha256 } from "../content-ir/canonical.js";
import { createHostAuthorityFactory, deepFreeze } from "../contract-kit/index.js";
import type { ChangeSourceV1 } from "../inputs/change-source.js";
import {
  assertReviewTargetV2Source,
  projectReviewResultV1,
  type ReviewTargetMigrationV1,
} from "../review/target-migration.js";
import type { ReviewIssueV3, ReviewTargetV2 } from "../review/contracts.js";
import {
  resolveReviewLocator,
  type ReviewLocatorLimitation,
} from "../review/locator-provenance.js";
import { resolveReviewAnchor, type ReviewDiffFile, type ReviewSourceLocation } from "./anchors.js";
import { copySnapshot, snapshotDigest } from "./snapshot-digest.js";
import {
  ReviewDeliveryError,
  type ReviewDeliveryAction,
  type ReviewDeliveryActionBinding,
  type ReviewDeliveryExtensions,
  type ReviewDeliveryFinding,
  type ReviewDeliveryGrant,
  type ReviewDeliveryGrantVerifier,
  type ReviewDeliveryPlan,
  type ReviewDeliveryPlanInput,
  type ReviewDeliverySnapshot,
  type SuggestionCompiler,
} from "./contracts.js";

const grants = createHostAuthorityFactory<
  "docsfab-review-delivery-grant",
  ReviewDeliveryGrantVerifier
>({
  kind: "docsfab-review-delivery-grant",
  invalidMessage: "Review delivery grant verifier must expose verifyCurrent.",
});

function rejectDelivery(code: ReviewDeliveryError["code"]): never {
  throw new ReviewDeliveryError(code);
}

export function createReviewDeliveryGrant(
  verifier: ReviewDeliveryGrantVerifier,
): ReviewDeliveryGrant {
  return grants.create(verifier);
}

export {
  admittedReviewSourceSidePresence,
  reviewDeliverySnapshotDigest,
} from "./snapshot-digest.js";

function resolveDisposition(
  location: ReviewSourceLocation | null,
  snapshot: ReviewDeliverySnapshot,
  capabilities: ReviewDeliveryPlanInput["capabilities"],
): ReviewDeliveryFinding["disposition"] {
  if (location === null) {
    return capabilities.summary
      ? { kind: "summary-candidate", reason: "no-location" }
      : { kind: "unsupported", reason: "provider-unsupported" };
  }
  const anchor = resolveReviewAnchor(location, snapshot.files);
  if (anchor.status === "anchored" && capabilities.inline)
    return { kind: "inline-candidate", anchor };
  if (capabilities.summary)
    return {
      kind: "summary-candidate",
      reason: anchor.status === "summary" ? anchor.reason : "inline-unavailable",
    };
  return { kind: "unsupported", reason: "provider-unsupported" };
}

function issueLocation(issue: ReviewIssueV3): ReviewSourceLocation | null {
  if (issue.path === null || issue.line === null || issue.locationFidelity !== "exact") return null;
  return { path: issue.path, line: issue.line };
}

function actionId(action: Omit<ReviewDeliveryAction, "id">): string {
  return sha256(canonicalJson(action));
}

/** Pure, deterministic projection from saved canonical evidence to requested effects. */
export function createReviewDeliveryPlan(
  input: ReviewDeliveryPlanInput<ChangeSourceV1>,
): ReviewDeliveryPlan<ChangeSourceV1> {
  const requestedActions = input.requestedActions;
  if (
    requestedActions !== undefined &&
    requestedActions !== "overview" &&
    requestedActions !== "summary-only"
  )
    rejectDelivery("invalid-requested-actions");
  if (requestedActions !== undefined && input.capabilities.summary !== true)
    rejectDelivery("summary-unavailable");
  const targetValue = input.target as ReviewTargetV2 | ReviewTargetMigrationV1;
  const target = structuredClone(
    "targetProjection" in targetValue ? targetValue.targetProjection : targetValue,
  );
  const source = structuredClone(assertReviewTargetV2Source(target, input.source));
  const result = structuredClone(projectReviewResultV1(input.result, targetValue));
  if (
    result.reviewedHeadSha !== target.headSha ||
    result.targetProjection.targetSha256 !== target.targetSha256
  )
    rejectDelivery("result-mismatch");
  if (
    input.artifact.kind !== "retained-review-result" ||
    input.artifact.resultSha256 !== result.originalResultSha256
  )
    rejectDelivery("artifact-mismatch");
  if (input.actor.host !== target.host || input.actor.id.length === 0)
    rejectDelivery("actor-mismatch");
  if (
    input.capabilities.host !== target.host ||
    input.capabilities.scmProvider !== target.scmProvider
  )
    rejectDelivery("capability-mismatch");
  // All authoritative planning inputs are detached before invoking any extension.
  const snapshot = copySnapshot(input.snapshot);
  const digest = snapshotDigest(snapshot, source);
  const actor = { host: input.actor.host, id: input.actor.id };
  const artifact = {
    kind: input.artifact.kind,
    id: input.artifact.id,
    resultSha256: input.artifact.resultSha256,
  };
  const capabilities = { ...input.capabilities };
  const binding: ReviewDeliveryActionBinding = {
    target,
    sourceSha256: source.changeSourceSha256,
    snapshotSha256: digest,
    artifact,
    actor,
    reviewedHeadSha: result.reviewedHeadSha,
    startSha: source.source.kind === "gitlab-merge-request" ? source.source.diffRefs.start : null,
  };
  const findings: ReviewDeliveryFinding[] = [];
  const rawEntries = [
    ...(result.issues ?? []).map((issue, sourceIndex) => ({
      source: "issue" as const,
      sourceIndex,
      issue,
    })),
    ...result.findings.map((finding, sourceIndex) => ({
      source: "finding" as const,
      sourceIndex,
      finding,
    })),
  ];
  for (const entry of rawEntries) {
    const issue = "issue" in entry ? entry.issue : null;
    const finding = "finding" in entry ? entry.finding : null;
    const originalId = issue?.id ?? finding!.id;
    const logicalIssueId =
      issue === null ? `legacy:${result.originalResultSha256}:${originalId}` : `issue:${issue.id}`;
    const inventoryId = `${entry.source}:${entry.sourceIndex}:${originalId}`;
    const observationId = sha256(
      canonicalJson({
        logicalIssueId,
        targetSha256: target.targetSha256,
        reviewedHeadSha: result.reviewedHeadSha,
        resultSha256: result.originalResultSha256,
      }),
    );
    const path = issue?.path ?? finding?.path ?? null;
    const context =
      issue?.sourceContextId === null || issue === null
        ? undefined
        : result.sourceContexts?.find((item) => item.id === issue.sourceContextId);
    const factLocators =
      issue?.factRefs.flatMap(
        (ref) =>
          context?.dimensions[ref.dimensionIndex]?.facts[ref.factIndex]?.sourceLocators ?? [],
      ) ?? [];
    const location =
      issue !== null
        ? issueLocation(issue)
        : finding?.path !== null && finding?.line !== undefined
          ? { path: finding.path, line: finding.line }
          : null;
    let locatorLimitation: ReviewLocatorLimitation | null = null;
    let admittedLocation = location;
    if (input.locatorEvidence !== undefined && location !== null) {
      if (input.locatorEvidence.kind === "unavailable") {
        locatorLimitation = input.locatorEvidence.reason;
      } else if (issue === null || issue.path === null || issue.line === null) {
        locatorLimitation = "read-unobserved";
      } else {
        const candidate = snapshot.files.find(
          (file) => file.newPath === issue.path && file.afterBytes !== null,
        );
        const resolved =
          candidate?.afterBytes === null || candidate === undefined
            ? { kind: "unavailable" as const, reason: "binding-mismatch" as const }
            : resolveReviewLocator(input.locatorEvidence.authority, {
                resultSha256: result.originalResultSha256,
                sourceSha256: source.changeSourceSha256,
                reviewedHeadSha: result.reviewedHeadSha,
                snapshotSha256: digest,
                collection: "issues",
                index: entry.sourceIndex,
                id: issue.id,
                path: issue.path,
                line: issue.line,
                file: {
                  oldPath: candidate.oldPath,
                  newPath: candidate.newPath,
                  afterBytes: candidate.afterBytes,
                  afterSha256: candidate.afterSha256,
                },
              });
        if (resolved.kind === "verified") admittedLocation = resolved;
        else locatorLimitation = resolved.reason;
      }
    }
    const disposition =
      locatorLimitation === null
        ? resolveDisposition(admittedLocation, snapshot, capabilities)
        : capabilities.summary
          ? { kind: "summary-candidate" as const, reason: "inline-unavailable" as const }
          : { kind: "unsupported" as const, reason: "provider-unsupported" as const };
    const draft: ReviewDeliveryFinding = {
      inventoryId,
      logicalIssueId,
      observationId,
      source: entry.source,
      sourceIndex: entry.sourceIndex,
      retained: {
        resultSha256: result.originalResultSha256,
        collection: issue === null ? "findings" : "issues",
        index: entry.sourceIndex,
      },
      originalId,
      severity: issue?.severity ?? finding!.severity,
      text: issue?.finding ?? finding!.summary,
      path,
      relatedLocations:
        issue === null
          ? []
          : [...new Set([issue.location, issue.evidence.locator, ...factLocators])],
      groupIds: [
        ...(path === null ? [] : [`path:${path}`]),
        ...(context === undefined ? [] : [`context:${context.id}`]),
      ],
      limitations: [
        ...(issue?.limitations ?? (finding === null ? [] : ["legacy-finding-lineage-unavailable"])),
        ...(locatorLimitation === null ? [] : [`review-locator:${locatorLimitation}`]),
      ],
      sourceContextId: issue?.sourceContextId ?? null,
      evidence: issue?.evidence ?? null,
      disposition,
    };
    findings.push(draft);
  }
  const presentedFindings = findings.map((draft) => {
    let disposition = draft.disposition;
    const selection = input.extensions?.presentation?.select(deepFreeze(structuredClone(draft)));
    if (selection === "summary" && disposition.kind === "inline-candidate")
      disposition = capabilities.summary
        ? { kind: "summary-candidate", reason: "presentation-policy" }
        : { kind: "unsupported", reason: "provider-unsupported" };
    else if (selection === "retained")
      disposition = { kind: "unsupported", reason: "presentation-unsupported" };
    if (requestedActions === "summary-only" && disposition.kind === "inline-candidate")
      disposition = { kind: "summary-candidate", reason: "delivery-intent" };
    return { ...draft, disposition };
  });
  const actions: ReviewDeliveryAction[] = [];
  const summaryIds = presentedFindings
    .filter((finding) => finding.disposition.kind === "summary-candidate")
    .map((finding) => finding.inventoryId);
  if (summaryIds.length > 0 || requestedActions !== undefined) {
    const operation = { kind: "publish-summary" as const, binding, findingIds: summaryIds };
    actions.push({ ...operation, id: actionId(operation) });
  }
  for (const finding of presentedFindings) {
    if (finding.disposition.kind !== "inline-candidate") continue;
    const operation = {
      kind: "publish-inline" as const,
      binding,
      findingId: finding.inventoryId,
      logicalIssueId: finding.logicalIssueId,
      anchor: finding.disposition.anchor,
    };
    actions.push({ ...operation, id: actionId(operation) });
  }
  return deepFreeze({
    kind: "docsfab-review-delivery-plan" as const,
    schemaVersion: 1 as const,
    target,
    source,
    result,
    snapshotSha256: digest,
    artifact,
    actor,
    capabilities,
    ...(requestedActions === undefined ? {} : { requestedActions }),
    findings: presentedFindings,
    actions,
    checks: result.checks,
    unresolvedQuestions: result.unresolvedQuestions,
    affectedPaths: result.affectedPaths,
    ...(result.reviewScope === undefined ? {} : { reviewScope: result.reviewScope }),
    ...(result.sourceContexts === undefined ? {} : { sourceContexts: result.sourceContexts }),
    limitations: [
      ...(result.issues === undefined ? ["canonical-issue-graph-absent"] : []),
      ...(result.reviewScope === undefined ? ["coverage-absent"] : []),
      ...(result.skippedPaths ?? []).map((path) => `skipped:${path.path}:${path.reason}`),
    ],
  });
}

/** Check one exact planned operation through an opaque host grant immediately before effect. */
export function admitReviewDeliveryAction(
  plan: ReviewDeliveryPlan,
  action: ReviewDeliveryAction,
  grant: ReviewDeliveryGrant,
):
  | { readonly status: "admitted" }
  | {
      readonly status: "blocked";
      readonly reason: "authority-required" | "action-mismatch" | "grant-mismatch";
    } {
  const current = plan.actions.find((item) => item.id === action.id);
  if (!current || canonicalJson(current) !== canonicalJson(action))
    return { status: "blocked", reason: "action-mismatch" };
  const { id: _id, ...intent } = current;
  if (actionId(intent) !== current.id) return { status: "blocked", reason: "action-mismatch" };
  const verifier = grants.lookup(grant);
  if (verifier === undefined) return { status: "blocked", reason: "authority-required" };
  const decision = verifier.verifyCurrent(current);
  if (
    decision.status !== "admitted" ||
    decision.actionId !== current.id ||
    decision.kind !== current.kind
  )
    return { status: "blocked", reason: "grant-mismatch" };
  return { status: "admitted" };
}

export function discoverReviewDeliveryExtensions(extensions: ReviewDeliveryExtensions = {}) {
  return {
    presentation: extensions.presentation !== undefined,
    suggestions: extensions.suggestions !== undefined,
    revisions: extensions.revisions !== undefined,
    replies: extensions.replies !== undefined,
    feedback: extensions.feedback !== undefined,
  } as const;
}

export function compileReviewSuggestion(
  extensions: ReviewDeliveryExtensions<ChangeSourceV1> | undefined,
  plan: ReviewDeliveryPlan<ChangeSourceV1>,
  action: ReviewDeliveryAction,
  grant: ReviewDeliveryGrant,
): ReturnType<SuggestionCompiler<ChangeSourceV1>["compile"]> {
  if (extensions?.suggestions === undefined)
    return { kind: "unsupported", reason: "not-registered" };
  if (action.kind !== "publish-inline") return { kind: "unsupported", reason: "not-inline" };
  if (admitReviewDeliveryAction(plan, action, grant).status !== "admitted")
    return { kind: "unsupported", reason: "not-admitted" };
  const finding = plan.findings.find((item) => item.inventoryId === action.findingId);
  if (!finding || finding.disposition.kind !== "inline-candidate")
    return { kind: "unsupported", reason: "not-inline" };
  return extensions.suggestions.compile({
    finding,
    anchor: finding.disposition.anchor,
    source: plan.source,
  });
}
