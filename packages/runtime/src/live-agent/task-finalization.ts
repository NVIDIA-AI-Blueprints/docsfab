// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed completion projection shared by interactive and task-file sessions.
 * This layer never creates or persists a RunRecord. Host observations and
 * workflow projections remain distinct from an agent's explicit declaration.
 */

import { createContractKit, deepFreeze } from "../contract-kit/index.js";
import type { RunResultV1 } from "../operator/run-result.js";
import {
  LIVE_AGENT_AGENT_DECISIONS,
  type LiveAgentTaskAgentDecisionV1,
  type LiveAgentTaskArtifactV1,
  type LiveAgentTaskCheckV1,
  type LiveAgentTaskEvidenceV1,
  type LiveAgentTaskResultV1,
  decodeLiveAgentTaskCompletionFieldsV1,
  decodeLiveAgentTaskCompletionIntegrityV1,
  decodeLiveAgentTaskResultV1,
  LIVE_AGENT_TASK_EXECUTION_STATUSES,
} from "./task-export.js";
import { liveAgentTaskRequestSha256, type LiveAgentTaskRequestV1 } from "./task-contract.js";

export const LIVE_AGENT_TASK_DECLARATION_KIND = "docsfab-live-agent-task-declaration" as const;

export interface LiveAgentTaskAgentDeclarationV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof LIVE_AGENT_TASK_DECLARATION_KIND;
  readonly decision: LiveAgentTaskAgentDecisionV1;
  readonly evidenceIds: readonly string[];
}

export interface LiveAgentTaskCompletionProjectionV1 {
  readonly executionStatus: (typeof LIVE_AGENT_TASK_EXECUTION_STATUSES)[number];
  readonly agentDecision: LiveAgentTaskAgentDecisionV1;
  readonly decisionEvidenceIds: readonly string[];
  readonly artifacts: readonly LiveAgentTaskArtifactV1[];
  readonly evidence: readonly LiveAgentTaskEvidenceV1[];
  readonly checks: readonly LiveAgentTaskCheckV1[];
  readonly noChangeClaim: LiveAgentTaskResultV1["noChangeClaim"];
  readonly diff: LiveAgentTaskResultV1["diff"];
  readonly childRunResults: LiveAgentTaskResultV1["childRunResults"];
  readonly nativeChildRecords: LiveAgentTaskResultV1["nativeChildRecords"];
  readonly usage: LiveAgentTaskResultV1["usage"];
  readonly trace: LiveAgentTaskResultV1["trace"];
  readonly limitations: readonly string[];
}

export interface FinalizeLiveAgentTaskCompletionInputV1 {
  readonly executionStatus: LiveAgentTaskCompletionProjectionV1["executionStatus"];
  readonly declaration: LiveAgentTaskAgentDeclarationV1 | unknown;
  readonly artifacts: readonly LiveAgentTaskArtifactV1[];
  readonly evidence: readonly LiveAgentTaskEvidenceV1[];
  readonly checks: readonly LiveAgentTaskCheckV1[];
  readonly diff: LiveAgentTaskCompletionProjectionV1["diff"];
  /** Existing projected results, kept in-process and reduced before export. */
  readonly childRunResults?: readonly Pick<RunResultV1, "execution">[];
  readonly nativeChildRecords: readonly LiveAgentTaskCompletionProjectionV1["nativeChildRecords"][number][];
  readonly usage: LiveAgentTaskCompletionProjectionV1["usage"];
  readonly trace: LiveAgentTaskCompletionProjectionV1["trace"];
  readonly limitations: readonly string[];
}

export type LiveAgentTaskFinalizationErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "missing-decision-evidence"
  | "missing-required-evidence"
  | "request-binding-mismatch";

export class LiveAgentTaskFinalizationError extends Error {
  public constructor(public readonly code: LiveAgentTaskFinalizationErrorCode) {
    super(`Live-agent task finalization failed (${code}).`);
    this.name = "LiveAgentTaskFinalizationError";
  }
}

function fail(code: LiveAgentTaskFinalizationErrorCode): never {
  throw new LiveAgentTaskFinalizationError(code);
}

const kit = createContractKit<LiveAgentTaskFinalizationErrorCode>({
  fail: (code) => fail(code),
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "invalid-value",
    credentialMaterial: "invalid-value",
    schemaMismatch: "invalid-value",
  },
});

function decodeIdList(value: unknown): string[] {
  const values = kit.array(value).map((entry) => kit.identifier(entry));
  kit.unique(values);
  return values.sort(kit.compare);
}

function decodeDeclaration(value: unknown): LiveAgentTaskAgentDeclarationV1 {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const declaration = kit.object(value);
  kit.exact(declaration, ["schemaVersion", "kind", "decision", "evidenceIds"]);
  if (declaration.schemaVersion !== 1 || declaration.kind !== LIVE_AGENT_TASK_DECLARATION_KIND) {
    fail("invalid-value");
  }
  return deepFreeze({
    schemaVersion: 1,
    kind: LIVE_AGENT_TASK_DECLARATION_KIND,
    decision: kit.enumeration(declaration.decision, LIVE_AGENT_AGENT_DECISIONS),
    evidenceIds: decodeIdList(declaration.evidenceIds),
  });
}

/**
 * Finalize common completion facts without requiring a benchmark request
 * manifest. Terminal sessions can use this projection; task runners bind it
 * to an admitted request with `bindLiveAgentTaskCompletionV1`.
 */
export function finalizeLiveAgentTaskCompletionV1(
  input: FinalizeLiveAgentTaskCompletionInputV1,
): LiveAgentTaskCompletionProjectionV1 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  const declaration = decodeDeclaration(input.declaration);
  let integrity: ReturnType<typeof decodeLiveAgentTaskCompletionIntegrityV1>;
  try {
    integrity = decodeLiveAgentTaskCompletionIntegrityV1({
      agentDecision: declaration.decision,
      decisionEvidenceIds: declaration.evidenceIds,
      evidence: input.evidence,
      diff: input.diff,
      nativeChildRecords: input.nativeChildRecords,
      usage: input.usage,
      trace: input.trace,
    });
  } catch {
    fail("invalid-value");
  }
  const evidenceById = new Map(integrity.evidence.map((entry) => [entry.evidenceId, entry]));
  if (declaration.evidenceIds.some((id) => !evidenceById.has(id)))
    fail("missing-decision-evidence");
  const childRunResults = (input.childRunResults ?? []).map(({ execution }) => ({
    runId: kit.identifier(execution.runId),
    workflow: kit.identifier(execution.workflow),
    status: kit.identifier(execution.status),
    exitCode: execution.exitCode,
    patchSha256: kit.nullableHash(execution.patchSha256),
  }));
  let completionFields: ReturnType<typeof decodeLiveAgentTaskCompletionFieldsV1>;
  try {
    completionFields = decodeLiveAgentTaskCompletionFieldsV1(
      {
        executionStatus: input.executionStatus,
        artifacts: input.artifacts,
        checks: input.checks,
        childRunResults,
        limitations: input.limitations,
      },
      integrity.evidence.map((entry) => entry.evidenceId),
    );
  } catch {
    fail("invalid-value");
  }

  return deepFreeze({
    executionStatus: completionFields.executionStatus,
    agentDecision: integrity.agentDecision,
    decisionEvidenceIds: integrity.decisionEvidenceIds,
    artifacts: completionFields.artifacts,
    evidence: integrity.evidence,
    checks: completionFields.checks,
    noChangeClaim: integrity.noChangeClaim,
    diff: integrity.diff,
    childRunResults: completionFields.childRunResults,
    nativeChildRecords: integrity.nativeChildRecords,
    usage: integrity.usage,
    trace: integrity.trace,
    limitations: completionFields.limitations,
  });
}

/** Bind the shared completion projection to the exact admitted task request. */
export function bindLiveAgentTaskCompletionV1(
  request: LiveAgentTaskRequestV1,
  completion: LiveAgentTaskCompletionProjectionV1,
): LiveAgentTaskResultV1 {
  if (
    request.requiredEvidence.some(
      (id) => !completion.evidence.some((entry) => entry.evidenceId === id),
    )
  ) {
    // Extra evidence is allowed; every request obligation must still have an
    // explicit available, missing, redacted, or clipped row in the result.
    fail("missing-required-evidence");
  }
  const result = {
    schemaVersion: 1 as const,
    kind: "docsfab-live-agent-task-result" as const,
    taskId: request.taskId,
    sessionId: request.sessionId,
    requestSha256: liveAgentTaskRequestSha256(request),
    ...completion,
    provenance: {
      baselineRevision: request.baseline.repositoryRevision,
      baselineContentSha256: request.baseline.contentSha256,
      sourceIds: request.sources.map((source) => source.sourceId),
    },
  };
  try {
    return decodeLiveAgentTaskResultV1(result, request);
  } catch (error) {
    if (error instanceof LiveAgentTaskFinalizationError) throw error;
    fail("invalid-value");
  }
}
