// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ResolvedLimit } from "../../config/limits.js";
import { enforceRunRecordMaxBytes, runRecordMaxBytes } from "../../records/run-record-limit.js";
import type { RunRecord } from "../../records/contracts.js";
import { parseJsonEvidence, type JsonEvidenceValue } from "../../json-evidence.js";

/**
 * Decode one acceptance run record under the one run-record bound every
 * reader shares: a larger record is refused by that limit's code, observed
 * size, and remediation, never reported as an invalid record.
 */
function decodeAcceptanceRunRecord(
  bytes: Uint8Array,
  bound: ResolvedLimit = runRecordMaxBytes(),
): RunRecord {
  enforceRunRecordMaxBytes(bytes.byteLength, bound);
  return parseAcceptanceJson(bytes, bound.value, "run record") as unknown as RunRecord;
}

function parseAcceptanceJson(
  bytes: Uint8Array,
  maximumBytes: number,
  label: string,
): JsonEvidenceValue {
  if (bytes.byteLength < 2 || bytes.byteLength > maximumBytes) {
    throw new Error(`Delivery acceptance ${label} is invalid.`);
  }
  try {
    return parseJsonEvidence(bytes);
  } catch {
    throw new Error(`Delivery acceptance ${label} is invalid.`);
  }
}

export { decodeAcceptanceRunRecord, parseAcceptanceJson };
