// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createContractKit, type ContractFail } from "../../contract-kit/index.js";
import type { WorkflowName } from "../../workflow-contracts/contracts.js";
import { isWorkflowName } from "../../workflow-registry/catalog.js";

export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u;

export class DocumentationGapLedgerError extends Error {
  public constructor(
    public readonly code:
      | "invalid-finding"
      | "invalid-ledger"
      | "contradictory-evidence"
      | "invalid-reconciliation"
      | "invalid-proposal",
  ) {
    super(`Documentation gap ledger rejected: ${code}.`);
    this.name = "DocumentationGapLedgerError";
  }
}

type GapLedgerContractKit = ReturnType<
  typeof createContractKit<DocumentationGapLedgerError["code"]>
>;

const gapLedgerKits = new Map<DocumentationGapLedgerError["code"], GapLedgerContractKit>();

export function fail(code: DocumentationGapLedgerError["code"]): never {
  throw new DocumentationGapLedgerError(code);
}

function kitFor(code: DocumentationGapLedgerError["code"]): GapLedgerContractKit {
  const existing = gapLedgerKits.get(code);
  if (existing) return existing;
  const created = createContractKit({
    fail: fail as ContractFail<DocumentationGapLedgerError["code"]>,
    inertMode: "strict",
    codes: {
      invalidShape: code,
      invalidValue: code,
      digestMismatch: code,
      credentialMaterial: code,
      schemaMismatch: code,
    },
  });
  gapLedgerKits.set(code, created);
  return created;
}

export function requireInert(value: unknown, code: DocumentationGapLedgerError["code"]): void {
  kitFor(code).assertInert(value);
}

export function rejectCredentials(value: unknown, code: DocumentationGapLedgerError["code"]): void {
  kitFor(code).rejectCredentials(value);
}

export function requireKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  code: DocumentationGapLedgerError["code"],
): void {
  kitFor(code).exact(value, keys);
}

export function object(
  value: unknown,
  code: DocumentationGapLedgerError["code"],
): Record<string, unknown> {
  requireInert(value, code);
  return kitFor(code).object(value);
}

export function array(value: unknown, code: DocumentationGapLedgerError["code"]): unknown[] {
  return kitFor(code).array(value);
}

export function equal(
  value: unknown,
  expected: unknown,
  code: DocumentationGapLedgerError["code"],
): void {
  if (value !== expected) fail(code);
}

export function id(value: unknown, code: DocumentationGapLedgerError["code"]): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) fail(code);
  return value;
}

export function version(value: unknown, code: DocumentationGapLedgerError["code"]): string {
  if (typeof value !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u.test(value))
    fail(code);
  return value;
}

export function sha(value: unknown, code: DocumentationGapLedgerError["code"]): string {
  return kitFor(code).hash(value);
}

export function revision(value: unknown, code: DocumentationGapLedgerError["code"]): string {
  return kitFor(code).revision(value);
}

export function bool(value: unknown, code: DocumentationGapLedgerError["code"]): boolean {
  if (typeof value !== "boolean") fail(code);
  return value;
}

export function cataloguedWorkflow(
  value: unknown,
  code: DocumentationGapLedgerError["code"],
): WorkflowName {
  if (typeof value !== "string" || !isWorkflowName(value)) fail(code);
  return value;
}

export function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  code: DocumentationGapLedgerError["code"],
): T {
  return kitFor(code).enumeration(value, allowed) as T;
}

export function ids(value: unknown, code: DocumentationGapLedgerError["code"]): string[] {
  const values = array(value, code).map((item) => id(item, code));
  unique(values, code);
  if (values.join(",") !== [...values].sort().join(",")) fail(code);
  return values;
}

export function unique(values: readonly string[], code: DocumentationGapLedgerError["code"]): void {
  kitFor(code).unique([...values]);
}
