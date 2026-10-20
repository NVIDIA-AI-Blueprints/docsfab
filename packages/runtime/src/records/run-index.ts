// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Stable public entry point for run-index schema, projection, and decoding. */
export {
  RUN_INDEX_INTENT_ADMISSIONS,
  RUN_INDEX_INTENT_MODEL_UNAVAILABLE,
  RUN_INDEX_INTENT_TARGET_SOURCES,
  RUN_INDEX_LIMITS,
  RUN_INDEX_MODEL_SEPARATOR,
  RUN_INDEX_PROJECTION_REVISION,
  RUN_INDEX_QUERY_FIELDS,
  RUN_INDEX_READINESS_DISPOSITIONS,
  RUN_INDEX_REPLY_EXCERPT_READINGS,
  RUN_INDEX_REPLY_PARSED,
  RUN_INDEX_RETRY_DECISION_RULES,
  RUN_INDEX_ROW_KIND,
  RUN_INDEX_ROW_KINDS,
  RUN_INDEX_ROW_SCHEMA_VERSION,
  RUN_INDEX_RUN_END_REVISION,
  RUN_INDEX_SOURCE_EVIDENCE,
  RUN_INDEX_TERMINAL_STATUSES,
  carriedDocsfabRevision,
  docsfabBuildRevision,
  isRunIndexQueryField,
  isRunIndexTerminalStatus,
  sha256Hex,
} from "./run-index/schema.js";
export type {
  RunIndexIntentAdmission,
  RunIndexIntentTargetSource,
  RunIndexOrigin,
  RunIndexProjection,
  RunIndexQueryField,
  RunIndexReadinessDisposition,
  RunIndexRecordRefusal,
  RunIndexRejectionSource,
  RunIndexReplyExcerptReading,
  RunIndexRetryDecisionRule,
  RunIndexRowKind,
  RunIndexRowV1,
  RunIndexSnapshotContext,
  RunIndexSourceEvidence,
} from "./run-index/schema.js";
export { projectRunIndexRows } from "./run-index/projection.js";
export { decodeRunIndexRow } from "./run-index/decode.js";
