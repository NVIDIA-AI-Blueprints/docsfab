// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Content-free record of undeclared judgment-row keys on an accepted judgment
 * reply; the host fill ignores those keys.
 *
 * Per row type it records the row count, the count of undeclared keys, and the
 * names of only those undeclared keys that some other DocsFab response contract
 * declares. Any other key is counted and never named.
 *
 * Kept a leaf (types and validator only) so the record contract can import it.
 */

import { REJECTED_REPLY_SHAPE_DECODE_CEILINGS } from "../config/inference-rejection-limits.js";
import { detectCredentialRuleIds } from "../security/repository-scanner.js";

export const JUDGMENT_ROW_TYPES = [
  "issueJudgments",
  "obligationJudgments",
  "replacements",
] as const;
export type JudgmentRowType = (typeof JUDGMENT_ROW_TYPES)[number];

export interface JudgmentRowKeyCountV1 {
  readonly rows: number;
  /** Key occurrences in these rows that the row's contract does not declare. */
  readonly undeclaredKeys: number;
  /**
   * Of those keys, the distinct names some DocsFab response contract declares
   * elsewhere (for example an echoed ledger field), sorted. Never any other key.
   */
  readonly namedUndeclaredKeys: readonly string[];
}

export interface JudgmentRowKeyAuditV1 {
  readonly schemaVersion: 1;
  readonly issueJudgments: JudgmentRowKeyCountV1;
  readonly obligationJudgments: JudgmentRowKeyCountV1;
  readonly replacements: JudgmentRowKeyCountV1;
}

const KEY_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isRowCount(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (
    Object.keys(value).some(
      (key) => !["rows", "undeclaredKeys", "namedUndeclaredKeys"].includes(key),
    )
  )
    return false;
  if (!isCount(value.rows) || !isCount(value.undeclaredKeys)) return false;
  const names = value.namedUndeclaredKeys;
  return (
    Array.isArray(names) &&
    names.length <= value.undeclaredKeys &&
    names.length <= REJECTED_REPLY_SHAPE_DECODE_CEILINGS.entries &&
    names.every(
      (name, index) =>
        typeof name === "string" &&
        KEY_NAME.test(name) &&
        detectCredentialRuleIds(name).length === 0 &&
        (index === 0 || String(names[index - 1]) < name),
    )
  );
}

/** Closed, content-free shape check shared by every record decoder. */
export function isJudgmentRowKeyAudit(value: unknown): value is JudgmentRowKeyAuditV1 {
  if (!isPlainObject(value)) return false;
  if (
    Object.keys(value).some(
      (key) => key !== "schemaVersion" && !JUDGMENT_ROW_TYPES.includes(key as JudgmentRowType),
    )
  )
    return false;
  return value.schemaVersion === 1 && JUDGMENT_ROW_TYPES.every((type) => isRowCount(value[type]));
}
