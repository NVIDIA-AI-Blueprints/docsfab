// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Name-keyed operator situation lookup: envelope `nextAction` and `docsAnchor`
 * resolve as `(error.name, error.code)`. The catalog maps are passed in by the
 * envelope to avoid an import cycle. Does not rename JSON `code` bytes or
 * import `@docsfab/host`. Ambiguous stems get one row per throwing class.
 */

import { inferRemediationId, remediationText, type OperatorRemediationId } from "./remediation.js";

export interface SituationLookupRow {
  readonly errorName: string;
  readonly code: string;
  /** Wins over the error's `nextAction` field and `DEFAULT_NEXT_ACTIONS[code]`. */
  readonly nextAction?: string;
  readonly docsAnchor?: string;
  /** Alias into `DEFAULT_*[aliasCode]` when this row omits its own text. */
  readonly aliasCode?: string;
  /** Throw-site identity. Never a message regex. */
  readonly mapsFrom: string;
}

/** The meaning of `write-grant-rejected` at every class that throws it. */
export const WRITE_GRANT_INERT_NEXT_ACTION =
  "Remove grant-shaped keys from the inert record. DocsFab never stores write or publish grants inside host packets, slash text, or progress identifiers.";

const WRITE_TARGET_CONFLICT_NEXT_ACTION =
  "Wait for the in-flight write to the same repository and branch to settle, then retry.";

const PACKET_CONFLICT_NEXT_ACTION =
  "Do not retry this request key; the host journal already bound it to a different packet fingerprint or a non-append-only event sequence.";

function grantRejected(errorName: string, mapsFrom: string): SituationLookupRow {
  return {
    errorName,
    code: "write-grant-rejected",
    nextAction: WRITE_GRANT_INERT_NEXT_ACTION,
    mapsFrom,
  };
}

function transportFailed(errorName: string, mapsFrom: string): SituationLookupRow {
  return {
    errorName,
    code: "transport-failed",
    mapsFrom,
  };
}

function migrationRequired(errorName: string, mapsFrom: string): SituationLookupRow {
  return {
    errorName,
    code: "migration-required",
    mapsFrom,
  };
}

/**
 * Collision and ambiguous-stem rows. `packet-in-flight` is omitted: host never
 * throws it. `session-conflict` is omitted: host returns it as an admission
 * result, not a thrown error.
 */
export const SITUATION_LOOKUP_ROWS: readonly SituationLookupRow[] = Object.freeze([
  {
    errorName: "WorkflowTaskValidationError",
    code: "shape",
    aliasCode: "invalid-shape",
    mapsFrom: "WorkflowTaskValidationError / workflow-contracts/task.ts taskKit.assertInert",
  },
  migrationRequired(
    "WorkflowTaskValidationError",
    "WorkflowTaskValidationError / workflow-contracts/task.ts kit schemaMismatch pass-through",
  ),
  migrationRequired(
    "ModelProfileMigrationError",
    "ModelProfileMigrationError / model/configuration.ts parseModelEndpoint",
  ),
  migrationRequired(
    "ExternalInputContractError",
    "ExternalInputContractError / inputs/contracts.ts createInputsDialect",
  ),
  migrationRequired(
    "ScorecardRecordError",
    "ScorecardRecordError / execution/inference-evidence.ts kit schemaMismatch pass-through",
  ),
  {
    errorName: "ModelCompositionError",
    code: "composition-retired",
    mapsFrom:
      "ModelCompositionError / model-composition/retirement.ts assertCompositionNotRetired and setup/retired-selections.ts retiredSelectionRefusal",
  },
  {
    errorName: "ModelCompositionError",
    code: "deployment-binding-mismatch",
    mapsFrom:
      "ModelCompositionError / model-composition/installed.ts resolveInstalledDeploymentEndpoint and assertInstalledDeploymentBaseUrl",
  },
  {
    errorName: "CredentialBoundaryError",
    code: "credential-isolation-boundary",
    mapsFrom:
      "CredentialBoundaryError / security/credential-isolation.ts assertModelRequestCredentialFree",
  },
  grantRejected(
    "HostProgressMapError",
    "HostProgressMapError.rejectUnsafeString / records/host-progress.ts",
  ),
  grantRejected("HostJobError", "HostJobError / host jobs/contracts.ts parsePacketRecord"),
  grantRejected("SlackSlashError", "SlackSlashError / host slack-slash/submit.ts"),
  grantRejected("GitLabMrMentionError", "GitLabMrMentionError / host gitlab-mr-mention dialect"),
  grantRejected("GitLabMrReplyError", "GitLabMrReplyError / host gitlab-mr-reply/resume.ts"),
  grantRejected(
    "GitLabRepositoryEventError",
    "GitLabRepositoryEventError / host gitlab-repository-events GRANT_SHAPE",
  ),
  grantRejected(
    "GitLabMergeRequestEventError",
    "GitLabMergeRequestEventError / host gitlab-merge-request-events WRITE_GRANT_TEXT",
  ),
  grantRejected(
    "LiveAgentSurfaceError",
    "LiveAgentSurfaceError / host channels/slack/live-agent LIVE_AGENT_GRANT_SHAPE",
  ),
  grantRejected(
    "SlackSocketAdapterError",
    "SlackSocketAdapterError / host channels/slack/ports.ts grant-shaped content",
  ),
  grantRejected(
    "ForgeChangeSourceError",
    "ForgeChangeSourceError / host forge-change-source dialect grant scan",
  ),
  {
    errorName: "HostJobError",
    code: "write-target-conflict",
    nextAction: WRITE_TARGET_CONFLICT_NEXT_ACTION,
    mapsFrom: "HostJobError / host jobs/spine.ts rejectWriteTargetConflict",
  },
  {
    errorName: "HostJobError",
    code: "packet-conflict",
    nextAction: PACKET_CONFLICT_NEXT_ACTION,
    mapsFrom: "HostJobError / host jobs/spine.ts submitJob fingerprint mismatch",
  },
  transportFailed(
    "ServicePersistenceError",
    "ServicePersistenceError / host service/persistence pool and database mapping",
  ),
  transportFailed(
    "SlackSocketAdapterError",
    "SlackSocketAdapterError / host channels/slack adapter and platform",
  ),
  transportFailed(
    "HostUpdateExistingMrError",
    "HostUpdateExistingMrError / host gitlab-publisher/update-existing-mr/http.ts",
  ),
  transportFailed("GitLabMrNoteError", "GitLabMrNoteError / host gitlab-mr-note/notify.ts"),
  transportFailed("ReviewSummaryError", "ReviewSummaryError / host review-summary/project.ts"),
  transportFailed(
    "ForgeChangeSourceError",
    "ForgeChangeSourceError / host forge-change-source transport boundary",
  ),
  transportFailed(
    "RepositoryIssueSourceError",
    "RepositoryIssueSourceError / host repository-issue-source/gitlab.ts",
  ),
  transportFailed("LiveAgentSurfaceError", "LiveAgentSurfaceError / host live-agent surface"),
]);

const ROWS_BY_KEY = new Map(
  SITUATION_LOOKUP_ROWS.map((row) => [rowKey(row.errorName, row.code), row] as const),
);

export function situationRowFor(error: unknown, code: string): SituationLookupRow | undefined {
  return ROWS_BY_KEY.get(rowKey(errorName(error), code));
}

/** Resolve operator nextAction as `(error.name, error.code)`, then string field, then defaults. */
export function lookupNextAction(
  error: unknown,
  code: string,
  defaults: Readonly<Record<string, string>>,
): string | undefined {
  const row = situationRowFor(error, code);
  if (row?.nextAction) return row.nextAction;
  const field = stringField(error, "nextAction");
  if (field) return field;
  const inferred = inferRemediationId(error);
  if (inferred) return remediationText(inferred);
  if (row?.aliasCode) return defaults[row.aliasCode];
  return defaults[code];
}

/** Resolve docsAnchor as `(error.name, error.code)`, then remediation, then defaults. */
export function lookupDocsAnchor(
  error: unknown,
  code: string,
  defaults: Readonly<Record<string, string>>,
  remediationAnchors: Readonly<Partial<Record<OperatorRemediationId, string>>>,
): string | undefined {
  const row = situationRowFor(error, code);
  if (row?.docsAnchor) return row.docsAnchor;
  const inferred = inferRemediationId(error);
  if (inferred) {
    const fromRemediation = remediationAnchors[inferred];
    if (fromRemediation) return fromRemediation;
  }
  if (row?.aliasCode) {
    const aliased = defaults[row.aliasCode];
    if (aliased) return aliased;
  }
  return defaults[code] ?? (inferred ? defaults[inferred] : undefined);
}

function rowKey(errorName: string, code: string): string {
  return `${errorName}\0${code}`;
}

function errorName(error: unknown): string {
  if (error instanceof Error && error.name.length > 0) return error.name;
  return "Error";
}

/** Operator nextAction is a string field; methods are ignored. */
function stringField(error: unknown, key: "nextAction"): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const value = (error as unknown as Record<string, unknown>)[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
