// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Count undeclared judgment-row keys on an accepted judgment reply.
 *
 * Measurement, not enforcement: the host fill still ignores these keys. The
 * counts go into the accepted attempt's evidence so a campaign can decide
 * whether judgment rows should become strict.
 */

import { parseJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import { jsonEnvelopeBody } from "./json-envelope.js";
import {
  TECHNICAL_CORRECTION_ISSUE_JUDGMENT_KEYS,
  TECHNICAL_CORRECTION_OBLIGATION_JUDGMENT_KEYS,
  TECHNICAL_CORRECTION_REPLACEMENT_KEYS,
} from "../workflow-execution/source-obligation.js";
import type {
  JudgmentRowKeyAuditV1,
  JudgmentRowKeyCountV1,
} from "./judgment-row-key-audit-contract.js";
import type { DeclaredReplyKey } from "./rejected-reply-shape.js";

type Row = Record<string, JsonEvidenceValue>;

function objectRows(value: JsonEvidenceValue | undefined): Row[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Row => item !== null && typeof item === "object" && !Array.isArray(item),
  );
}

function countRows(
  rows: readonly Row[],
  declaredForRow: readonly string[],
  isDeclared: DeclaredReplyKey,
): JudgmentRowKeyCountV1 {
  let undeclaredKeys = 0;
  const named = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (declaredForRow.includes(key)) continue;
      undeclaredKeys += 1;
      if (isDeclared(key)) named.add(key);
    }
  }
  return { rows: rows.length, undeclaredKeys, namedUndeclaredKeys: [...named].sort() };
}

/**
 * The audit for an accepted judgment reply, or undefined when the reply is not
 * a judgment object. Pure and total: it never throws, so measuring cannot fail
 * a step the decoders already accepted.
 */
export function auditJudgmentRowKeys(
  reply: string,
  isDeclared: DeclaredReplyKey,
): JudgmentRowKeyAuditV1 | undefined {
  let parsed: JsonEvidenceValue;
  try {
    // The same shared extraction policy as the judgment decoder, so a fenced
    // judgment is measured too.
    parsed = parseJsonEvidence(jsonEnvelopeBody(reply).trim());
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  if (!Array.isArray(parsed.issueJudgments) && !Array.isArray(parsed.obligationJudgments)) {
    return undefined;
  }
  const obligationRows = objectRows(parsed.obligationJudgments);
  return {
    schemaVersion: 1,
    issueJudgments: countRows(
      objectRows(parsed.issueJudgments),
      TECHNICAL_CORRECTION_ISSUE_JUDGMENT_KEYS,
      isDeclared,
    ),
    obligationJudgments: countRows(
      obligationRows,
      TECHNICAL_CORRECTION_OBLIGATION_JUDGMENT_KEYS,
      isDeclared,
    ),
    replacements: countRows(
      obligationRows.flatMap((row) => objectRows(row.replacements)),
      TECHNICAL_CORRECTION_REPLACEMENT_KEYS,
      isDeclared,
    ),
  };
}
