// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WorkflowName } from "../../workflow-contracts/contracts.js";
import { createAutonomyDialect } from "../dialect.js";

export type AutoCycleContractErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "scope-expansion"
  | "workflow-not-registered"
  | "prerequisite-unsatisfied"
  | "decision-conflict"
  | "authorization-required"
  | "authorization-expired"
  | "migration-required";

export class AutoCycleContractError extends Error {
  public constructor(public readonly code: AutoCycleContractErrorCode) {
    super(`Autonomous-cycle contract rejected: ${code}.`);
    this.name = "AutoCycleContractError";
  }
}

function fail(code: AutoCycleContractErrorCode): never {
  throw new AutoCycleContractError(code);
}

const {
  canonicalDigest,
  canonicalJson,
  rejectCredentials,
  assertInert,
  object,
  exact,
  noUnknown,
  identifier,
  hash,
  timestamp,
  enumeration,
  compare,
  unique,
  normalizedHashes,
  normalizedIds,
  seal: kitSeal,
  decodeSealed,
  sourceVersion: sourceSchemaVersion,
} = createAutonomyDialect(fail);

/** Type check only; autonomy string scalars get no NFC or NUL check. */
function string(value: unknown): string {
  if (typeof value !== "string") fail("invalid-value");
  return value;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) fail("invalid-shape");
  return value;
}

function stringArray(value: unknown): string[] {
  return array(value).map(string);
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail("invalid-value");
  return value;
}

function idCompare(left: { id: string }, right: { id: string }): number {
  return compare(left.id, right.id);
}

function workflowCompare(
  left: { workflow: WorkflowName },
  right: { workflow: WorkflowName },
): number {
  return compare(left.workflow, right.workflow);
}

function fingerprintCompare(left: { fingerprint: string }, right: { fingerprint: string }): number {
  return compare(left.fingerprint, right.fingerprint);
}

export {
  array,
  assertInert,
  canonicalDigest,
  canonicalJson,
  compare,
  decodeSealed,
  enumeration,
  exact,
  fail,
  fingerprintCompare,
  hash,
  idCompare,
  identifier,
  integer,
  noUnknown,
  normalizedHashes,
  normalizedIds,
  object,
  rejectCredentials,
  kitSeal,
  sourceSchemaVersion,
  string,
  stringArray,
  timestamp,
  unique,
  workflowCompare,
};
