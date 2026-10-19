// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Cold, read-only proof that an admitted review locator names delivered head bytes. */
import { createHash } from "node:crypto";
import { DurableArtifactStore, opaqueRecordDigest } from "../artifacts/store.js";
import { canonicalJson, sha256 } from "../content-ir/canonical.js";
import { createHostAuthorityFactory } from "../contract-kit/index.js";
import type { ReviewReadObservationSnapshot } from "../harness/confined-tools/source-coordinates.js";
import type { ChangeSourceV1 } from "../inputs/change-source.js";
import { decodeChangeSourceV1 } from "../inputs/change-source.js";
import type { RunRecord, StepRunRecord } from "../records/contracts.js";
import type { ReviewLocatorObservationReference } from "../records/contracts/run-records.js";
import { FileRunStore } from "../records/file-store.js";
import { decodeSuccessfulReviewRunRecord } from "../delivery/run-record.js";
import { loadRetainedReviewResult } from "../review-delivery/result-store.js";
import { reviewDeliverySnapshotDigest } from "../review-delivery/snapshot-digest.js";
import type { ReviewTargetV2 } from "./contracts.js";
import { decodeReviewTargetV2 } from "./contracts.js";
import type { ReviewResultProjectionV1 } from "./target-migration.js";
import { assertReviewTargetV2Source } from "./target-migration.js";
import { projectReviewResultV1 } from "./target-migration.js";
import { reviewResultFromRun } from "./run-result.js";
import { reviewDocumentationTargetPaths } from "../workflow-execution/source-obligation.js";
import type {
  ReviewLocatorAuthority,
  ReviewLocatorLimitation,
  ReviewLocatorLoadResult,
} from "./locator-provenance-contracts.js";
export type {
  ReviewLocatorAuthority,
  ReviewLocatorLimitation,
  ReviewLocatorLoadResult,
} from "./locator-provenance-contracts.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._][A-Za-z0-9._\/-]*$/u;
const KIND = "docsfab-review-locator-observation" as const;
const REFERENCE_KIND = "docsfab-review-locator-observation-reference" as const;

export interface ReviewLocatorObservationV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof KIND;
  readonly runId: string;
  readonly repositoryRevision: string;
  readonly repositoryIdentitySha256: string;
  readonly stepId: "verify-technical-accuracy";
  readonly attempt: number;
  readonly summarySha256: string;
  readonly targetPaths: readonly string[];
  readonly repositoryContentDigest: string;
  readonly workspaceSnapshotSha256: string | null;
  readonly files: ReviewReadObservationSnapshot["files"];
  readonly domainSha256: string;
}

export interface ReviewLocatorQuery {
  readonly resultSha256: string;
  readonly sourceSha256: string;
  readonly reviewedHeadSha: string;
  readonly snapshotSha256: string;
  readonly collection: "issues" | "findings";
  readonly index: number;
  readonly id: string;
  readonly path: string;
  readonly line: number;
  readonly file: {
    readonly oldPath: string | null;
    readonly newPath: string | null;
    readonly afterBytes: Uint8Array;
    readonly afterSha256: string | null;
  };
}

export type ReviewLocatorResolution =
  | {
      readonly kind: "verified";
      readonly path: string;
      readonly side: "after";
      readonly line: number;
      readonly text: string;
    }
  | { readonly kind: "unavailable"; readonly reason: ReviewLocatorLimitation };

function invalid(): never {
  throw new Error("Retained review locator observation failed strict validation for this run.");
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== [...keys].sort().join("\0")) invalid();
  return record;
}

function domainSha256(body: Omit<ReviewLocatorObservationV1, "domainSha256">): string {
  return sha256(canonicalJson(body));
}

export function decodeReviewLocatorObservation(value: unknown): ReviewLocatorObservationV1 {
  const root = exact(value, [
    "schemaVersion",
    "kind",
    "runId",
    "repositoryRevision",
    "repositoryIdentitySha256",
    "stepId",
    "attempt",
    "summarySha256",
    "targetPaths",
    "repositoryContentDigest",
    "workspaceSnapshotSha256",
    "files",
    "domainSha256",
  ]);
  if (root.schemaVersion !== 1 || root.kind !== KIND || root.stepId !== "verify-technical-accuracy")
    invalid();
  if (
    typeof root.runId !== "string" ||
    root.runId.length === 0 ||
    typeof root.repositoryRevision !== "string" ||
    root.repositoryRevision.length === 0 ||
    !Number.isSafeInteger(root.attempt) ||
    (root.attempt as number) < 1 ||
    ![
      root.repositoryIdentitySha256,
      root.summarySha256,
      root.repositoryContentDigest,
      root.domainSha256,
    ].every((digest) => typeof digest === "string" && SHA256.test(digest)) ||
    !(
      root.workspaceSnapshotSha256 === null ||
      (typeof root.workspaceSnapshotSha256 === "string" &&
        SHA256.test(root.workspaceSnapshotSha256))
    )
  )
    invalid();
  if (
    !Array.isArray(root.targetPaths) ||
    root.targetPaths.length === 0 ||
    !root.targetPaths.every((path) => typeof path === "string" && SAFE_PATH.test(path)) ||
    JSON.stringify(root.targetPaths) !== JSON.stringify([...new Set(root.targetPaths)].sort())
  )
    invalid();
  if (!Array.isArray(root.files) || root.files.length === 0) invalid();
  let lastPath = "";
  const files = root.files.map((entry) => {
    const file = exact(entry, ["path", "rawSha256", "rawBase64", "lines"]);
    if (
      typeof file.path !== "string" ||
      !SAFE_PATH.test(file.path) ||
      file.path <= lastPath ||
      !(root.targetPaths as string[]).includes(file.path) ||
      typeof file.rawSha256 !== "string" ||
      !SHA256.test(file.rawSha256) ||
      typeof file.rawBase64 !== "string"
    )
      invalid();
    lastPath = file.path;
    const raw = Buffer.from(file.rawBase64 as string, "base64");
    if (raw.toString("base64") !== file.rawBase64 || sha256(raw) !== file.rawSha256) invalid();
    if (!Array.isArray(file.lines) || file.lines.length === 0) invalid();
    let lastLine = 0;
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
    const sourceLines = text.split("\n");
    if (sourceLines.at(-1) === "") sourceLines.pop();
    for (const entry of file.lines) {
      const row = exact(entry, ["line", "textSha256"]);
      if (
        !Number.isSafeInteger(row.line) ||
        (row.line as number) <= lastLine ||
        (row.line as number) > sourceLines.length ||
        typeof row.textSha256 !== "string" ||
        !SHA256.test(row.textSha256)
      )
        invalid();
      lastLine = row.line as number;
      const source = sourceLines[lastLine - 1]!;
      const normalized = source.endsWith("\r") ? source.slice(0, -1) : source;
      if (sha256(normalized) !== row.textSha256) invalid();
    }
    return file;
  });
  const body = { ...root };
  delete body.domainSha256;
  if (
    domainSha256(body as unknown as Omit<ReviewLocatorObservationV1, "domainSha256">) !==
      root.domainSha256 ||
    sha256(canonicalJson(files.map((file) => ({ path: file.path, rawSha256: file.rawSha256 })))) !==
      root.repositoryContentDigest
  )
    invalid();
  return root as unknown as ReviewLocatorObservationV1;
}

/** Stage, read back, and verify before a run record may cite the object. */
export async function retainReviewLocatorObservation(input: {
  readonly artifacts: DurableArtifactStore;
  readonly record: RunRecord;
  readonly step: StepRunRecord;
  readonly observation: ReviewReadObservationSnapshot;
  readonly targetPaths: readonly string[];
}): Promise<ReviewLocatorObservationReference | null> {
  const { record, step, observation } = input;
  if (
    record.workflow !== "review-documentation" ||
    step.id !== "verify-technical-accuracy" ||
    step.skill !== "verify-technical-accuracy" ||
    step.mode !== "read-only" ||
    step.status !== "succeeded" ||
    observation.unavailable ||
    !step.summary ||
    !step.inference ||
    step.inference.attempts.at(-1)?.outcome !== "succeeded"
  )
    return null;
  const attempt = step.inference.attempts.at(-1)!.attempt;
  const targetPaths = [...new Set(input.targetPaths)].sort();
  const files = observation.files.filter((file) => targetPaths.includes(file.path));
  if (files.length === 0) return null;
  const body = {
    schemaVersion: 1 as const,
    kind: KIND,
    runId: record.id,
    repositoryRevision: record.repository.revision,
    repositoryIdentitySha256: sha256(record.repository.sourcePath),
    stepId: "verify-technical-accuracy" as const,
    attempt,
    summarySha256: sha256(step.summary),
    targetPaths,
    repositoryContentDigest: sha256(
      canonicalJson(files.map((file) => ({ path: file.path, rawSha256: file.rawSha256 }))),
    ),
    workspaceSnapshotSha256: step.searchEvidence?.workspaceSnapshotSha256 ?? null,
    files,
  };
  const manifest = { ...body, domainSha256: domainSha256(body) };
  const objectSha256 = opaqueRecordDigest(manifest);
  if (Buffer.byteLength(JSON.stringify(manifest)) > input.artifacts.maxObjectBytes) return null;
  decodeReviewLocatorObservation(manifest);
  await input.artifacts.putRecord(objectSha256, manifest);
  decodeReviewLocatorObservation(await input.artifacts.getRecord(objectSha256));
  return {
    kind: REFERENCE_KIND,
    objectSha256,
    domainSha256: manifest.domainSha256,
    runId: record.id,
    stepId: "verify-technical-accuracy",
    attempt,
    summarySha256: manifest.summarySha256,
  };
}

interface VerifiedLocatorState {
  readonly manifest: ReviewLocatorObservationV1;
  readonly result: ReviewResultProjectionV1;
  readonly source: ChangeSourceV1;
  readonly target: ReviewTargetV2;
  readonly snapshotSha256: string;
  verifyCurrent(query: ReviewLocatorQuery): ReviewLocatorResolution;
}

const authorities = createHostAuthorityFactory<
  "docsfab-review-locator-authority",
  VerifiedLocatorState
>({
  kind: "docsfab-review-locator-authority",
  invalidMessage: "Review locator authority requires a verified cold reader.",
});

function unavailable(reason: ReviewLocatorLimitation): ReviewLocatorLoadResult {
  return { kind: "unavailable", reason };
}

function blobId(bytes: Uint8Array, format: "sha1" | "sha256"): string {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  return createHash(format).update(header).update(bytes).digest("hex");
}

function sourceLine(bytes: Uint8Array, line: number): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const raw = lines[line - 1];
    if (raw === undefined) return null;
    return raw.endsWith("\r") ? raw.slice(0, -1) : raw;
  } catch {
    return null;
  }
}

function verifyQuery(
  state: VerifiedLocatorState,
  query: ReviewLocatorQuery,
): ReviewLocatorResolution {
  const mismatch = { kind: "unavailable", reason: "binding-mismatch" } as const;
  const { manifest, result, source, target } = state;
  if (
    query.resultSha256 !== result.originalResultSha256 ||
    query.sourceSha256 !== source.changeSourceSha256 ||
    query.reviewedHeadSha !== target.headSha ||
    query.snapshotSha256 !== state.snapshotSha256 ||
    query.collection !== "issues" ||
    !Number.isSafeInteger(query.index) ||
    query.index < 0 ||
    !Number.isSafeInteger(query.line) ||
    query.line < 1 ||
    !SAFE_PATH.test(query.path)
  )
    return mismatch;
  const issue = result.issues?.[query.index];
  if (
    !issue ||
    issue.id !== query.id ||
    issue.path !== query.path ||
    issue.line !== query.line ||
    issue.locationFidelity !== "exact" ||
    issue.producerStepId !== manifest.stepId ||
    issue.producerSkill !== manifest.stepId
  )
    return mismatch;
  const sourceFile = source.files.filter(
    (file) => file.status === "M" && file.oldPath === query.path && file.newPath === query.path,
  );
  const observed = manifest.files.find((file) => file.path === query.path);
  if (
    sourceFile.length !== 1 ||
    !observed ||
    query.file.oldPath !== query.path ||
    query.file.newPath !== query.path
  )
    return mismatch;
  if (sourceFile[0]!.newBlob === null) {
    return { kind: "unavailable", reason: "source-blob-unavailable" };
  }
  const after = Uint8Array.from(query.file.afterBytes);
  const raw = Buffer.from(observed.rawBase64, "base64");
  if (
    query.file.afterSha256 !== sha256(after) ||
    observed.rawSha256 !== sha256(after) ||
    !raw.equals(after) ||
    blobId(after, source.objectFormat) !== sourceFile[0]!.newBlob
  )
    return mismatch;
  const line = sourceLine(after, query.line);
  if (
    line === null ||
    observed.lines.find((entry) => entry.line === query.line)?.textSha256 !== sha256(line)
  )
    return { kind: "unavailable", reason: "read-unobserved" };
  return { kind: "verified", path: query.path, side: "after", line: query.line, text: line };
}

/** Admit locator proof from one saved-run identity and its verified original. */
export async function loadReviewLocatorAuthority(input: {
  readonly runStore: FileRunStore;
  readonly artifacts: DurableArtifactStore;
  readonly runId: string;
  readonly binding: { readonly target: ReviewTargetV2; readonly source: ChangeSourceV1 };
  readonly result: ReviewResultProjectionV1;
  readonly snapshotSha256: string;
  readonly readOnly?: true;
}): Promise<ReviewLocatorLoadResult> {
  let record: RunRecord;
  let source: ChangeSourceV1;
  let target: ReviewTargetV2;
  try {
    const pinned = await input.runStore.getWithDigest(input.runId, { readOnly: input.readOnly });
    record = decodeSuccessfulReviewRunRecord(pinned.record);
    source = decodeChangeSourceV1(input.binding.source);
    target = decodeReviewTargetV2(input.binding.target);
    assertReviewTargetV2Source(target, source);
    // A present source reference commits this run to the retained original.
    // Legacy reconstruction is only for runs that never retained a source.
    let projected: ReviewResultProjectionV1;
    if (record.reviewDeliverySnapshot === undefined) {
      projected = projectReviewResultV1(reviewResultFromRun(record, { target, source }), target);
    } else {
      const original = await loadRetainedReviewResult({
        runStore: input.runStore,
        artifacts: input.artifacts,
        runId: input.runId,
        target,
        readOnly: input.readOnly,
      });
      if (
        original.runRecordSha256 !== pinned.sha256 ||
        canonicalJson(original.source.source) !== canonicalJson(source) ||
        reviewDeliverySnapshotDigest(original.source.snapshot, original.source.source) !==
          input.snapshotSha256
      )
        return unavailable("binding-mismatch");
      projected = projectReviewResultV1(original.result, target);
    }
    if (
      record.id !== input.runId ||
      record.repository.revision !== target.headSha ||
      source.revision.head !== target.headSha ||
      input.result.originalResultSha256 !== projected.originalResultSha256 ||
      input.result.originalResultCanonicalJson !== projected.originalResultCanonicalJson ||
      input.result.runIdSha256 !== sha256(record.id) ||
      !SHA256.test(input.snapshotSha256) ||
      !record.changeSources?.some(
        (entry) =>
          entry.changeSourceSha256 === source.changeSourceSha256 &&
          entry.head === target.headSha &&
          entry.repository.identitySha256 === source.revision.repository.identitySha256,
      )
    )
      return unavailable("binding-mismatch");
  } catch {
    return unavailable("binding-mismatch");
  }
  const references = record.steps.flatMap((step) =>
    step.reviewLocatorObservation ? [{ step, reference: step.reviewLocatorObservation }] : [],
  );
  if (references.length === 0) return unavailable("legacy-unavailable");
  if (references.length !== 1) return unavailable("observation-invalid");
  const { step, reference } = references[0]!;
  const focusedPaths = record.reviewScope?.targetPaths;
  // A documentation-set run has no focused reviewScope. Its technical target
  // list comes from the source authority admitted by the strict run decoder.
  const derive = record.steps.find((candidate) => candidate.id === "derive-source-obligations");
  const originalAuthority = derive?.originalSourceAuthority;
  const documentationSetPaths =
    record.reviewScope === undefined &&
    derive?.status === "succeeded" &&
    originalAuthority?.descriptor.scope === "review-tracked-workspace" &&
    originalAuthority.descriptor.repositoryRevision === record.repository.revision
      ? reviewDocumentationTargetPaths(originalAuthority.members.map((member) => member.path))
      : undefined;
  let manifest: ReviewLocatorObservationV1;
  try {
    const value = await input.artifacts.getRecord(reference.objectSha256, {
      readOnly: input.readOnly,
    });
    manifest = decodeReviewLocatorObservation(value);
    if (
      opaqueRecordDigest(value) !== reference.objectSha256 ||
      manifest.domainSha256 !== reference.domainSha256 ||
      manifest.runId !== record.id ||
      reference.runId !== record.id ||
      manifest.repositoryRevision !== record.repository.revision ||
      manifest.repositoryIdentitySha256 !== sha256(record.repository.sourcePath) ||
      manifest.stepId !== step.id ||
      manifest.attempt !== reference.attempt ||
      manifest.summarySha256 !== sha256(step.summary ?? "") ||
      manifest.summarySha256 !== reference.summarySha256 ||
      manifest.workspaceSnapshotSha256 !== (step.searchEvidence?.workspaceSnapshotSha256 ?? null) ||
      step.skill !== "verify-technical-accuracy" ||
      step.mode !== "read-only" ||
      step.status !== "succeeded" ||
      step.inference?.attempts.at(-1)?.attempt !== reference.attempt ||
      step.inference?.attempts.at(-1)?.outcome !== "succeeded" ||
      (focusedPaths
        ? !manifest.targetPaths.every((path) => focusedPaths.includes(path))
        : JSON.stringify(manifest.targetPaths) !== JSON.stringify(documentationSetPaths))
    )
      return unavailable("observation-invalid");
  } catch {
    return unavailable("observation-invalid");
  }
  const state: VerifiedLocatorState = {
    manifest,
    result: input.result,
    source,
    target,
    snapshotSha256: input.snapshotSha256,
    verifyCurrent(query) {
      return verifyQuery(this, query);
    },
  };
  return { kind: "verified", authority: authorities.create(state) };
}

/** No caller-provided JSON object can act as a verified locator capability. */
export function resolveReviewLocator(
  authority: ReviewLocatorAuthority,
  query: ReviewLocatorQuery,
): ReviewLocatorResolution {
  const state = authorities.lookup(authority);
  return state?.verifyCurrent(query) ?? { kind: "unavailable", reason: "binding-mismatch" };
}
