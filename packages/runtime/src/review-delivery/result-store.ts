// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Original provider result custody beside the successful source-bound run. */
import { canonicalJson, sha256 } from "../content-ir/canonical.js";
import { DurableArtifactStore, opaqueRecordDigest } from "../artifacts/store.js";
import type { ArtifactUse } from "../artifacts/contracts.js";
import { validateArtifactUse } from "../artifacts/validate.js";
import { decodeSuccessfulReviewRunRecord } from "../delivery/run-record.js";
import type { FileRunStore } from "../records/file-store.js";
import type { RunRecord } from "../records/contracts.js";
import {
  decodeReviewResult,
  decodeReviewResultV2,
  decodeReviewTargetV2,
  type ReviewResult,
  type ReviewResultV4,
  type ReviewResultV6,
} from "../review/contracts.js";
import {
  assertReviewTargetV2Source,
  projectReviewResultV1,
  type ReviewTargetMigrationV1,
} from "../review/target-migration.js";
import type { ReviewTargetV2 } from "../review/contracts.js";
import {
  loadRetainedReviewSource,
  validateRetainedReviewSourceForRun,
} from "./source-snapshot-store.js";

export class ReviewResultStoreError extends Error {
  constructor(public readonly code: string) {
    super(`Retained review result invalid (${code}).`);
    this.name = "ReviewResultStoreError";
  }
}

const fail = (code: string): never => {
  throw new ReviewResultStoreError(code);
};

function decodeOriginal(value: unknown): ReviewResult {
  const version =
    value !== null && typeof value === "object" && "schemaVersion" in value
      ? value.schemaVersion
      : undefined;
  const decoded =
    version === 4 || version === 6 ? decodeReviewResultV2(value) : decodeReviewResult(value);
  if (canonicalJson(decoded) !== canonicalJson(value)) fail("original-bytes-changed");
  return decoded;
}

function terminalEvaluator(run: RunRecord) {
  const matches = run.steps.filter((step) => step.id === "evaluate-document-quality");
  const final = run.steps.at(-1);
  if (
    matches.length !== 1 ||
    final !== matches[0] ||
    final?.skill !== "evaluate-document-quality" ||
    final.kind !== "evaluate" ||
    final.mode !== "read-only" ||
    final.status !== "succeeded"
  )
    fail("terminal-evaluator-missing");
  return final!;
}

function resultUse(run: RunRecord): ArtifactUse {
  const step = terminalEvaluator(run);
  const allStepUses = run.steps.flatMap((item) =>
    (item.artifacts ?? []).filter((use) => use.reference.kind === "review-result"),
  );
  const fromStep = (step.artifacts ?? []).filter((use) => use.reference.kind === "review-result");
  const fromRoot = (run.artifacts ?? []).filter((use) => use.reference.kind === "review-result");
  if (allStepUses.length !== 1 || fromStep.length !== 1 || fromRoot.length !== 1)
    fail("result-reference-not-unique");
  const use = validateArtifactUse(fromStep[0]);
  if (
    use.role !== "output" ||
    use.stepId !== step.id ||
    canonicalJson(use) !== canonicalJson(validateArtifactUse(fromRoot[0])) ||
    use.reference.repositoryRevision !== run.repository.revision ||
    use.reference.repositoryContentDigest !== run.reviewDeliverySnapshot?.snapshotSha256
  )
    fail("result-reference-binding-mismatch");
  return use;
}

/** Persist and reread before adding the same output use to the final step and root. */
export async function retainOriginalReviewResult(input: {
  readonly run: RunRecord;
  readonly artifacts: DurableArtifactStore;
  readonly result: ReviewResult;
}): Promise<ArtifactUse> {
  const { run, artifacts, result } = input;
  if (run.workflow !== "review-documentation" || run.status !== "succeeded")
    fail("successful-review-required");
  if (run.reviewDeliverySnapshot === undefined) fail("source-reference-missing");
  const { reference: source } = await validateRetainedReviewSourceForRun({ run, artifacts });
  const step = terminalEvaluator(run);
  if (
    run.steps.some((item) =>
      (item.artifacts ?? []).some((use) => use.reference.kind === "review-result"),
    ) ||
    (run.artifacts ?? []).some((use) => use.reference.kind === "review-result")
  )
    fail("result-reference-not-unique");
  const original = decodeOriginal(result);
  if (original.schemaVersion !== 4 && original.schemaVersion !== 6)
    fail("provider-original-schema-required");
  const sourceKind = run.changeSources?.find(
    (citation) => citation.changeSourceSha256 === source.changeSourceSha256,
  )?.sourceKind;
  const provider =
    sourceKind === "gitlab-merge-request"
      ? "gitlab"
      : sourceKind === "github-pull-request"
        ? "github"
        : fail("result-source-kind-unsupported");
  if (
    original.runIdSha256 !== sha256(run.id) ||
    original.reviewedHeadSha !== source.reviewedHeadSha ||
    original.reviewedHeadSha !== run.repository.revision ||
    ((original.schemaVersion === 4 || original.schemaVersion === 6) &&
      (original.target.changeSourceSha256 !== source.changeSourceSha256 ||
        original.target.scmProvider !== provider))
  )
    fail("result-source-binding-mismatch");
  const objectDigest = opaqueRecordDigest(result);
  await artifacts.putRecord(objectDigest, result);
  const stored = await artifacts.getRecord(objectDigest, { readOnly: true });
  if (
    opaqueRecordDigest(stored) !== objectDigest ||
    canonicalJson(stored) !== canonicalJson(result)
  )
    fail("result-object-address-mismatch");
  const verified = decodeOriginal(stored);
  if (verified.resultSha256 !== original.resultSha256) fail("result-digest-mismatch");
  const use = validateArtifactUse({
    role: "output",
    stepId: step.id,
    reference: {
      kind: "review-result",
      schemaVersion: 1,
      digest: objectDigest,
      repositoryRevision: run.repository.revision,
      repositoryContentDigest: source.snapshotSha256,
    },
  });
  step.artifacts ??= [];
  step.artifacts.push(use);
  run.artifacts ??= [];
  run.artifacts.push(use);
  return use;
}

/** Start from the saved run, then validate both original objects and their source. */
export async function loadRetainedReviewResult(input: {
  readonly runStore: FileRunStore;
  readonly artifacts: DurableArtifactStore;
  readonly runId: string;
  readonly target: ReviewTargetV2 | ReviewTargetMigrationV1;
  readonly readOnly?: true;
}): Promise<{
  readonly result: ReviewResult;
  readonly source: Awaited<ReturnType<typeof loadRetainedReviewSource>>;
  readonly runRecordSha256: string;
}> {
  const saved = await input.runStore.getWithDigest(input.runId, { readOnly: true });
  const run = decodeSuccessfulReviewRunRecord(saved.record);
  if (run.id !== input.runId || run.reviewDeliverySnapshot === undefined)
    fail("source-reference-missing");
  const use = resultUse(run);
  const source = await loadRetainedReviewSource({ ...input, expectedRunSha256: saved.sha256 });
  const stored = await input.artifacts.getRecord(use.reference.digest, { readOnly: true });
  if (opaqueRecordDigest(stored) !== use.reference.digest) fail("result-object-address-mismatch");
  const result = decodeOriginal(stored);
  if (result.schemaVersion !== 4 && result.schemaVersion !== 6)
    fail("provider-original-schema-required");
  if (
    result.runIdSha256 !== sha256(run.id) ||
    result.reviewedHeadSha !== source.source.revision.head
  )
    fail("result-source-binding-mismatch");
  const projection = projectReviewResultV1(result, input.target);
  if (
    projection.originalResultSha256 !== result.resultSha256 ||
    ((result.schemaVersion === 4 || result.schemaVersion === 6) &&
      result.target.changeSourceSha256 !== source.source.changeSourceSha256)
  )
    fail("result-source-binding-mismatch");
  return { result, source, runRecordSha256: saved.sha256 };
}

/** Recover the sealed historical target from a successful run's addressed original result. */
export async function loadRetainedReviewTargetBootstrap(input: {
  readonly runStore: FileRunStore;
  readonly artifacts: DurableArtifactStore;
  readonly runId: string;
  readonly readOnly?: true;
}): Promise<{
  readonly historicalTarget: ReviewTargetV2;
  readonly originalResult: ReviewResultV4 | ReviewResultV6;
  readonly resultObjectSha256: string;
  readonly originalResultSha256: string;
  readonly sourceSha256: string;
  readonly snapshotSha256: string;
  readonly reviewedHeadSha: string;
  readonly runRecordSha256: string;
  readonly source: Awaited<ReturnType<typeof loadRetainedReviewSource>>;
}> {
  const saved = await input.runStore.getWithDigest(input.runId, { readOnly: true });
  const run = decodeSuccessfulReviewRunRecord(saved.record);
  if (run.id !== input.runId || run.reviewDeliverySnapshot === undefined)
    fail("source-reference-missing");
  const use = resultUse(run);
  const source = await loadRetainedReviewSource({ ...input, expectedRunSha256: saved.sha256 });
  const stored = await input.artifacts.getRecord(use.reference.digest, { readOnly: true });
  if (opaqueRecordDigest(stored) !== use.reference.digest) fail("result-object-address-mismatch");
  const decoded = decodeOriginal(stored);
  if (decoded.schemaVersion !== 4 && decoded.schemaVersion !== 6)
    fail("provider-original-schema-required");
  const originalResult = decoded as ReviewResultV4 | ReviewResultV6;
  const historicalTarget = decodeReviewTargetV2(originalResult.target);
  const pinnedSource = source.source;
  if (
    originalResult.runIdSha256 !== sha256(run.id) ||
    originalResult.targetSha256 !== historicalTarget.targetSha256 ||
    originalResult.reviewedHeadSha !== run.repository.revision ||
    originalResult.reviewedHeadSha !== pinnedSource.revision.head ||
    historicalTarget.workflow !== run.workflow ||
    historicalTarget.changeSourceSha256 !== pinnedSource.changeSourceSha256
  )
    fail("result-source-binding-mismatch");
  assertReviewTargetV2Source(historicalTarget, pinnedSource);
  const projection = projectReviewResultV1(originalResult, historicalTarget);
  if (projection.originalResultSha256 !== originalResult.resultSha256)
    fail("result-source-binding-mismatch");
  return {
    historicalTarget,
    originalResult,
    resultObjectSha256: use.reference.digest,
    originalResultSha256: originalResult.resultSha256,
    sourceSha256: pinnedSource.changeSourceSha256,
    snapshotSha256: source.root.snapshotSha256,
    reviewedHeadSha: pinnedSource.revision.head,
    runRecordSha256: saved.sha256,
    source,
  };
}
