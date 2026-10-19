// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { createHostAuthorityFactory } from "../contract-kit/index.js";
import { canonicalJson, sha256 } from "../content-ir/canonical.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import { createReviewTarget, decodeReviewResult } from "../review/contracts.js";
import {
  assertReviewTargetV2Source,
  migrateReviewTargetToV2,
  projectReviewResultV1,
  type ReviewResultProjectionV1,
  type ReviewTargetMigrationV1,
} from "../review/target-migration.js";
import type { ReviewTargetV2 } from "../review/contracts.js";
import type { ChangeSourceV1 } from "../inputs/change-source.js";
import type { DurableArtifactStore } from "../artifacts/store.js";
import type { FileRunStore } from "../records/file-store.js";
import type { ScmDeliveryReceiptStore } from "../delivery/receipt-store.js";
import type {
  ReviewDeliveryActor,
  ReviewDeliveryPlan,
  ReviewDeliveryRequestedActions,
  ReviewDeliverySnapshot,
} from "./contracts.js";
import { createReviewDeliveryPlan } from "./plan.js";
import {
  assertReviewDeliveryRecordShape,
  createReviewDeliveryImportRecord,
  reviewDeliveryImportedLineageMatches,
  createReviewDeliveryManifest,
  updateReviewDeliveryRecord,
  reviewDeliveryRecordSha256,
  type ReviewDeliveryManifestV1,
  type ReviewDeliveryRecordV1,
} from "./receipt.js";

export type ReviewDeliveryOriginAdmission = {
  readonly kind: "docsfab-review-delivery-origin-admission";
};
export type ReviewDeliveryCorrelationAdmission = {
  readonly kind: "docsfab-review-delivery-correlation-admission";
};
export type ReviewDeliveryCustodyAdmission = {
  readonly kind: "docsfab-review-delivery-custody-admission";
};

export interface ReviewDeliveryCustodyAdmissionInput extends ReviewDeliveryOriginAdmissionInput {
  readonly phase: "execute" | "export" | "import" | "ack";
  readonly expectedGeneration: number | null;
  readonly transferId: string | null;
  readonly sourceStoreId: string | null;
  readonly sourceGeneration: number | null;
  readonly destinationStoreId: string | null;
  readonly fencedRecordSha256: string | null;
}

export type ReviewDeliveryCustodyDecision =
  | {
      readonly status: "admitted";
      readonly originStoreId: string;
      readonly storeId: string;
      readonly generation: number | null;
      readonly state: ReviewDeliveryRecordV1["custody"]["state"] | null;
      readonly transferId: string | null;
    }
  | { readonly status: "blocked" };

export interface ReviewDeliveryCustodySource {
  loadFencedTransfer(input: {
    readonly manifest: ReviewDeliveryManifestV1;
    readonly plan: ReviewDeliveryPlan;
    readonly sourceStoreId: string;
    readonly destinationStoreId: string;
    readonly sourceGeneration: number;
    readonly transferId: string;
  }): Promise<ReviewDeliveryRecordV1 | null>;
}

export interface ReviewDeliveryCustodyVerifier extends ReviewDeliveryCustodySource {
  identifyConfiguredStore(store: ScmDeliveryReceiptStore): string | null;
  verifyCurrent(input: ReviewDeliveryCustodyAdmissionInput): Promise<ReviewDeliveryCustodyDecision>;
}

export interface ReviewDeliveryOriginAdmissionInput {
  readonly manifest: ReviewDeliveryManifestV1;
  readonly plan: ReviewDeliveryPlan;
  readonly requestedStore: ScmDeliveryReceiptStore;
}

export interface ReviewDeliveryOriginVerifier {
  verifyCurrent(
    input: ReviewDeliveryOriginAdmissionInput,
  ): Promise<
    { readonly status: "admitted"; readonly storeId: string } | { readonly status: "blocked" }
  >;
}

export interface ReviewDeliveryCorrelationPolicyVerifier {
  verifyCurrent(input: {
    readonly logicalDeliveryId: string;
    readonly effectId: string;
    readonly target: ReviewTargetV2;
    readonly actor: ReviewDeliveryActor;
    readonly requestedStore: string;
    readonly nonce: string;
  }):
    | Promise<
        | {
            readonly status: "supported";
            readonly channel: "exclusive-actor-writer-complete-stable-notes";
          }
        | { readonly status: "unsupported" }
      >
    | {
        readonly status: "supported";
        readonly channel: "exclusive-actor-writer-complete-stable-notes";
      }
    | { readonly status: "unsupported" };
}

const originAuthorities = createHostAuthorityFactory<
  "docsfab-review-delivery-origin-admission",
  ReviewDeliveryOriginVerifier
>({
  kind: "docsfab-review-delivery-origin-admission",
  invalidMessage: "Review delivery origin admission requires verifyCurrent.",
});
const custodyAuthorities = createHostAuthorityFactory<
  "docsfab-review-delivery-custody-admission",
  ReviewDeliveryCustodyVerifier
>({
  kind: "docsfab-review-delivery-custody-admission",
  invalidMessage:
    "Review delivery custody admission requires configured verification and source lookup.",
});
const correlationAuthorities = createHostAuthorityFactory<
  "docsfab-review-delivery-correlation-admission",
  ReviewDeliveryCorrelationPolicyVerifier
>({
  kind: "docsfab-review-delivery-correlation-admission",
  invalidMessage: "Review delivery correlation admission requires verifyCurrent.",
});

function digest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalizeJsonEvidence(value as JsonEvidenceValue))
    .digest("hex");
}

function localReviewStoreId(receiptRoot: string, runId: string, artifactDigest: string): string {
  return digest({
    domain: "docsfab-review-origin-store-v1",
    configuredReceiptRoot: resolve(receiptRoot),
    runId,
    artifactDigest,
  });
}

function fencedRecordSha(record: ReviewDeliveryRecordV1): string | null {
  if (record.custody.state === "fenced-out") return record.sha256;
  if (record.custody.state !== "transferred") return null;
  const { sha256: _sha, ...body } = {
    ...record,
    custody: { ...record.custody, state: "fenced-out" as const },
  };
  return reviewDeliveryRecordSha256(body);
}

function retainedProjection(
  originalResult: unknown,
  target: ReviewTargetV2,
  sourceValue: ChangeSourceV1,
): {
  readonly projection: ReviewResultProjectionV1;
  readonly targetValue: ReviewTargetV2 | ReviewTargetMigrationV1;
} {
  if (
    typeof originalResult === "object" &&
    originalResult !== null &&
    (originalResult as { schemaVersion?: unknown }).schemaVersion === 4
  )
    return { projection: projectReviewResultV1(originalResult, target), targetValue: target };

  // Historical GitLab results are admitted through D1's sealed migration,
  // including the original target digest and the entire provider-V2 mapping.
  const original = decodeReviewResult(originalResult);
  if (target.scmProvider !== "gitlab")
    throw new Error("Retained legacy review result does not match the requested target.");
  const legacyTarget = createReviewTarget({
    scmProvider: "gitlab",
    host: target.host,
    projectId: target.projectId,
    mergeRequestIid: target.mergeRequestIid,
    sourceBranch: target.sourceBranch,
    targetBranch: target.targetBranch,
    headSha: target.headSha,
    trigger: target.trigger,
    requestIdentitySha256: target.requestIdentitySha256,
    workflow: target.workflow,
    deliveryIntent: target.deliveryIntent,
    logicalRequestId: target.logicalRequestId,
  });
  if (legacyTarget.targetSha256 !== original.targetSha256)
    throw new Error("Retained legacy review target digest differs from the requested target.");
  const migration = migrateReviewTargetToV2(legacyTarget, sourceValue);
  if (digest(migration.targetProjection) !== digest(target))
    throw new Error("Retained legacy review migration differs from the requested target.");
  return { projection: projectReviewResultV1(original, migration), targetValue: migration };
}

function inlineAnchorsMatch(plan: ReviewDeliveryPlan, baseline: ReviewDeliveryPlan): boolean {
  const original = new Map(baseline.findings.map((finding) => [finding.inventoryId, finding]));
  return plan.findings.every((finding) => {
    if (finding.disposition.kind !== "inline-candidate") return true;
    const retained = original.get(finding.inventoryId);
    return (
      retained?.disposition.kind === "inline-candidate" &&
      digest(finding.disposition.anchor) === digest(retained.disposition.anchor)
    );
  });
}

// Keep this closed set aligned with ReviewLocatorLimitation in review/locator-provenance.ts.
// Locator authority is consumed by the D1 planner; the retained plan carries only its
// non-dispatching fallback diagnostic, not independent proof of the failure cause.
const LOCATOR_LIMITATIONS = new Set([
  "legacy-unavailable",
  "read-unobserved",
  "source-blob-unavailable",
  "binding-mismatch",
  "observation-invalid",
]);

function findingLimitationsMatch(
  actual: ReviewDeliveryPlan["findings"][number],
  retained: readonly string[],
  hasLocation: boolean,
  summarySupported: boolean,
): boolean {
  if (digest(actual.limitations) === digest(retained)) return true;
  if (!hasLocation || actual.limitations.length !== retained.length + 1) return false;
  if (digest(actual.limitations.slice(0, retained.length)) !== digest(retained)) return false;
  const terminal = actual.limitations[retained.length];
  if (terminal === undefined || !terminal.startsWith("review-locator:")) return false;
  if (!LOCATOR_LIMITATIONS.has(terminal.slice("review-locator:".length))) return false;
  // D1 applies presentation after locator fallback, so an explicitly retained
  // item keeps the closed diagnostic without claiming summary coverage.
  if (
    actual.disposition.kind === "unsupported" &&
    actual.disposition.reason === "presentation-unsupported"
  )
    return true;
  return summarySupported
    ? actual.disposition.kind === "summary-candidate" &&
        actual.disposition.reason === "inline-unavailable"
    : actual.disposition.kind === "unsupported" &&
        actual.disposition.reason === "provider-unsupported";
}

function planProjectionMatches(
  plan: ReviewDeliveryPlan,
  projection: ReviewResultProjectionV1,
  requestedActions: ReviewDeliveryRequestedActions | undefined,
): boolean {
  if (
    (requestedActions === undefined
      ? Object.hasOwn(plan, "requestedActions")
      : plan.requestedActions !== requestedActions) ||
    digest(plan.result) !== digest(projection) ||
    digest(plan.checks) !== digest(projection.checks) ||
    digest(plan.unresolvedQuestions) !== digest(projection.unresolvedQuestions) ||
    digest(plan.affectedPaths) !== digest(projection.affectedPaths) ||
    digest(plan.reviewScope ?? null) !== digest(projection.reviewScope ?? null) ||
    digest(plan.sourceContexts ?? null) !== digest(projection.sourceContexts ?? null) ||
    digest(plan.limitations) !==
      digest([
        ...(projection.issues === undefined ? ["canonical-issue-graph-absent"] : []),
        ...(projection.reviewScope === undefined ? ["coverage-absent"] : []),
        ...(projection.skippedPaths ?? []).map((path) => `skipped:${path.path}:${path.reason}`),
      ])
  )
    return false;
  const entries = [
    ...(projection.issues ?? []).map((issue, sourceIndex) => ({
      source: "issue" as const,
      sourceIndex,
      issue,
    })),
    ...projection.findings.map((finding, sourceIndex) => ({
      source: "finding" as const,
      sourceIndex,
      finding,
    })),
  ];
  if (plan.findings.length !== entries.length) return false;
  if (
    !entries.every((entry, index) => {
      const issue = "issue" in entry ? entry.issue : null;
      const finding = "finding" in entry ? entry.finding : null;
      const originalId = issue?.id ?? finding!.id;
      const logicalIssueId =
        issue === null
          ? `legacy:${projection.originalResultSha256}:${originalId}`
          : `issue:${issue.id}`;
      const path = issue?.path ?? finding?.path ?? null;
      const context =
        issue?.sourceContextId === null || issue === null
          ? undefined
          : projection.sourceContexts?.find((item) => item.id === issue.sourceContextId);
      const factLocators =
        issue?.factRefs.flatMap(
          (ref) =>
            context?.dimensions[ref.dimensionIndex]?.facts[ref.factIndex]?.sourceLocators ?? [],
        ) ?? [];
      const expected = {
        inventoryId: `${entry.source}:${entry.sourceIndex}:${originalId}`,
        logicalIssueId,
        observationId: sha256(
          canonicalJson({
            logicalIssueId,
            targetSha256: plan.target.targetSha256,
            reviewedHeadSha: projection.reviewedHeadSha,
            resultSha256: projection.originalResultSha256,
          }),
        ),
        source: entry.source,
        sourceIndex: entry.sourceIndex,
        retained: {
          resultSha256: projection.originalResultSha256,
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
        limitations:
          issue?.limitations ?? (finding === null ? [] : ["legacy-finding-lineage-unavailable"]),
        sourceContextId: issue?.sourceContextId ?? null,
        evidence: issue?.evidence ?? null,
      };
      const actual = plan.findings[index];
      if (!actual) return false;
      const {
        disposition: _disposition,
        limitations: _limitations,
        ...withoutDisposition
      } = actual;
      const { limitations: retainedLimitations, ...withoutLimitations } = expected;
      return (
        digest(withoutDisposition) === digest(withoutLimitations) &&
        findingLimitationsMatch(
          actual,
          retainedLimitations,
          (issue !== null &&
            issue.path !== null &&
            issue.line !== null &&
            issue.locationFidelity === "exact") ||
            (finding !== null && finding.path !== null && finding.line !== undefined),
          plan.capabilities.summary,
        )
      );
    })
  )
    return false;
  if (
    plan.capabilities.host !== plan.target.host ||
    plan.capabilities.scmProvider !== plan.target.scmProvider
  )
    return false;
  const summaryIds = plan.findings
    .filter((finding) => finding.disposition.kind === "summary-candidate")
    .map((finding) => finding.inventoryId);
  const inlineFindings = plan.findings.filter(
    (finding) => finding.disposition.kind === "inline-candidate",
  );
  const wantsSummary = summaryIds.length > 0 || requestedActions !== undefined;
  if (
    (wantsSummary && !plan.capabilities.summary) ||
    (requestedActions === "summary-only" && inlineFindings.length > 0) ||
    (inlineFindings.length > 0 && !plan.capabilities.inline) ||
    plan.actions.length !== (wantsSummary ? 1 : 0) + inlineFindings.length
  )
    return false;
  const planSource = plan.source as ChangeSourceV1;
  const binding = {
    target: plan.target,
    sourceSha256: planSource.changeSourceSha256,
    snapshotSha256: plan.snapshotSha256,
    artifact: plan.artifact,
    actor: plan.actor,
    reviewedHeadSha: projection.reviewedHeadSha,
    startSha:
      planSource.source.kind === "gitlab-merge-request" ? planSource.source.diffRefs.start : null,
  };
  let actionIndex = 0;
  if (wantsSummary) {
    const action = plan.actions[actionIndex++];
    if (
      action?.kind !== "publish-summary" ||
      digest(action.findingIds) !== digest(summaryIds) ||
      digest(action.binding) !== digest(binding) ||
      action.id !== sha256(canonicalJson({ kind: action.kind, binding, findingIds: summaryIds }))
    )
      return false;
  }
  for (const finding of inlineFindings) {
    const action = plan.actions[actionIndex++];
    if (
      action?.kind !== "publish-inline" ||
      action.findingId !== finding.inventoryId ||
      action.logicalIssueId !== finding.logicalIssueId ||
      finding.disposition.kind !== "inline-candidate" ||
      digest(action.anchor) !== digest(finding.disposition.anchor) ||
      digest(action.binding) !== digest(binding) ||
      action.id !==
        sha256(
          canonicalJson({
            kind: action.kind,
            binding,
            findingId: finding.inventoryId,
            logicalIssueId: finding.logicalIssueId,
            anchor: finding.disposition.anchor,
          }),
        )
    )
      return false;
  }
  return true;
}

function presentationMatches(plan: ReviewDeliveryPlan, baseline: ReviewDeliveryPlan): boolean {
  return plan.findings.every((actual, index) => {
    const retained = baseline.findings[index];
    if (!retained || actual.inventoryId !== retained.inventoryId) return false;
    if (digest(actual.disposition) === digest(retained.disposition)) return true;
    if (
      actual.disposition.kind === "unsupported" &&
      actual.disposition.reason === "presentation-unsupported"
    )
      return true;
    const terminal = actual.limitations.at(-1);
    if (
      terminal?.startsWith("review-locator:") &&
      LOCATOR_LIMITATIONS.has(terminal.slice("review-locator:".length))
    ) {
      return plan.capabilities.summary
        ? actual.disposition.kind === "summary-candidate" &&
            actual.disposition.reason === "inline-unavailable"
        : actual.disposition.kind === "unsupported" &&
            actual.disposition.reason === "provider-unsupported";
    }
    if (
      !plan.capabilities.summary &&
      retained.disposition.kind === "inline-candidate" &&
      actual.disposition.kind === "unsupported" &&
      actual.disposition.reason === "provider-unsupported"
    )
      return true;
    return (
      actual.disposition.kind === "summary-candidate" &&
      actual.disposition.reason === "presentation-policy" &&
      plan.capabilities.summary &&
      (retained.disposition.kind === "inline-candidate" ||
        (plan.requestedActions === "summary-only" &&
          retained.disposition.kind === "summary-candidate" &&
          retained.disposition.reason === "delivery-intent"))
    );
  });
}

export function createReviewDeliveryOriginAdmission(
  verifier: ReviewDeliveryOriginVerifier,
): ReviewDeliveryOriginAdmission {
  return originAuthorities.create(verifier);
}

export function createReviewDeliveryCustodyAdmission(
  verifier: ReviewDeliveryCustodyVerifier,
): ReviewDeliveryCustodyAdmission {
  return custodyAuthorities.create(verifier);
}

const STORE_ID = /^[a-f0-9]{64}$/u;

/** Opaque configured-source admission, including the initial empty-origin claim. */
export async function admitReviewDeliveryCustody(
  admission: ReviewDeliveryCustodyAdmission | ReviewDeliveryOriginAdmission,
  input: ReviewDeliveryCustodyAdmissionInput,
): Promise<ReviewDeliveryCustodyDecision> {
  const verifier = custodyAuthorities.lookup(admission as ReviewDeliveryCustodyAdmission);
  if (verifier) {
    const decision = await verifier.verifyCurrent(input);
    if (
      decision.status !== "admitted" ||
      !STORE_ID.test(decision.originStoreId) ||
      !STORE_ID.test(decision.storeId) ||
      (input.expectedGeneration !== null && decision.generation !== input.expectedGeneration) ||
      (input.phase !== "import" &&
        input.transferId !== null &&
        decision.transferId !== input.transferId)
    )
      return { status: "blocked" };
    return decision;
  }
  // A legacy origin capability is a deliberately limited implementation of
  // the same mandatory admission: it can never authorize import or g>0.
  if (
    input.phase !== "execute" ||
    (input.expectedGeneration !== null && input.expectedGeneration !== 0) ||
    input.transferId !== null ||
    input.sourceStoreId !== null ||
    input.sourceGeneration !== null ||
    input.destinationStoreId !== null ||
    input.fencedRecordSha256 !== null
  )
    return { status: "blocked" };
  const original = await admitReviewDeliveryOrigin(
    admission as ReviewDeliveryOriginAdmission,
    input,
  );
  return original.admitted
    ? {
        status: "admitted",
        originStoreId: original.storeId,
        storeId: original.storeId,
        generation: input.expectedGeneration,
        state: input.expectedGeneration === null ? null : "active",
        transferId: null,
      }
    : { status: "blocked" };
}

export function identifyReviewDeliveryCustodyStore(
  admission: ReviewDeliveryCustodyAdmission,
  store: ScmDeliveryReceiptStore,
): string | null {
  const id = custodyAuthorities.lookup(admission)?.identifyConfiguredStore(store);
  return id && STORE_ID.test(id) ? id : null;
}

export async function loadReviewDeliveryFencedSource(
  admission: ReviewDeliveryCustodyAdmission,
  input: Parameters<ReviewDeliveryCustodySource["loadFencedTransfer"]>[0],
): Promise<ReviewDeliveryRecordV1 | null> {
  const verifier = custodyAuthorities.lookup(admission);
  if (!verifier) return null;
  const value = await verifier.loadFencedTransfer(input);
  if (!value) return null;
  const source = assertReviewDeliveryRecordShape(value);
  return source.manifest.manifestSha256 === input.manifest.manifestSha256 &&
    source.ownerStoreId === input.sourceStoreId &&
    source.generation === input.sourceGeneration &&
    source.custody.transferId === input.transferId &&
    source.custody.otherStoreId === input.destinationStoreId &&
    (source.custody.state === "fenced-out" || source.custody.state === "transferred")
    ? source
    : null;
}

export function createReviewDeliveryCorrelationAdmission(
  verifier: ReviewDeliveryCorrelationPolicyVerifier,
): ReviewDeliveryCorrelationAdmission {
  return correlationAuthorities.create(verifier);
}

export async function admitReviewDeliveryOrigin(
  admission: ReviewDeliveryOriginAdmission,
  input: ReviewDeliveryOriginAdmissionInput,
): Promise<{ readonly admitted: true; readonly storeId: string } | { readonly admitted: false }> {
  const verifier = originAuthorities.lookup(admission);
  if (!verifier) return { admitted: false };
  const decision = await verifier.verifyCurrent(input);
  if (decision.status !== "admitted" || !/^[a-f0-9]{64}$/u.test(decision.storeId))
    return { admitted: false };
  return { admitted: true, storeId: decision.storeId };
}

export async function admitReviewDeliveryCorrelation(
  admission: ReviewDeliveryCorrelationAdmission | null,
  input: Parameters<ReviewDeliveryCorrelationPolicyVerifier["verifyCurrent"]>[0],
): Promise<boolean> {
  if (admission === null) return false;
  const verifier = correlationAuthorities.lookup(admission);
  if (!verifier) return false;
  const decision = await verifier.verifyCurrent(input);
  return (
    decision.status === "supported" &&
    decision.channel === "exclusive-actor-writer-complete-stable-notes"
  );
}

/**
 * Origin claim from retained stores and the configured receipt root. This
 * composition deliberately knows only the original A root: a copied receipt
 * or caller-selected B root cannot become the initial owner.
 */
export function createLocalReviewDeliveryOriginAdmission(input: {
  readonly store: ScmDeliveryReceiptStore & { readonly reviewRootPath: string };
  readonly configuredReceiptRoot: string;
  readonly runStore: FileRunStore;
  readonly artifactStore: DurableArtifactStore;
  readonly runId: string;
  readonly artifactDigest: string;
  readonly artifactId: string;
  readonly originalResultSha256: string;
  /** Captured host request, independent of the submitted plan and callbacks. */
  readonly requestedActions?: ReviewDeliveryRequestedActions;
  /** Host loader for retained or native pinned bytes; it must not derive bytes from the submitted plan. */
  readonly loadSnapshot: (input: {
    readonly runId: string;
    readonly source: ChangeSourceV1;
    readonly reviewedHeadSha: string;
  }) => Promise<ReviewDeliverySnapshot>;
}): ReviewDeliveryOriginAdmission {
  const requestedActions = input.requestedActions;
  if (
    requestedActions !== undefined &&
    requestedActions !== "overview" &&
    requestedActions !== "summary-only"
  )
    throw new Error("Review delivery origin requires a validated requested action.");
  const configuredReceiptRoot = resolve(input.configuredReceiptRoot);
  const configuredArtifactRoot = input.artifactStore.root;
  const originStoreId = localReviewStoreId(
    configuredReceiptRoot,
    input.runId,
    input.artifactDigest,
  );
  return createReviewDeliveryOriginAdmission({
    async verifyCurrent(candidate) {
      if (
        candidate.requestedStore !== input.store ||
        resolve(input.store.reviewRootPath) !== configuredReceiptRoot ||
        input.artifactStore.root !== configuredArtifactRoot ||
        candidate.manifest.artifactId !== input.artifactId ||
        candidate.manifest.originalResultSha256 !== input.originalResultSha256 ||
        candidate.plan.artifact.id !== input.artifactId ||
        candidate.plan.artifact.resultSha256 !== input.originalResultSha256
      )
        return { status: "blocked" };
      try {
        const retained = await input.runStore.getWithDigest(input.runId, { readOnly: true });
        const run = retained.record as {
          id?: unknown;
          workflow?: unknown;
          status?: unknown;
          repository?: { revision?: unknown };
          artifacts?: unknown;
        };
        if (
          run.id !== input.runId ||
          run.workflow !== "review-documentation" ||
          run.status !== "succeeded" ||
          !Array.isArray(run.artifacts) ||
          !run.artifacts.some((item: unknown) => {
            if (typeof item !== "object" || item === null) return false;
            const reference = (item as { reference?: { digest?: unknown } }).reference;
            return reference?.digest === input.artifactDigest;
          })
        )
          return { status: "blocked" };
        const originalResult = await input.artifactStore.getRecord(input.artifactDigest);
        const source = assertReviewTargetV2Source(
          candidate.plan.target,
          candidate.plan.source as ChangeSourceV1,
        );
        const { projection, targetValue } = retainedProjection(
          originalResult,
          candidate.plan.target,
          source,
        );
        const snapshot = await input.loadSnapshot({
          runId: input.runId,
          source: structuredClone(source),
          reviewedHeadSha: projection.reviewedHeadSha,
        });
        const baseline = createReviewDeliveryPlan({
          target: targetValue,
          source,
          result: originalResult,
          snapshot,
          artifact: candidate.plan.artifact,
          actor: candidate.plan.actor,
          capabilities: candidate.plan.capabilities,
          requestedActions,
        });
        if (
          projection.originalResultSha256 !== input.originalResultSha256 ||
          projection.originalResultSha256 !== candidate.manifest.originalResultSha256 ||
          projection.reviewedHeadSha !== candidate.manifest.reviewedHeadSha ||
          projection.resultTargetSha256 !== candidate.plan.result.resultTargetSha256 ||
          run.repository?.revision !== projection.reviewedHeadSha ||
          baseline.snapshotSha256 !== candidate.plan.snapshotSha256 ||
          !inlineAnchorsMatch(candidate.plan, baseline) ||
          !presentationMatches(candidate.plan, baseline) ||
          !planProjectionMatches(candidate.plan, projection, requestedActions) ||
          source.changeSourceSha256 !== candidate.manifest.sourceSha256
        )
          return { status: "blocked" };
        return { status: "admitted", storeId: originStoreId };
      } catch {
        return { status: "blocked" };
      }
    },
  });
}

/**
 * Two configured private roots share one independently pinned retained result.
 * Neither a request path nor a transfer pointer selects a new trusted source.
 */
export function createLocalReviewDeliveryCustodyAdmission(input: {
  /** Authenticated configured publisher, independent of the submitted plan. */
  readonly configuredActor: ReviewDeliveryActor;
  readonly origin: Parameters<typeof createLocalReviewDeliveryOriginAdmission>[0] & {
    readonly runRecordSha256: string;
  };
  readonly destination: {
    readonly store: ScmDeliveryReceiptStore & { readonly reviewRootPath: string };
    readonly configuredReceiptRoot: string;
  };
}): ReviewDeliveryCustodyAdmission {
  const original = createLocalReviewDeliveryOriginAdmission(input.origin);
  const originId = localReviewStoreId(
    input.origin.configuredReceiptRoot,
    input.origin.runId,
    input.origin.artifactDigest,
  );
  const destinationId = localReviewStoreId(
    input.destination.configuredReceiptRoot,
    input.origin.runId,
    input.origin.artifactDigest,
  );
  if (originId === destinationId || !STORE_ID.test(input.origin.runRecordSha256))
    throw new Error("Review delivery custody requires distinct configured roots and a pinned run.");
  const configured = [
    {
      store: input.origin.store,
      root: resolve(input.origin.configuredReceiptRoot),
      id: originId,
    },
    {
      store: input.destination.store,
      root: resolve(input.destination.configuredReceiptRoot),
      id: destinationId,
    },
  ] as const;
  const byStore = (store: ScmDeliveryReceiptStore) =>
    configured.find((entry) => entry.store === store);
  const byId = (id: string) => configured.find((entry) => entry.id === id);
  const stillConfigured = (entry: (typeof configured)[number]) =>
    resolve(entry.store.reviewRootPath) === entry.root;
  const trustedOrigin = async (manifest: ReviewDeliveryManifestV1, plan: ReviewDeliveryPlan) => {
    if (
      !configured.every(stillConfigured) ||
      manifest.actor.host !== input.configuredActor.host ||
      manifest.actor.id !== input.configuredActor.id ||
      plan.actor.host !== input.configuredActor.host ||
      plan.actor.id !== input.configuredActor.id
    )
      return false;
    try {
      const saved = await input.origin.runStore.getWithDigest(input.origin.runId, {
        readOnly: true,
      });
      if (saved.sha256 !== input.origin.runRecordSha256) return false;
      const admitted = await admitReviewDeliveryOrigin(original, {
        manifest,
        plan,
        requestedStore: input.origin.store,
      });
      return admitted.admitted && admitted.storeId === originId;
    } catch {
      return false;
    }
  };
  const fenced = (
    record: ReviewDeliveryRecordV1 | undefined,
    manifest: ReviewDeliveryManifestV1,
    sourceId: string,
    successorId: string,
    generation: number,
    transferId: string,
  ): record is ReviewDeliveryRecordV1 =>
    record !== undefined &&
    record.manifest.manifestSha256 === manifest.manifestSha256 &&
    record.originStoreId === originId &&
    record.ownerStoreId === sourceId &&
    record.generation === generation &&
    record.custody.transferId === transferId &&
    record.custody.otherStoreId === successorId &&
    (record.custody.state === "fenced-out" || record.custody.state === "transferred");
  const sourceSlot = async (id: string, key: string) => byId(id)?.store.loadReview?.(key);
  const linkedToConfiguredNeighbor = async (record: ReviewDeliveryRecordV1) => {
    if (record.generation === 0) return record.ownerStoreId === originId;
    const neighborId = record.custody.otherStoreId;
    if (neighborId === null || !byId(neighborId)) return false;
    const neighbor = await sourceSlot(neighborId, record.idempotencyKey);
    if (!neighbor || neighbor.manifest.manifestSha256 !== record.manifest.manifestSha256)
      return false;
    if (neighbor.generation === record.generation - 1) {
      return (
        (neighbor.custody.state === "fenced-out" || neighbor.custody.state === "transferred") &&
        reviewDeliveryImportedLineageMatches(neighbor, record)
      );
    }
    return (
      neighbor.generation === record.generation + 1 &&
      (record.custody.state === "fenced-out" || record.custody.state === "transferred") &&
      reviewDeliveryImportedLineageMatches(record, neighbor)
    );
  };
  return createReviewDeliveryCustodyAdmission({
    identifyConfiguredStore(store) {
      const entry = byStore(store);
      return entry && stillConfigured(entry) ? entry.id : null;
    },
    async loadFencedTransfer(query) {
      const source = byId(query.sourceStoreId);
      if (
        !source ||
        !byId(query.destinationStoreId) ||
        !source.store.withReviewDeliveryLease ||
        !source.store.loadReview ||
        !(await trustedOrigin(query.manifest, query.plan))
      )
        return null;
      try {
        return await source.store.withReviewDeliveryLease(
          query.manifest.idempotencyKey,
          async () => {
            if (!(await trustedOrigin(query.manifest, query.plan)))
              throw new Error(
                "Configured review custody source is unavailable during fenced transfer readback.",
              );
          },
          async () => {
            const current = await source.store.loadReview!(query.manifest.idempotencyKey);
            return fenced(
              current,
              query.manifest,
              query.sourceStoreId,
              query.destinationStoreId,
              query.sourceGeneration,
              query.transferId,
            ) && (await linkedToConfiguredNeighbor(current))
              ? current
              : null;
          },
        );
      } catch {
        return null;
      }
    },
    async verifyCurrent(candidate) {
      const requested = byStore(candidate.requestedStore);
      if (
        !requested ||
        !stillConfigured(requested) ||
        !(await trustedOrigin(candidate.manifest, candidate.plan)) ||
        (candidate.sourceStoreId !== null && !byId(candidate.sourceStoreId)) ||
        (candidate.destinationStoreId !== null && !byId(candidate.destinationStoreId))
      )
        return { status: "blocked" };
      try {
        const current = await requested.store.loadReview?.(candidate.manifest.idempotencyKey);
        if (!current) {
          if (candidate.phase === "execute") {
            if (requested.id !== originId) return { status: "blocked" };
            const other = await sourceSlot(destinationId, candidate.manifest.idempotencyKey);
            if (other) return { status: "blocked" };
          } else if (candidate.phase === "import") {
            const sourceId = candidate.sourceStoreId;
            const transferId = candidate.transferId;
            if (sourceId === null || transferId === null || sourceId === requested.id)
              return { status: "blocked" };
            const source = await sourceSlot(sourceId, candidate.manifest.idempotencyKey);
            if (
              !source ||
              !fenced(
                source,
                candidate.manifest,
                sourceId,
                requested.id,
                source.generation,
                transferId,
              ) ||
              (candidate.sourceGeneration !== null &&
                source.generation !== candidate.sourceGeneration) ||
              (candidate.fencedRecordSha256 !== null &&
                fencedRecordSha(source) !== candidate.fencedRecordSha256)
            )
              return { status: "blocked" };
          } else {
            return { status: "blocked" };
          }
          return {
            status: "admitted",
            originStoreId: originId,
            storeId: requested.id,
            generation: null,
            state: null,
            transferId: null,
          };
        }
        if (
          current.manifest.manifestSha256 !== candidate.manifest.manifestSha256 ||
          current.originStoreId !== originId ||
          current.ownerStoreId !== requested.id ||
          !(await linkedToConfiguredNeighbor(current))
        )
          return { status: "blocked" };
        const sourceId = current.custody.otherStoreId;
        if (
          (current.custody.state === "active" || current.custody.state === "import-pending") &&
          current.generation > 0
        ) {
          const source =
            sourceId && (await sourceSlot(sourceId, candidate.manifest.idempotencyKey));
          if (
            !source ||
            !fenced(
              source,
              candidate.manifest,
              sourceId!,
              requested.id,
              current.generation - 1,
              current.custody.transferId!,
            )
          )
            return { status: "blocked" };
        }
        if (current.custody.state === "active" && current.generation === 0) {
          if (requested.id !== originId) return { status: "blocked" };
          const other = await sourceSlot(destinationId, candidate.manifest.idempotencyKey);
          if (other?.custody.state === "active") return { status: "blocked" };
        }
        if (
          candidate.phase === "execute" &&
          current.custody.state !== "active" &&
          current.custody.state !== "import-pending"
        )
          return { status: "blocked" };
        if (
          candidate.phase === "export" &&
          current.custody.state !== "active" &&
          current.custody.state !== "fenced-out" &&
          current.custody.state !== "transferred"
        )
          return { status: "blocked" };
        if (
          candidate.phase === "import" &&
          current.custody.state === "active" &&
          (current.custody.transferId !== candidate.transferId ||
            current.custody.otherStoreId !== candidate.sourceStoreId)
        )
          return { status: "blocked" };
        if (candidate.phase === "import" && candidate.sourceStoreId !== null) {
          const source = await sourceSlot(
            candidate.sourceStoreId,
            candidate.manifest.idempotencyKey,
          );
          if (
            !source ||
            !fenced(
              source,
              candidate.manifest,
              candidate.sourceStoreId,
              requested.id,
              source.generation,
              candidate.transferId ?? "",
            ) ||
            (candidate.sourceGeneration !== null &&
              source.generation !== candidate.sourceGeneration) ||
            (candidate.fencedRecordSha256 !== null &&
              fencedRecordSha(source) !== candidate.fencedRecordSha256)
          )
            return { status: "blocked" };
        }
        if (
          candidate.phase === "ack" &&
          current.custody.state !== "fenced-out" &&
          current.custody.state !== "transferred"
        )
          return { status: "blocked" };
        return {
          status: "admitted",
          originStoreId: originId,
          storeId: requested.id,
          generation: current.generation,
          state: current.custody.state,
          transferId: current.custody.transferId,
        };
      } catch {
        return { status: "blocked" };
      }
    },
  });
}

/** Inert evidence pointer; the configured source journal is always read again. */
export interface ReviewDeliveryTransferPointerV1 {
  readonly kind: "docsfab-review-delivery-transfer";
  readonly schemaVersion: 1;
  readonly logicalDeliveryId: string;
  readonly manifestSha256: string;
  readonly sourceStoreId: string;
  readonly destinationStoreId: string;
  readonly transferId: string;
  readonly sourceGeneration: number;
  readonly successorGeneration: number;
  readonly fencedSourceRecordSha256: string;
}

type CustodyStop = {
  readonly kind: "stopped";
  readonly reason: "custody" | "store-uncertain";
  readonly record: ReviewDeliveryRecordV1 | null;
};

function pointerFor(
  source: ReviewDeliveryRecordV1,
  destinationStoreId: string,
): ReviewDeliveryTransferPointerV1 {
  const fencedSha = fencedRecordSha(source);
  if (
    fencedSha === null ||
    source.custody.transferId === null ||
    source.custody.otherStoreId !== destinationStoreId
  )
    throw new Error("Review delivery source is not durably fenced for this destination.");
  return {
    kind: "docsfab-review-delivery-transfer",
    schemaVersion: 1,
    logicalDeliveryId: source.manifest.logicalDeliveryId,
    manifestSha256: source.manifest.manifestSha256,
    sourceStoreId: source.ownerStoreId,
    destinationStoreId,
    transferId: source.custody.transferId,
    sourceGeneration: source.generation,
    successorGeneration: source.generation + 1,
    fencedSourceRecordSha256: fencedSha,
  };
}

async function custodyDecision(
  admission: ReviewDeliveryCustodyAdmission,
  plan: ReviewDeliveryPlan,
  requestedStore: ScmDeliveryReceiptStore,
  phase: ReviewDeliveryCustodyAdmissionInput["phase"],
  expectedGeneration: number | null,
  transferId: string | null,
  sourceStoreId: string | null,
  sourceGeneration: number | null,
  destinationStoreId: string | null,
  fencedRecordSha256: string | null,
): Promise<ReviewDeliveryCustodyDecision> {
  return admitReviewDeliveryCustody(admission, {
    manifest: createReviewDeliveryManifest(plan),
    plan,
    requestedStore,
    phase,
    expectedGeneration,
    transferId,
    sourceStoreId,
    sourceGeneration,
    destinationStoreId,
    fencedRecordSha256,
  });
}

async function custodyCas(
  store: ScmDeliveryReceiptStore,
  before: ReviewDeliveryRecordV1,
  after: ReviewDeliveryRecordV1,
  authorize: () => Promise<void>,
): Promise<ReviewDeliveryRecordV1> {
  if (!store.compareAndSwapReview)
    throw new Error("Review receipt compare-and-swap is unavailable in this configured store.");
  try {
    return await store.compareAndSwapReview(before.sha256, after, authorize);
  } catch (error) {
    const observed = await store.loadReview?.(after.idempotencyKey).catch(() => undefined);
    if (observed?.sha256 === after.sha256) return observed;
    throw error;
  }
}

export async function exportReviewDeliveryCustody(input: {
  readonly plan: ReviewDeliveryPlan;
  readonly store: ScmDeliveryReceiptStore;
  readonly destinationStore: ScmDeliveryReceiptStore;
  readonly custodyAdmission: ReviewDeliveryCustodyAdmission;
}): Promise<
  | {
      readonly kind: "fenced";
      readonly pointer: ReviewDeliveryTransferPointerV1;
      readonly record: ReviewDeliveryRecordV1;
    }
  | CustodyStop
> {
  const manifest = createReviewDeliveryManifest(input.plan);
  const sourceId = identifyReviewDeliveryCustodyStore(input.custodyAdmission, input.store);
  const destinationId = identifyReviewDeliveryCustodyStore(
    input.custodyAdmission,
    input.destinationStore,
  );
  if (!sourceId || !destinationId || sourceId === destinationId)
    return { kind: "stopped", reason: "custody", record: null };
  const authorize = async () => {
    const decision = await custodyDecision(
      input.custodyAdmission,
      input.plan,
      input.store,
      "export",
      null,
      null,
      null,
      null,
      destinationId,
      null,
    );
    if (decision.status !== "admitted" || decision.storeId !== sourceId)
      throw new Error(
        "Review delivery export lost configured source custody before the journal transition.",
      );
  };
  if (
    !input.store.withReviewDeliveryLease ||
    !input.store.loadReview ||
    !input.destinationStore.loadReview ||
    !input.destinationStore.claimReviewImport
  )
    return { kind: "stopped", reason: "store-uncertain", record: null };
  try {
    await authorize();
  } catch {
    return { kind: "stopped", reason: "custody", record: null };
  }
  try {
    return await input.store.withReviewDeliveryLease(
      manifest.idempotencyKey,
      authorize,
      async () => {
        const current = await input.store.loadReview!(manifest.idempotencyKey);
        if (
          !current ||
          current.manifest.manifestSha256 !== manifest.manifestSha256 ||
          current.ownerStoreId !== sourceId
        )
          return { kind: "stopped", reason: "custody", record: current ?? null } as const;
        if (current.custody.state === "fenced-out" || current.custody.state === "transferred") {
          if (current.custody.otherStoreId !== destinationId)
            return { kind: "stopped", reason: "custody", record: current } as const;
          return {
            kind: "fenced",
            pointer: pointerFor(current, destinationId),
            record: current,
          } as const;
        }
        if (current.custody.state !== "active" || current.generation >= Number.MAX_SAFE_INTEGER)
          return { kind: "stopped", reason: "custody", record: current } as const;
        const fenced = updateReviewDeliveryRecord(current, {
          custody: {
            state: "fenced-out",
            transferId: randomUUID(),
            otherStoreId: destinationId,
          },
        });
        const saved = await custodyCas(input.store, current, fenced, authorize);
        return {
          kind: "fenced",
          pointer: pointerFor(saved, destinationId),
          record: saved,
        } as const;
      },
    );
  } catch {
    const current = await input.store.loadReview(manifest.idempotencyKey).catch(() => undefined);
    return { kind: "stopped", reason: "store-uncertain", record: current ?? null };
  }
}

export async function importReviewDeliveryCustody(input: {
  readonly plan: ReviewDeliveryPlan;
  readonly store: ScmDeliveryReceiptStore;
  readonly custodyAdmission: ReviewDeliveryCustodyAdmission;
  readonly pointer: ReviewDeliveryTransferPointerV1;
}): Promise<
  | { readonly kind: "import-pending"; readonly record: ReviewDeliveryRecordV1 }
  | { readonly kind: "active"; readonly record: ReviewDeliveryRecordV1 }
  | CustodyStop
> {
  const manifest = createReviewDeliveryManifest(input.plan);
  const destinationId = identifyReviewDeliveryCustodyStore(input.custodyAdmission, input.store);
  const pointer = input.pointer;
  if (
    !destinationId ||
    pointer.kind !== "docsfab-review-delivery-transfer" ||
    pointer.schemaVersion !== 1 ||
    pointer.logicalDeliveryId !== manifest.logicalDeliveryId ||
    pointer.manifestSha256 !== manifest.manifestSha256 ||
    pointer.destinationStoreId !== destinationId ||
    pointer.sourceStoreId === destinationId ||
    !STORE_ID.test(pointer.sourceStoreId) ||
    !STORE_ID.test(pointer.fencedSourceRecordSha256) ||
    !Number.isSafeInteger(pointer.sourceGeneration) ||
    pointer.sourceGeneration < 0 ||
    pointer.successorGeneration !== pointer.sourceGeneration + 1 ||
    typeof pointer.transferId !== "string" ||
    pointer.transferId.length === 0
  )
    return { kind: "stopped", reason: "custody", record: null };
  const source = await loadReviewDeliveryFencedSource(input.custodyAdmission, {
    manifest,
    plan: input.plan,
    sourceStoreId: pointer.sourceStoreId,
    destinationStoreId: destinationId,
    sourceGeneration: pointer.sourceGeneration,
    transferId: pointer.transferId,
  });
  if (!source || fencedRecordSha(source) !== pointer.fencedSourceRecordSha256)
    return { kind: "stopped", reason: "custody", record: null };
  const pending = createReviewDeliveryImportRecord(source, destinationId);
  const authorize = async () => {
    const decision = await custodyDecision(
      input.custodyAdmission,
      input.plan,
      input.store,
      "import",
      null,
      pointer.transferId,
      pointer.sourceStoreId,
      pointer.sourceGeneration,
      destinationId,
      pointer.fencedSourceRecordSha256,
    );
    // An older tombstone has its own transfer ID. Source identity, not a
    // destination-supplied token, controls the import CAS.
    if (
      decision.status !== "admitted" ||
      decision.storeId !== destinationId ||
      decision.originStoreId !== source.originStoreId
    )
      throw new Error(
        "Review delivery import lost configured source custody before the journal transition.",
      );
  };
  if (!input.store.withReviewDeliveryLease || !input.store.loadReview)
    return { kind: "stopped", reason: "store-uncertain", record: null };
  try {
    await authorize();
  } catch {
    return { kind: "stopped", reason: "custody", record: null };
  }
  try {
    return await input.store.withReviewDeliveryLease(
      manifest.idempotencyKey,
      authorize,
      async () => {
        const current = await input.store.loadReview!(manifest.idempotencyKey);
        if (!current) {
          if (destinationId === source.originStoreId)
            return { kind: "stopped", reason: "custody", record: null } as const;
          if (!input.store.claimReviewImport)
            return { kind: "stopped", reason: "store-uncertain", record: null } as const;
          try {
            const claimed = await input.store.claimReviewImport(pending, authorize);
            if (claimed.record.sha256 !== pending.sha256)
              return { kind: "stopped", reason: "custody", record: claimed.record } as const;
            return { kind: "import-pending", record: claimed.record } as const;
          } catch (error) {
            const observed = await input.store.loadReview!(manifest.idempotencyKey).catch(
              () => undefined,
            );
            if (observed?.sha256 === pending.sha256)
              return { kind: "import-pending", record: observed } as const;
            throw error;
          }
        }
        if (
          current.manifest.manifestSha256 !== manifest.manifestSha256 ||
          current.originStoreId !== source.originStoreId ||
          current.ownerStoreId !== destinationId ||
          current.context.correlationSeed !== source.context.correlationSeed ||
          (!reviewDeliveryImportedLineageMatches(source, current) &&
            !(
              destinationId === source.originStoreId &&
              (current.custody.state === "fenced-out" || current.custody.state === "transferred") &&
              current.generation + 2 === pointer.successorGeneration
            ))
        )
          return { kind: "stopped", reason: "custody", record: current } as const;
        if (
          current.generation === pointer.successorGeneration &&
          current.custody.transferId === pointer.transferId &&
          current.custody.otherStoreId === pointer.sourceStoreId
        ) {
          if (current.custody.state === "import-pending")
            return { kind: "import-pending", record: current } as const;
          if (current.custody.state === "active")
            return { kind: "active", record: current } as const;
        }
        if (
          destinationId !== source.originStoreId ||
          (current.custody.state !== "fenced-out" && current.custody.state !== "transferred") ||
          current.generation + 2 !== pointer.successorGeneration ||
          current.custody.otherStoreId !== pointer.sourceStoreId
        )
          return { kind: "stopped", reason: "custody", record: current } as const;
        const saved = await custodyCas(input.store, current, pending, authorize);
        return { kind: "import-pending", record: saved } as const;
      },
    );
  } catch {
    const current = await input.store.loadReview(manifest.idempotencyKey).catch(() => undefined);
    return { kind: "stopped", reason: "store-uncertain", record: current ?? null };
  }
}

export async function acknowledgeReviewDeliveryCustody(input: {
  readonly plan: ReviewDeliveryPlan;
  readonly store: ScmDeliveryReceiptStore;
  readonly destinationStore: ScmDeliveryReceiptStore;
  readonly custodyAdmission: ReviewDeliveryCustodyAdmission;
  readonly pointer: ReviewDeliveryTransferPointerV1;
}): Promise<
  { readonly kind: "transferred"; readonly record: ReviewDeliveryRecordV1 } | CustodyStop
> {
  const manifest = createReviewDeliveryManifest(input.plan);
  const pointer = input.pointer;
  const sourceId = identifyReviewDeliveryCustodyStore(input.custodyAdmission, input.store);
  const destinationId = identifyReviewDeliveryCustodyStore(
    input.custodyAdmission,
    input.destinationStore,
  );
  if (
    !sourceId ||
    !destinationId ||
    sourceId !== pointer.sourceStoreId ||
    destinationId !== pointer.destinationStoreId ||
    pointer.manifestSha256 !== manifest.manifestSha256 ||
    pointer.logicalDeliveryId !== manifest.logicalDeliveryId
  )
    return { kind: "stopped", reason: "custody", record: null };
  const authorize = async () => {
    const decision = await custodyDecision(
      input.custodyAdmission,
      input.plan,
      input.store,
      "ack",
      pointer.sourceGeneration,
      pointer.transferId,
      sourceId,
      pointer.sourceGeneration,
      destinationId,
      pointer.fencedSourceRecordSha256,
    );
    const destination = await input.destinationStore.loadReview?.(manifest.idempotencyKey);
    if (
      decision.status !== "admitted" ||
      decision.storeId !== sourceId ||
      destination?.ownerStoreId !== destinationId ||
      destination.originStoreId !== decision.originStoreId ||
      destination.manifest.manifestSha256 !== manifest.manifestSha256 ||
      destination.generation !== pointer.successorGeneration ||
      destination.custody.state !== "active" ||
      destination.custody.transferId !== pointer.transferId ||
      destination.custody.otherStoreId !== sourceId
    )
      throw new Error("Review delivery successor is not active for this source fence.");
  };
  if (
    !input.store.withReviewDeliveryLease ||
    !input.store.loadReview ||
    !input.destinationStore.loadReview
  )
    return { kind: "stopped", reason: "store-uncertain", record: null };
  try {
    await authorize();
  } catch {
    return { kind: "stopped", reason: "custody", record: null };
  }
  try {
    return await input.store.withReviewDeliveryLease(
      manifest.idempotencyKey,
      authorize,
      async () => {
        const current = await input.store.loadReview!(manifest.idempotencyKey);
        if (
          !current ||
          current.ownerStoreId !== sourceId ||
          current.generation !== pointer.sourceGeneration ||
          current.manifest.manifestSha256 !== manifest.manifestSha256 ||
          current.custody.transferId !== pointer.transferId ||
          current.custody.otherStoreId !== destinationId ||
          fencedRecordSha(current) !== pointer.fencedSourceRecordSha256
        )
          return { kind: "stopped", reason: "custody", record: current ?? null } as const;
        if (current.custody.state === "transferred")
          return { kind: "transferred", record: current } as const;
        if (current.custody.state !== "fenced-out")
          return { kind: "stopped", reason: "custody", record: current } as const;
        const next = updateReviewDeliveryRecord(current, {
          custody: { ...current.custody, state: "transferred" },
        });
        const saved = await custodyCas(input.store, current, next, authorize);
        return { kind: "transferred", record: saved } as const;
      },
    );
  } catch {
    const current = await input.store.loadReview(manifest.idempotencyKey).catch(() => undefined);
    return { kind: "stopped", reason: "store-uncertain", record: current ?? null };
  }
}
