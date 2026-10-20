// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { assertInertTransportData } from "../../reader-task-transport.js";
import {
  bad,
  canonicalJson,
  containsCredentialDeep,
  freezeDeep,
  id,
  nonnegative,
  record,
  sha,
} from "../wire-decode.js";
import type { HostRuntimeSemanticCitationV1 } from "./types.js";

/** Inert JSON transport only. This guard does not admit source evidence or grant authority. */
export function assertHostRuntimeSemanticData(input: unknown): void {
  assertInertTransportData(input, bad);
}

/** Serialized semantic content only; no approved-baseline or before-record check is performed. */
export function parseHostRuntimeSemanticClaimCoreData(input: unknown): {
  readonly claim_id: string;
  readonly statement: string;
  readonly scope: Readonly<Record<string, unknown>>;
} {
  assertHostRuntimeSemanticData(input);
  const row = record(input, ["claim_id", "statement", "scope"]);
  id(row.claim_id);
  if (
    typeof row.statement !== "string" ||
    !row.statement.trim() ||
    row.statement.includes("\0") ||
    containsCredentialDeep(row, "hosted-semantic:claim")
  )
    bad("semantic-claim-data");
  const scope = jsonRecord(row.scope);
  if (canonicalJson(scope) !== canonicalJson(row.scope)) bad("semantic-claim-data");
  return freezeDeep({ claim_id: row.claim_id as string, statement: row.statement, scope });
}

/** Structural normalized citation data only; the bound parser checks actual source bytes. */
export function semanticCitationData(value: unknown): HostRuntimeSemanticCitationV1 {
  const row = record(value, ["evidenceId", "startByte", "endByte", "sha256"]);
  id(row.evidenceId);
  sha(row.sha256);
  if (nonnegative(row.endByte) < nonnegative(row.startByte)) bad("semantic-citation-span");
  return row as unknown as HostRuntimeSemanticCitationV1;
}

export function jsonRecord(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    bad("terminal-record-shape");
  let copy: unknown;
  try {
    copy = JSON.parse(JSON.stringify(value));
  } catch {
    bad("terminal-record-shape");
  }
  if (!copy || typeof copy !== "object" || Array.isArray(copy)) bad("terminal-record-shape");
  return copy as Record<string, unknown>;
}
