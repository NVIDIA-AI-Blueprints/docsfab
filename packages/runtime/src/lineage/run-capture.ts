// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime task-lineage capture.
 *
 * Threads the versioned task-origin and decision-responsibility contracts
 * through cycle execution and resume. Every write-capable entry point (manual
 * workflow, autonomous cycle, tracker-selected, and resumed runs) mints
 * authenticated lineage at the trusted host boundary and then captures a
 * content-minimized projection as durable run evidence. The projection is
 * credential-free and prose-free, so it is safe to persist in a run record and
 * to feed the publication provenance projectors without leaking private
 * request text, approvals, or reasoning.
 */

import { canonicalJson, deepFreeze } from "../contract-kit/index.js";
import type { RunRecord } from "../records/contracts.js";
import * as workflowCatalog from "../workflow-registry/catalog.js";
import {
  TaskLineageContractError,
  assertTaskLineageAuthentic,
  decodePersistedDecisionLineage,
  decodePersistedTaskOrigin,
  projectTaskLineage,
  restoreTaskLineageArtifacts,
  serializeDecisionLineage,
  serializeTaskOrigin,
  type TaskLineageArtifactsV1,
  type TaskLineageHostCapability,
  type TaskLineageProjectionV1,
} from "./contracts.js";

export const RUN_TASK_LINEAGE_SCHEMA_VERSION = 1 as const;

export type RunTaskLineageErrorCode =
  | "invalid-run"
  | "lineage-unauthenticated"
  | "origin-not-executable"
  | "workflow-mismatch"
  | "revision-mismatch"
  | "resume-lineage-conflict";

export class RunTaskLineageError extends Error {
  public constructor(public readonly code: RunTaskLineageErrorCode) {
    super(`Run task-lineage runtime capture rejected the request for reason: ${code}.`);
    this.name = "RunTaskLineageError";
  }
}

function fail(code: RunTaskLineageErrorCode): never {
  throw new RunTaskLineageError(code);
}

/** Minimal run identity the capture and eligibility gates read; never the record body. */
type RunLineageContext = Pick<RunRecord, "workflow" | "repository">;

/**
 * Capture authenticated task lineage as the content-minimized projection stored
 * on a run record. The projection's selected workflow and executed revision must
 * match the run being executed so a later publication gate can trust that the
 * recorded origin and decision responsibility describe this exact run. Only the
 * genuine host-minted artifacts pass; caller- or model-authored lookalikes are
 * inert and rejected before any projection is produced.
 */
export function captureRunTaskLineage(
  record: RunLineageContext,
  artifacts: TaskLineageArtifactsV1,
): TaskLineageProjectionV1 {
  assertRunContext(record);
  try {
    assertTaskLineageAuthentic(artifacts, workflowCatalog);
  } catch (error) {
    if (error instanceof TaskLineageContractError) fail("lineage-unauthenticated");
    throw error;
  }
  const projection = projectTaskLineage(artifacts.origin, artifacts.lineage, workflowCatalog);
  const authenticated = projection.authorityStatus === "host-authenticated";
  const historical = projection.origin === "historical-unknown";
  if (!authenticated) fail("origin-not-executable");
  if (historical) fail("origin-not-executable");
  if (projection.selectedWorkflow !== record.workflow) fail("workflow-mismatch");
  if (projection.repositoryRevision !== record.repository.revision) fail("revision-mismatch");
  return projection;
}

/** Attach captured lineage to a mutable run record as durable run evidence. */
export function recordRunTaskLineage(
  record: RunRecord,
  artifacts: TaskLineageArtifactsV1,
): TaskLineageProjectionV1 {
  const projection = captureRunTaskLineage(record, artifacts);
  record.taskLineage = projection;
  return projection;
}

/**
 * Canonicalize authenticated lineage for durable, byte-stable persistence. The
 * exact strings round-trip through the persistence decoders and re-authenticate
 * against the original host capability, so a resumed run recovers identical
 * lineage rather than a re-minted variant.
 */
export function serializeRunTaskLineage(artifacts: TaskLineageArtifactsV1): {
  origin: string;
  lineage: string;
} {
  return {
    origin: serializeTaskOrigin(artifacts.origin),
    lineage: serializeDecisionLineage(artifacts.lineage, artifacts.origin, workflowCatalog),
  };
}

/**
 * Restore persisted lineage for a resumed run and re-capture its projection.
 * The persisted origin and decision bodies must decode byte-canonically and
 * re-authenticate against the run's original host capability, and the resulting
 * projection must equal the projection the earlier run recorded. Resume can
 * therefore never restate task origin, rationale, responsibility, or scope.
 */
export function restoreRunTaskLineage(
  persisted: { origin: string | Uint8Array; lineage: string | Uint8Array },
  capability: TaskLineageHostCapability,
  record: RunLineageContext,
  previous: TaskLineageProjectionV1 | undefined,
): TaskLineageProjectionV1 {
  assertPersistedShape(persisted);
  let artifacts: TaskLineageArtifactsV1;
  try {
    const origin = decodePersistedTaskOrigin(persisted.origin);
    const lineage = decodePersistedDecisionLineage(persisted.lineage, origin, workflowCatalog);
    artifacts = restoreTaskLineageArtifacts({ origin, lineage }, capability, workflowCatalog);
  } catch (error) {
    if (error instanceof TaskLineageContractError) fail("lineage-unauthenticated");
    throw error;
  }
  const projection = captureRunTaskLineage(record, artifacts);
  assertRunTaskLineageResumeEquivalent(previous, projection);
  return projection;
}

/**
 * Guard a resumed, retried, or idempotently replayed run: the previously
 * recorded lineage projection and the freshly captured projection must be
 * byte-for-byte identical. Any divergence in origin, rationale, decision
 * responsibility, or approved scope is rejected as a resume-lineage conflict.
 */
export function assertRunTaskLineageResumeEquivalent(
  previous: TaskLineageProjectionV1 | undefined,
  next: TaskLineageProjectionV1 | undefined,
): void {
  if (previous === undefined && next === undefined) return;
  if (previous === undefined) fail("resume-lineage-conflict");
  if (next === undefined) fail("resume-lineage-conflict");
  if (previous.projectionSha256 !== next.projectionSha256) fail("resume-lineage-conflict");
  if (canonicalJson(previous) !== canonicalJson(next)) fail("resume-lineage-conflict");
}

export const RUN_PUBLICATION_LINEAGE_DIAGNOSTICS = [
  "lineage-absent",
  "lineage-malformed",
  "lineage-unauthenticated",
  "lineage-historical",
  "workflow-mismatch",
  "revision-mismatch",
  "run-not-successful",
] as const;

export type RunPublicationLineageDiagnostic = (typeof RUN_PUBLICATION_LINEAGE_DIAGNOSTICS)[number];

export interface RunPublicationLineageEligibilityV1 {
  schemaVersion: 1;
  kind: "docsfab-run-publication-lineage-eligibility";
  eligible: boolean;
  diagnostics: RunPublicationLineageDiagnostic[];
}

/**
 * Decide whether a completed run may become publication-eligible on the basis of
 * its captured lineage, and enumerate content-free diagnostics for any missing
 * or incompatible lineage. A successful write run is eligible only when it
 * carries complete, host-authenticated, non-historical lineage bound to this
 * exact workflow and revision. Diagnostics are closed enum codes, so terminal
 * output can name the defect without revealing private text.
 */
export function evaluateRunPublicationLineageEligibility(
  record: Pick<RunRecord, "status" | "workflow" | "repository" | "taskLineage">,
): RunPublicationLineageEligibilityV1 {
  const diagnostics = new Set<RunPublicationLineageDiagnostic>();
  const lineage = record.taskLineage;
  if (lineage === undefined) diagnostics.add("lineage-absent");
  const malformed = lineage !== undefined && !isLineageProjection(lineage);
  if (malformed) diagnostics.add("lineage-malformed");
  const valid = lineage !== undefined && isLineageProjection(lineage);
  if (valid && lineage!.authorityStatus !== "host-authenticated")
    diagnostics.add("lineage-unauthenticated");
  if (valid && lineage!.origin === "historical-unknown") diagnostics.add("lineage-historical");
  if (valid && lineage!.selectedWorkflow !== record.workflow) diagnostics.add("workflow-mismatch");
  if (valid && lineage!.repositoryRevision !== record.repository.revision)
    diagnostics.add("revision-mismatch");
  if (record.status !== "succeeded") diagnostics.add("run-not-successful");
  const sorted = [...diagnostics].sort((left, right) => left.localeCompare(right));
  const eligible = sorted.length === 0;
  return deepFreeze({
    schemaVersion: RUN_TASK_LINEAGE_SCHEMA_VERSION,
    kind: "docsfab-run-publication-lineage-eligibility" as const,
    eligible,
    diagnostics: sorted,
  });
}

function isLineageProjection(value: TaskLineageProjectionV1): boolean {
  const kindOk = value.kind === "docsfab-task-lineage-projection";
  const versionOk = value.schemaVersion === 1;
  return kindOk && versionOk;
}

function assertRunContext(record: RunLineageContext): void {
  const isObject = record !== null && typeof record === "object";
  if (!isObject) fail("invalid-run");
  if (typeof record.workflow !== "string") fail("invalid-run");
  const repo = record.repository;
  const repoObject = repo !== null && typeof repo === "object";
  if (!repoObject) fail("invalid-run");
  if (typeof record.repository.revision !== "string") fail("invalid-run");
}

function assertPersistedShape(persisted: {
  origin: string | Uint8Array;
  lineage: string | Uint8Array;
}): void {
  const isObject = persisted !== null && typeof persisted === "object";
  if (!isObject) fail("lineage-unauthenticated");
  if (!isBytesOrString(persisted.origin)) fail("lineage-unauthenticated");
  if (!isBytesOrString(persisted.lineage)) fail("lineage-unauthenticated");
}

function isBytesOrString(value: unknown): value is string | Uint8Array {
  const isString = typeof value === "string";
  const isBytes = value instanceof Uint8Array;
  return isString || isBytes;
}
