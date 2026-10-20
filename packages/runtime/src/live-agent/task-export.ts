// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Closed result/export protocol for a benchmark-neutral live-agent task. */

import type { Stats } from "node:fs";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { createContractKit, deepFreeze } from "../contract-kit/index.js";
import { canonicalJson } from "../content-ir/canonical.js";
import { ensurePrivateRunDirectory, SAFE_RECORD_ID } from "../records/file-store.js";
import { LIVE_AGENT_TASK_EXPORT_WORKER } from "./task-export-worker-source.js";
import {
  decodeLiveAgentTaskRequestV1,
  liveAgentTaskRequestSha256,
  type LiveAgentTaskRequestV1,
} from "./task-contract.js";

export const LIVE_AGENT_TASK_RESULT_KIND = "docsfab-live-agent-task-result" as const;
export const LIVE_AGENT_TASK_EXPORT_KIND = "docsfab-live-agent-task-export" as const;
export const LIVE_AGENT_TASK_EMPTY_DIFF_SUMMARY_SHA256 =
  "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" as const;
const PRIVATE_DIRECTORY_MODE = 0o700;

export const LIVE_AGENT_TASK_EXECUTION_STATUSES = [
  "completed",
  "partial",
  "needs-input",
  "refused",
  "cancelled",
  "failed",
] as const;
export type LiveAgentTaskExecutionStatusV1 = (typeof LIVE_AGENT_TASK_EXECUTION_STATUSES)[number];

export const LIVE_AGENT_AGENT_DECISIONS = [
  "change",
  "no-change",
  "needs-input",
  "refuse",
  "unknown",
] as const;
export type LiveAgentTaskAgentDecisionV1 = (typeof LIVE_AGENT_AGENT_DECISIONS)[number];

export const LIVE_AGENT_TASK_ARTIFACT_KINDS = [
  "document",
  "patch",
  "candidate",
  "report",
  "other",
] as const;
export const LIVE_AGENT_TASK_ARTIFACT_DISPOSITIONS = ["complete", "partial", "candidate"] as const;
export const LIVE_AGENT_TASK_EVIDENCE_KINDS = [
  "agent-declaration",
  "workflow-result",
  "diff",
  "test",
  "artifact",
  "host-record",
] as const;
export const LIVE_AGENT_TASK_EVIDENCE_AVAILABILITIES = [
  "available",
  "missing",
  "redacted",
  "clipped",
] as const;
export const LIVE_AGENT_TASK_CHECK_STATUSES = ["passed", "failed", "not-run", "unknown"] as const;
export const LIVE_AGENT_TASK_CHECK_AUTHORITIES = ["agent", "workflow", "host"] as const;
export const LIVE_AGENT_TASK_DIFF_STATUSES = ["empty", "non-empty", "unavailable"] as const;
export const LIVE_AGENT_TASK_USAGE_STATUSES = [
  "complete",
  "incomplete",
  "redacted",
  "unavailable",
] as const;
export const LIVE_AGENT_TASK_TRACE_STATUSES = [
  "complete",
  "incomplete",
  "redacted",
  "clipped",
  "unavailable",
] as const;

export interface LiveAgentTaskArtifactV1 {
  readonly artifactId: string;
  readonly kind: (typeof LIVE_AGENT_TASK_ARTIFACT_KINDS)[number];
  /** Workspace-relative path, never an absolute host path. */
  readonly path: string | null;
  readonly sha256: string;
  readonly disposition: (typeof LIVE_AGENT_TASK_ARTIFACT_DISPOSITIONS)[number];
}

export interface LiveAgentTaskEvidenceV1 {
  readonly evidenceId: string;
  readonly kind: (typeof LIVE_AGENT_TASK_EVIDENCE_KINDS)[number];
  readonly availability: (typeof LIVE_AGENT_TASK_EVIDENCE_AVAILABILITIES)[number];
  readonly sha256: string | null;
}

export interface LiveAgentTaskCheckV1 {
  readonly checkId: string;
  readonly status: (typeof LIVE_AGENT_TASK_CHECK_STATUSES)[number];
  readonly authority: (typeof LIVE_AGENT_TASK_CHECK_AUTHORITIES)[number];
  readonly evidenceIds: readonly string[];
}

export interface LiveAgentTaskResultV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof LIVE_AGENT_TASK_RESULT_KIND;
  readonly taskId: string;
  readonly sessionId: string;
  readonly requestSha256: string;
  readonly executionStatus: LiveAgentTaskExecutionStatusV1;
  /** The typed agent declaration is kept distinct from host/workflow checks. */
  readonly agentDecision: LiveAgentTaskAgentDecisionV1;
  readonly decisionEvidenceIds: readonly string[];
  readonly artifacts: readonly LiveAgentTaskArtifactV1[];
  readonly evidence: readonly LiveAgentTaskEvidenceV1[];
  readonly checks: readonly LiveAgentTaskCheckV1[];
  readonly noChangeClaim: {
    readonly claimed: boolean;
    readonly classification: "not-claimed" | "unsubstantiated" | "evidence-backed";
    readonly evidenceIds: readonly string[];
  };
  readonly diff: {
    readonly status: (typeof LIVE_AGENT_TASK_DIFF_STATUSES)[number];
    readonly sha256: string | null;
  };
  readonly provenance: {
    readonly baselineRevision: string;
    readonly baselineContentSha256: string;
    readonly sourceIds: readonly string[];
  };
  /** Sanitized projections of native child records; never includes record paths or bodies. */
  readonly childRunResults: readonly {
    readonly runId: string;
    readonly workflow: string;
    readonly status: string;
    readonly exitCode: 0 | 1 | 2;
    readonly patchSha256: string | null;
  }[];
  readonly nativeChildRecords: readonly {
    readonly recordId: string;
    readonly recordSha256: string | null;
  }[];
  readonly usage: {
    readonly status: (typeof LIVE_AGENT_TASK_USAGE_STATUSES)[number];
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly totalTokens: number | null;
  };
  readonly trace: {
    readonly status: (typeof LIVE_AGENT_TASK_TRACE_STATUSES)[number];
    readonly activitySha256: string | null;
    readonly childRecordIds: readonly string[];
    readonly missing: readonly string[];
  };
  readonly limitations: readonly string[];
}

export type LiveAgentTaskExportErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "task-binding-mismatch"
  | "missing-required-evidence"
  | "record-exists"
  | "write-failed";

export class LiveAgentTaskExportError extends Error {
  public constructor(public readonly code: LiveAgentTaskExportErrorCode) {
    super(`Live-agent task export failed (${code}).`);
    this.name = "LiveAgentTaskExportError";
  }
}

function fail(code: LiveAgentTaskExportErrorCode): never {
  throw new LiveAgentTaskExportError(code);
}

const kit = createContractKit<LiveAgentTaskExportErrorCode>({
  fail: (code) => fail(code),
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "invalid-value",
  },
});

function safeRelativePath(value: unknown): string | null {
  if (value === null) return null;
  const result = kit.string(value);
  if (
    result.length === 0 ||
    result.startsWith("/") ||
    /^[A-Za-z]:/u.test(result) ||
    result.includes("\\") ||
    result.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail("invalid-value");
  }
  return result;
}

function decodeIdList(value: unknown): string[] {
  const values = kit.array(value).map((entry) => kit.identifier(entry));
  kit.unique(values);
  return values.sort(kit.compare);
}

function decodeTokenCount(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail("invalid-value");
  return value as number;
}

export type LiveAgentTaskCompletionFieldsV1 = Pick<
  LiveAgentTaskResultV1,
  "executionStatus" | "artifacts" | "checks" | "childRunResults" | "limitations"
>;

/** Decode result fields shared by standalone completion and bound exports. */
export function decodeLiveAgentTaskCompletionFieldsV1(
  value: unknown,
  evidenceIds: readonly string[],
): LiveAgentTaskCompletionFieldsV1 {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(root, ["executionStatus", "artifacts", "checks", "childRunResults", "limitations"]);
  const knownEvidence = new Set(decodeIdList(evidenceIds));
  const artifacts = kit.array(root.artifacts).map((entry) => {
    const artifact = kit.object(entry);
    kit.exact(artifact, ["artifactId", "kind", "path", "sha256", "disposition"]);
    return {
      artifactId: kit.identifier(artifact.artifactId),
      kind: kit.enumeration(artifact.kind, LIVE_AGENT_TASK_ARTIFACT_KINDS),
      path: safeRelativePath(artifact.path),
      sha256: kit.hash(artifact.sha256),
      disposition: kit.enumeration(artifact.disposition, LIVE_AGENT_TASK_ARTIFACT_DISPOSITIONS),
    };
  });
  kit.unique(artifacts.map((entry) => entry.artifactId));

  const checks = kit.array(root.checks).map((entry) => {
    const check = kit.object(entry);
    kit.exact(check, ["checkId", "status", "authority", "evidenceIds"]);
    const checkEvidenceIds = decodeIdList(check.evidenceIds);
    if (checkEvidenceIds.some((id) => !knownEvidence.has(id))) fail("invalid-value");
    return {
      checkId: kit.identifier(check.checkId),
      status: kit.enumeration(check.status, LIVE_AGENT_TASK_CHECK_STATUSES),
      authority: kit.enumeration(check.authority, LIVE_AGENT_TASK_CHECK_AUTHORITIES),
      evidenceIds: checkEvidenceIds,
    };
  });
  kit.unique(checks.map((entry) => entry.checkId));

  const childRunResults = kit.array(root.childRunResults).map((entry) => {
    const child = kit.object(entry);
    kit.exact(child, ["runId", "workflow", "status", "exitCode", "patchSha256"]);
    if (child.exitCode !== 0 && child.exitCode !== 1 && child.exitCode !== 2) fail("invalid-value");
    return {
      runId: kit.identifier(child.runId),
      workflow: kit.identifier(child.workflow),
      status: kit.identifier(child.status),
      exitCode: child.exitCode as 0 | 1 | 2,
      patchSha256: kit.nullableHash(child.patchSha256),
    };
  });
  kit.unique(childRunResults.map((entry) => entry.runId));

  return deepFreeze({
    executionStatus: kit.enumeration(root.executionStatus, LIVE_AGENT_TASK_EXECUTION_STATUSES),
    artifacts,
    checks,
    childRunResults,
    limitations: kit.array(root.limitations).map((entry) => kit.string(entry)),
  });
}

export type LiveAgentTaskCompletionIntegrityV1 = Pick<
  LiveAgentTaskResultV1,
  | "agentDecision"
  | "decisionEvidenceIds"
  | "evidence"
  | "noChangeClaim"
  | "diff"
  | "nativeChildRecords"
  | "usage"
  | "trace"
>;

/** Shared evidence/usage/trace integrity checks for terminal and task exports. */
export function decodeLiveAgentTaskCompletionIntegrityV1(
  value: unknown,
): LiveAgentTaskCompletionIntegrityV1 {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  const keys = [
    "agentDecision",
    "decisionEvidenceIds",
    "evidence",
    "diff",
    "nativeChildRecords",
    "usage",
    "trace",
  ];
  const hasNoChangeClaim = Object.hasOwn(root, "noChangeClaim");
  kit.exact(root, hasNoChangeClaim ? [...keys, "noChangeClaim"] : keys);
  const agentDecision = kit.enumeration(root.agentDecision, LIVE_AGENT_AGENT_DECISIONS);
  const decisionEvidenceIds = decodeIdList(root.decisionEvidenceIds);

  const evidence = kit.array(root.evidence).map((entry) => {
    const item = kit.object(entry);
    kit.exact(item, ["evidenceId", "kind", "availability", "sha256"]);
    const availability = kit.enumeration(
      item.availability,
      LIVE_AGENT_TASK_EVIDENCE_AVAILABILITIES,
    );
    const sha256 = kit.nullableHash(item.sha256);
    if ((availability === "available") !== (sha256 !== null)) fail("invalid-value");
    return {
      evidenceId: kit.identifier(item.evidenceId),
      kind: kit.enumeration(item.kind, LIVE_AGENT_TASK_EVIDENCE_KINDS),
      availability,
      sha256,
    };
  });
  kit.unique(evidence.map((item) => item.evidenceId));
  const evidenceById = new Map(evidence.map((item) => [item.evidenceId, item]));
  if (decisionEvidenceIds.some((id) => !evidenceById.has(id))) fail("invalid-value");

  const diffRecord = kit.object(root.diff);
  kit.exact(diffRecord, ["status", "sha256"]);
  const diffStatus = kit.enumeration(diffRecord.status, LIVE_AGENT_TASK_DIFF_STATUSES);
  const diffSha256 = kit.nullableHash(diffRecord.sha256);
  if (
    (diffStatus === "non-empty" && diffSha256 === null) ||
    (diffStatus === "unavailable" && diffSha256 !== null) ||
    (diffStatus === "empty" &&
      diffSha256 !== null &&
      diffSha256 !== LIVE_AGENT_TASK_EMPTY_DIFF_SUMMARY_SHA256)
  ) {
    fail("invalid-value");
  }

  const claimRecord = hasNoChangeClaim ? kit.object(root.noChangeClaim) : undefined;
  if (claimRecord) kit.exact(claimRecord, ["claimed", "classification", "evidenceIds"]);
  if (claimRecord && typeof claimRecord.claimed !== "boolean") fail("invalid-value");
  const noChangeEvidenceIds = claimRecord
    ? decodeIdList(claimRecord.evidenceIds)
    : decisionEvidenceIds;
  if (noChangeEvidenceIds.some((id) => !evidenceById.has(id))) fail("invalid-value");
  const claimed: boolean = claimRecord
    ? (claimRecord.claimed as boolean)
    : agentDecision === "no-change";
  const structurallyBacked =
    claimed &&
    agentDecision === "no-change" &&
    diffStatus === "empty" &&
    diffSha256 !== null &&
    noChangeEvidenceIds.length > 0 &&
    noChangeEvidenceIds.every((id) => evidenceById.get(id)?.availability === "available");
  const expectedClassification = claimed
    ? structurallyBacked
      ? "evidence-backed"
      : "unsubstantiated"
    : "not-claimed";
  const classification = claimRecord
    ? kit.enumeration(claimRecord.classification, [
        "not-claimed",
        "unsubstantiated",
        "evidence-backed",
      ] as const)
    : expectedClassification;
  if (classification !== expectedClassification) {
    fail("invalid-value");
  }

  const nativeChildRecords = kit.array(root.nativeChildRecords).map((entry) => {
    const record = kit.object(entry);
    kit.exact(record, ["recordId", "recordSha256"]);
    return {
      recordId: kit.identifier(record.recordId),
      recordSha256: kit.nullableHash(record.recordSha256),
    };
  });
  kit.unique(nativeChildRecords.map((record) => record.recordId));

  const usageRecord = kit.object(root.usage);
  kit.exact(usageRecord, ["status", "inputTokens", "outputTokens", "totalTokens"]);
  const usageStatus = kit.enumeration(usageRecord.status, LIVE_AGENT_TASK_USAGE_STATUSES);
  const inputTokens = decodeTokenCount(usageRecord.inputTokens);
  const outputTokens = decodeTokenCount(usageRecord.outputTokens);
  const totalTokens = decodeTokenCount(usageRecord.totalTokens);
  if (
    usageStatus === "complete" &&
    (inputTokens === null || outputTokens === null || totalTokens === null)
  ) {
    fail("invalid-value");
  }

  const traceRecord = kit.object(root.trace);
  kit.exact(traceRecord, ["status", "activitySha256", "childRecordIds", "missing"]);
  const traceStatus = kit.enumeration(traceRecord.status, LIVE_AGENT_TASK_TRACE_STATUSES);
  const childRecordIds = decodeIdList(traceRecord.childRecordIds);
  if (childRecordIds.some((id) => !nativeChildRecords.some((record) => record.recordId === id)))
    fail("invalid-value");
  const missing = kit.array(traceRecord.missing).map((entry) => kit.identifier(entry));
  kit.unique(missing);
  const activitySha256 = kit.nullableHash(traceRecord.activitySha256);
  if (traceStatus === "complete" && (missing.length > 0 || activitySha256 === null))
    fail("invalid-value");

  return deepFreeze({
    agentDecision,
    decisionEvidenceIds,
    evidence,
    noChangeClaim: {
      claimed,
      classification,
      evidenceIds: noChangeEvidenceIds,
    },
    diff: { status: diffStatus, sha256: diffSha256 },
    nativeChildRecords,
    usage: {
      status: usageStatus,
      inputTokens,
      outputTokens,
      totalTokens,
    },
    trace: {
      status: traceStatus,
      activitySha256,
      childRecordIds,
      missing,
    },
  });
}

/** Decode a result and bind its task/session ids and mandatory evidence to the request. */
export function decodeLiveAgentTaskResultV1(
  value: unknown,
  requestValue: LiveAgentTaskRequestV1 | unknown,
): LiveAgentTaskResultV1 {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const request = decodeLiveAgentTaskRequestV1(requestValue);
  const root = kit.object(value);
  kit.exact(root, [
    "schemaVersion",
    "kind",
    "taskId",
    "sessionId",
    "requestSha256",
    "executionStatus",
    "agentDecision",
    "decisionEvidenceIds",
    "artifacts",
    "evidence",
    "checks",
    "noChangeClaim",
    "diff",
    "provenance",
    "childRunResults",
    "nativeChildRecords",
    "usage",
    "trace",
    "limitations",
  ]);
  if (root.schemaVersion !== 1 || root.kind !== LIVE_AGENT_TASK_RESULT_KIND) fail("invalid-value");
  const taskId = kit.identifier(root.taskId);
  const sessionId = kit.identifier(root.sessionId);
  const requestSha256 = kit.hash(root.requestSha256);
  if (
    taskId !== request.taskId ||
    sessionId !== request.sessionId ||
    requestSha256 !== liveAgentTaskRequestSha256(request)
  ) {
    fail("task-binding-mismatch");
  }

  const evidence = kit.array(root.evidence).map((entry) => {
    const item = kit.object(entry);
    kit.exact(item, ["evidenceId", "kind", "availability", "sha256"]);
    const availability = kit.enumeration(
      item.availability,
      LIVE_AGENT_TASK_EVIDENCE_AVAILABILITIES,
    );
    const digest = kit.nullableHash(item.sha256);
    if (availability === "available" && digest === null) fail("invalid-value");
    if (availability !== "available" && digest !== null) fail("invalid-value");
    return {
      evidenceId: kit.identifier(item.evidenceId),
      kind: kit.enumeration(item.kind, LIVE_AGENT_TASK_EVIDENCE_KINDS),
      availability,
      sha256: digest,
    };
  });
  const evidenceById = new Map(evidence.map((entry) => [entry.evidenceId, entry]));
  kit.unique(evidence.map((entry) => entry.evidenceId));
  if (request.requiredEvidence.some((id) => !evidenceById.has(id)))
    fail("missing-required-evidence");
  const completionFields = decodeLiveAgentTaskCompletionFieldsV1(
    {
      executionStatus: root.executionStatus,
      artifacts: root.artifacts,
      checks: root.checks,
      childRunResults: root.childRunResults,
      limitations: root.limitations,
    },
    evidence.map((entry) => entry.evidenceId),
  );

  const decisionEvidenceIds = decodeIdList(root.decisionEvidenceIds);
  if (decisionEvidenceIds.some((id) => !evidenceById.has(id))) fail("invalid-value");
  const agentDecision = kit.enumeration(root.agentDecision, LIVE_AGENT_AGENT_DECISIONS);
  const claimRecord = kit.object(root.noChangeClaim);
  kit.exact(claimRecord, ["claimed", "classification", "evidenceIds"]);
  if (typeof claimRecord.claimed !== "boolean") fail("invalid-value");
  const noChangeEvidenceIds = decodeIdList(claimRecord.evidenceIds);
  if (noChangeEvidenceIds.some((id) => !evidenceById.has(id))) fail("invalid-value");

  const diffRecord = kit.object(root.diff);
  kit.exact(diffRecord, ["status", "sha256"]);
  const diffStatus = kit.enumeration(diffRecord.status, LIVE_AGENT_TASK_DIFF_STATUSES);
  const diffSha256 = kit.nullableHash(diffRecord.sha256);
  if (
    (diffStatus === "non-empty" && diffSha256 === null) ||
    (diffStatus === "unavailable" && diffSha256 !== null)
  ) {
    fail("invalid-value");
  }

  const classification = kit.enumeration(claimRecord.classification, [
    "not-claimed",
    "unsubstantiated",
    "evidence-backed",
  ] as const);
  const structurallyBacked =
    claimRecord.claimed === true &&
    agentDecision === "no-change" &&
    diffStatus === "empty" &&
    diffSha256 !== null &&
    noChangeEvidenceIds.length > 0 &&
    noChangeEvidenceIds.every((id) => evidenceById.get(id)?.availability === "available");
  if (
    classification !==
    (claimRecord.claimed === false
      ? "not-claimed"
      : structurallyBacked
        ? "evidence-backed"
        : "unsubstantiated")
  ) {
    fail("invalid-value");
  }

  const provenanceRecord = kit.object(root.provenance);
  kit.exact(provenanceRecord, ["baselineRevision", "baselineContentSha256", "sourceIds"]);
  const sourceIds = decodeIdList(provenanceRecord.sourceIds);
  if (
    sourceIds.length !== request.sources.length ||
    sourceIds.some((id) => !request.sources.some((source) => source.sourceId === id))
  ) {
    fail("task-binding-mismatch");
  }
  if (
    kit.revision(provenanceRecord.baselineRevision) !== request.baseline.repositoryRevision ||
    kit.hash(provenanceRecord.baselineContentSha256) !== request.baseline.contentSha256
  ) {
    fail("task-binding-mismatch");
  }

  const nativeChildRecords = kit.array(root.nativeChildRecords).map((entry) => {
    const record = kit.object(entry);
    kit.exact(record, ["recordId", "recordSha256"]);
    return {
      recordId: kit.identifier(record.recordId),
      recordSha256: kit.nullableHash(record.recordSha256),
    };
  });
  kit.unique(nativeChildRecords.map((entry) => entry.recordId));

  const usageRecord = kit.object(root.usage);
  kit.exact(usageRecord, ["status", "inputTokens", "outputTokens", "totalTokens"]);
  const usageStatus = kit.enumeration(usageRecord.status, LIVE_AGENT_TASK_USAGE_STATUSES);
  const inputTokens = decodeTokenCount(usageRecord.inputTokens);
  const outputTokens = decodeTokenCount(usageRecord.outputTokens);
  const totalTokens = decodeTokenCount(usageRecord.totalTokens);
  if (
    usageStatus === "complete" &&
    (inputTokens === null || outputTokens === null || totalTokens === null)
  ) {
    fail("invalid-value");
  }

  const traceRecord = kit.object(root.trace);
  kit.exact(traceRecord, ["status", "activitySha256", "childRecordIds", "missing"]);
  const traceStatus = kit.enumeration(traceRecord.status, LIVE_AGENT_TASK_TRACE_STATUSES);
  const childRecordIds = decodeIdList(traceRecord.childRecordIds);
  if (childRecordIds.some((id) => !nativeChildRecords.some((record) => record.recordId === id)))
    fail("invalid-value");
  const missing = kit.array(traceRecord.missing).map((entry) => kit.identifier(entry));
  kit.unique(missing);
  const activitySha256 = kit.nullableHash(traceRecord.activitySha256);
  if (traceStatus === "complete" && (missing.length > 0 || activitySha256 === null))
    fail("invalid-value");

  const integrity = decodeLiveAgentTaskCompletionIntegrityV1({
    agentDecision,
    decisionEvidenceIds,
    evidence,
    noChangeClaim: {
      claimed: claimRecord.claimed,
      classification,
      evidenceIds: noChangeEvidenceIds,
    },
    diff: { status: diffStatus, sha256: diffSha256 },
    nativeChildRecords,
    usage: {
      status: usageStatus,
      inputTokens,
      outputTokens,
      totalTokens,
    },
    trace: {
      status: traceStatus,
      activitySha256,
      childRecordIds,
      missing,
    },
  });
  return deepFreeze({
    schemaVersion: 1 as const,
    kind: LIVE_AGENT_TASK_RESULT_KIND,
    taskId,
    sessionId,
    requestSha256,
    executionStatus: completionFields.executionStatus,
    agentDecision: integrity.agentDecision,
    decisionEvidenceIds: integrity.decisionEvidenceIds,
    artifacts: completionFields.artifacts,
    evidence: integrity.evidence,
    checks: completionFields.checks,
    noChangeClaim: integrity.noChangeClaim,
    diff: integrity.diff,
    provenance: {
      baselineRevision: kit.revision(provenanceRecord.baselineRevision),
      baselineContentSha256: kit.hash(provenanceRecord.baselineContentSha256),
      sourceIds,
    },
    childRunResults: completionFields.childRunResults,
    nativeChildRecords: integrity.nativeChildRecords,
    usage: integrity.usage,
    trace: integrity.trace,
    limitations: completionFields.limitations,
  });
}

export interface LiveAgentTaskExportV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof LIVE_AGENT_TASK_EXPORT_KIND;
  readonly taskId: string;
  readonly sessionId: string;
  readonly request: LiveAgentTaskRequestV1;
  readonly requestSha256: string;
  readonly result: LiveAgentTaskResultV1;
  readonly resultSha256: string;
  readonly exportSha256: string;
}

/** Validate every digest and cross-reference in a retained export. */
export function decodeLiveAgentTaskExportV1(value: unknown): LiveAgentTaskExportV1 {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(root, [
    "schemaVersion",
    "kind",
    "taskId",
    "sessionId",
    "request",
    "requestSha256",
    "result",
    "resultSha256",
    "exportSha256",
  ]);
  if (root.schemaVersion !== 1 || root.kind !== LIVE_AGENT_TASK_EXPORT_KIND) fail("invalid-value");
  const request = decodeLiveAgentTaskRequestV1(root.request);
  const requestSha256 = kit.hash(root.requestSha256);
  if (requestSha256 !== liveAgentTaskRequestSha256(request)) fail("digest-mismatch");
  const result = decodeLiveAgentTaskResultV1(root.result, request);
  const resultSha256 = kit.hash(root.resultSha256);
  if (resultSha256 !== digest(result)) fail("digest-mismatch");
  const body = {
    schemaVersion: 1 as const,
    kind: LIVE_AGENT_TASK_EXPORT_KIND,
    taskId: request.taskId,
    sessionId: request.sessionId,
    request,
    requestSha256,
    result,
    resultSha256,
  };
  const exportSha256 = kit.hash(root.exportSha256);
  if (
    kit.identifier(root.taskId) !== request.taskId ||
    kit.identifier(root.sessionId) !== request.sessionId ||
    exportSha256 !== digest(body)
  ) {
    fail("digest-mismatch");
  }
  return deepFreeze({ ...body, exportSha256 });
}

function digest(value: unknown): string {
  return kit.canonicalDigest(value);
}

export function createLiveAgentTaskExportV1(
  requestValue: LiveAgentTaskRequestV1 | unknown,
  resultValue: LiveAgentTaskResultV1 | unknown,
): LiveAgentTaskExportV1 {
  const request = decodeLiveAgentTaskRequestV1(requestValue);
  const result = decodeLiveAgentTaskResultV1(resultValue, request);
  kit.rejectCredentials({ request, result });
  const body = {
    schemaVersion: 1 as const,
    kind: LIVE_AGENT_TASK_EXPORT_KIND,
    taskId: request.taskId,
    sessionId: request.sessionId,
    request,
    requestSha256: liveAgentTaskRequestSha256(request),
    result,
    resultSha256: digest(result),
  };
  return deepFreeze({ ...body, exportSha256: digest(body) });
}

/** Write a private, digest-bound export atomically without replacing an existing file. */
export async function writeLiveAgentTaskExport(
  resultDirectory: string,
  request: LiveAgentTaskRequestV1 | unknown,
  result: LiveAgentTaskResultV1 | unknown,
): Promise<{ readonly path: string; readonly exportSha256: string }> {
  const exportRecord = createLiveAgentTaskExportV1(request, result);
  const payload = `${canonicalJson(exportRecord)}\n`;
  const path = await writeLiveAgentTaskPayload(
    resultDirectory,
    `${exportRecord.requestSha256}.json`,
    payload,
  );
  return { path, exportSha256: exportRecord.exportSha256 };
}

/** Seal a public content-free activity companion before its export binds the exact bytes. */
export async function writeLiveAgentTaskActivity(
  resultDirectory: string,
  requestSha256: string,
  bytes: Buffer,
): Promise<{ readonly path: string; readonly activitySha256: string }> {
  if (!/^[a-f0-9]{64}$/u.test(requestSha256)) fail("invalid-value");
  const payload = bytes.toString("utf8");
  if (!Buffer.from(payload, "utf8").equals(bytes)) fail("invalid-value");
  const path = await writeLiveAgentTaskPayload(
    resultDirectory,
    `${requestSha256}.activity.jsonl`,
    payload,
  );
  return { path, activitySha256: createHash("sha256").update(bytes).digest("hex") };
}

async function writeLiveAgentTaskPayload(
  resultDirectory: string,
  destination: string,
  payload: string,
): Promise<string> {
  const requestedRoot = resolve(resultDirectory);
  try {
    await ensurePrivateRunDirectory(requestedRoot);
    const root = await realpath(requestedRoot);
    const rootStat = await safeLstat(root);
    assertPrivateDirectory(rootStat);
    const ancestors = await captureTrustedAncestors(dirname(root));
    await assertTrustedRoot(requestedRoot, root, rootStat, ancestors);

    const temporaryId = randomUUID();
    const stageId = randomUUID();
    if (!SAFE_RECORD_ID.test(temporaryId) || !SAFE_RECORD_ID.test(stageId)) fail("write-failed");
    const payloadSha256 = createHash("sha256").update(payload, "utf8").digest("hex");
    const input = JSON.stringify({
      root: {
        dev: Number(rootStat.dev),
        ino: Number(rootStat.ino),
        uid: Number(rootStat.uid),
        mode: Number(rootStat.mode) & 0o7777,
      },
      stage: `.task-export-${stageId}`,
      temporary: `.export-${temporaryId}.tmp`,
      destination,
      payload,
      payloadSha256,
    });
    const code = await runTaskExportWorker(root, input);
    await assertTrustedRoot(requestedRoot, root, rootStat, ancestors);
    if (code === 3) fail("record-exists");
    if (code !== 0) fail("write-failed");
    return join(root, destination);
  } catch (error) {
    if (error instanceof LiveAgentTaskExportError) throw error;
    return fail("write-failed");
  }
}

function assertPrivateDirectory(stat: Stats): void {
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.uid !== uid ||
    (stat.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE
  ) {
    fail("write-failed");
  }
}

interface TrustedAncestor {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: number;
}

async function captureTrustedAncestors(path: string): Promise<readonly TrustedAncestor[]> {
  const uid = process.getuid?.();
  if (uid === undefined || process.platform === "win32") fail("write-failed");
  const paths: string[] = [];
  let current = resolve(path);
  for (;;) {
    paths.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const ancestors: TrustedAncestor[] = [];
  for (const ancestor of paths.reverse()) {
    const stat = await safeLstat(ancestor);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      (stat.uid !== uid && stat.uid !== 0) ||
      ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)
    ) {
      fail("write-failed");
    }
    ancestors.push({
      path: ancestor,
      dev: Number(stat.dev),
      ino: Number(stat.ino),
      uid: Number(stat.uid),
      mode: Number(stat.mode) & 0o7777,
    });
  }
  return ancestors;
}

async function assertTrustedRoot(
  requestedRoot: string,
  root: string,
  expected: Stats,
  ancestors: readonly TrustedAncestor[],
): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined || process.platform === "win32") fail("write-failed");
  for (const ancestor of ancestors) {
    const current = await safeLstat(ancestor.path);
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== ancestor.dev ||
      current.ino !== ancestor.ino ||
      current.uid !== ancestor.uid ||
      (current.mode & 0o7777) !== ancestor.mode
    ) {
      fail("write-failed");
    }
  }
  const current = await safeLstat(root);
  assertPrivateDirectory(current);
  if (
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    (await realpath(requestedRoot)) !== root
  ) {
    fail("write-failed");
  }
}

async function safeLstat(path: string): Promise<Stats> {
  try {
    return await lstat(path);
  } catch {
    return fail("write-failed");
  }
}

async function runTaskExportWorker(root: string, input: string): Promise<number> {
  return new Promise((resolveCode, reject) => {
    let spawnError: Error | undefined;
    let stdinError: Error | undefined;
    let settled = false;
    let child;
    try {
      child = spawn(
        process.execPath,
        ["--input-type=module", "-e", LIVE_AGENT_TASK_EXPORT_WORKER],
        {
          cwd: root,
          env: { LC_ALL: "C", LANG: "C" },
          stdio: ["pipe", "ignore", "ignore"],
          windowsHide: true,
        },
      );
    } catch (error) {
      reject(error);
      return;
    }
    child.once("error", (error) => {
      spawnError = error;
    });
    child.stdin.once("error", (error) => {
      stdinError = error;
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (spawnError || stdinError || signal !== null || code === null)
        reject(spawnError ?? stdinError ?? new Error("Task export worker did not exit cleanly."));
      else resolveCode(code);
    });
    child.stdin.end(input);
  });
}
