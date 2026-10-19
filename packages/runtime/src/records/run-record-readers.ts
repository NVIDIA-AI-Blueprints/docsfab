// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WorkflowName } from "../workflow-contracts/contracts.js";
import type { RunRecord, RunStatus } from "./contracts.js";
import { RUN_RECORD_FIELDS } from "./run-record-fields.js";

/**
 * What a strict run-record reader does with one writer field.
 *
 * - `decoded`: accepted and checked by a decoder this reader calls.
 * - `admitted`: accepted and passed through; this reader does not check it.
 * - `producer-not-admitted`: refused because only workflows this reader never
 *   reads write it (`RUN_RECORD_FIELD_PRODUCERS`).
 * - `failed-run-only`: refused because the writer leaves it only on failed
 *   runs and this reader admits no failed run.
 * - `unverified`: refused because this reader has no decoder for it yet. The
 *   gap is declared here rather than hidden in a short key list.
 */
export type RunRecordFieldDisposition =
  | "decoded"
  | "admitted"
  | "producer-not-admitted"
  | "failed-run-only"
  | "unverified";

export interface RunRecordReaderPolicy {
  /** Stable reader name, for test and refusal output. */
  readonly reader: string;
  readonly workflows: readonly WorkflowName[];
  readonly statuses: readonly RunStatus[];
  /** Every writer field, so a new `RunRecord` field fails to compile here. */
  readonly fields: Readonly<Record<keyof RunRecord, RunRecordFieldDisposition>>;
}

export interface RunRecordReader extends RunRecordReaderPolicy {
  /** The closed top-level key list, in writer field order. */
  readonly admittedKeys: readonly (keyof RunRecord)[];
}

/**
 * Derive a strict reader's closed key list from its declared disposition of
 * every writer field. Readers no longer keep their own key lists, so a field
 * added to the writer cannot silently turn one workflow's records into
 * contract refusals.
 */
export function defineRunRecordReader(policy: RunRecordReaderPolicy): RunRecordReader {
  const admittedKeys = RUN_RECORD_FIELDS.filter(
    (field) => policy.fields[field] === "decoded" || policy.fields[field] === "admitted",
  );
  return Object.freeze({
    ...policy,
    workflows: Object.freeze([...policy.workflows]),
    statuses: Object.freeze([...policy.statuses]),
    fields: Object.freeze({ ...policy.fields }),
    admittedKeys: Object.freeze(admittedKeys),
  });
}

/**
 * Whether `changes` is a read-only run's change evidence. The runner records
 * the changed-file list for every run (with a patch only for write steps), so
 * a read-only workflow's record carries exactly `{ files: [] }`.
 */
export function isReadOnlyRunChanges(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const files = (value as { files?: unknown }).files;
  return keys.length === 1 && keys[0] === "files" && Array.isArray(files) && files.length === 0;
}
