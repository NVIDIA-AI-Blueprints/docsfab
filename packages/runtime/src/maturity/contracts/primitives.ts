// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isAbsolute } from "node:path";
import type { RepositoryTarget } from "../../repository/contracts.js";
import type { WorkflowName } from "../../workflow-contracts/contracts.js";
import { createContractKit } from "../../contract-kit/index.js";
import type { DocumentationMaturityWorkflowAccess } from "../contracts.js";
import type { DocumentationMaturityRepositoryBindingV1 } from "../contracts.js";

export type DocumentationMaturityContractErrorCode =
  | "invalid-catalog"
  | "invalid-observation"
  | "invalid-finding"
  | "invalid-authority"
  | "contradictory-evidence"
  | "invalid-work-unit"
  | "migration-required";

export class DocumentationMaturityContractError extends Error {
  public constructor(public readonly code: DocumentationMaturityContractErrorCode) {
    super(`Documentation maturity contract rejected: ${code}.`);
    this.name = "DocumentationMaturityContractError";
  }
}

export function fail(code: DocumentationMaturityContractErrorCode): never {
  throw new DocumentationMaturityContractError(code);
}

let activeCode: DocumentationMaturityContractErrorCode = "invalid-finding";

const kit = createContractKit({
  fail: () => fail(activeCode),
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-finding",
    invalidValue: "invalid-finding",
    digestMismatch: "invalid-finding",
    credentialMaterial: "invalid-finding",
    schemaMismatch: "migration-required",
  },
});

function withCode<T>(code: DocumentationMaturityContractErrorCode, run: () => T): T {
  const previous = activeCode;
  activeCode = code;
  try {
    return run();
  } finally {
    activeCode = previous;
  }
}

export function repositoryBinding(
  value: unknown,
  code: DocumentationMaturityContractErrorCode,
): DocumentationMaturityRepositoryBindingV1 {
  const item = object(value, code);
  exact(item, ["identitySha256", "revision"], code);
  return {
    identitySha256: sha(item.identitySha256, code),
    revision: revision(item.revision, code),
  };
}

export function repositoryTarget(
  value: unknown,
  code: DocumentationMaturityContractErrorCode,
): RepositoryTarget {
  const item = object(value, code);
  exact(item, ["sourcePath", "requestedRevision", "revision"], code);
  if (
    typeof item.sourcePath !== "string" ||
    item.sourcePath.length === 0 ||
    item.sourcePath.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(item.sourcePath) ||
    typeof item.requestedRevision !== "string" ||
    item.requestedRevision.length === 0 ||
    item.requestedRevision.length > 1_024 ||
    /[\u0000-\u001f\u007f]/u.test(item.requestedRevision)
  )
    fail(code);
  return {
    sourcePath: item.sourcePath,
    requestedRevision: item.requestedRevision,
    revision: revision(item.revision, code),
  };
}

export function paths(
  value: unknown,
  code: DocumentationMaturityContractErrorCode,
  allowEmpty: boolean,
): string[] {
  const result = array(value, code)
    .map((value) => repositoryPath(value, code))
    .sort();
  unique(result, code);
  if ((!allowEmpty && result.length === 0) || result.length > 256) fail(code);
  return result;
}

export function repositoryPath(
  value: unknown,
  code: DocumentationMaturityContractErrorCode,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value) ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    fail(code);
  return value;
}

export function object(
  value: unknown,
  code: DocumentationMaturityContractErrorCode,
): Record<string, unknown> {
  return withCode(code, () => kit.object(value));
}

export function array(value: unknown, code: DocumentationMaturityContractErrorCode): unknown[] {
  return withCode(code, () => kit.array(value));
}

export function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
  code: DocumentationMaturityContractErrorCode,
): void {
  withCode(code, () => {
    kit.exact(value, keys);
  });
}

export function equal(
  value: unknown,
  expected: unknown,
  code: DocumentationMaturityContractErrorCode,
): void {
  if (value !== expected) fail(code);
}

export function id(value: unknown, code: DocumentationMaturityContractErrorCode): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u.test(value) ||
    value.includes(":/") ||
    value.includes("\\") ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail(code);
  }
  return value;
}

export function safeCode(value: unknown, code: DocumentationMaturityContractErrorCode): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9.-]{0,127}$/u.test(value)) fail(code);
  return value;
}

export function sha(value: unknown, code: DocumentationMaturityContractErrorCode): string {
  return withCode(code, () => kit.hash(value));
}

export function shas(value: unknown, code: DocumentationMaturityContractErrorCode): string[] {
  return withCode(code, () => kit.normalizedHashes(value));
}

export function ids(value: unknown, code: DocumentationMaturityContractErrorCode): string[] {
  const result = array(value, code)
    .map((item) => id(item, code))
    .sort();
  unique(result, code);
  return result;
}

export function revision(value: unknown, code: DocumentationMaturityContractErrorCode): string {
  return withCode(code, () => kit.revision(value));
}

export function workflowNameValue(
  value: unknown,
  code: DocumentationMaturityContractErrorCode,
  workflows: DocumentationMaturityWorkflowAccess,
): WorkflowName {
  if (typeof value !== "string" || !workflows.isWorkflowName(value)) fail(code);
  return value as WorkflowName;
}

export function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  code: DocumentationMaturityContractErrorCode,
): T {
  return withCode(code, () => kit.enumeration(value, allowed));
}

export function unique(
  values: readonly string[],
  code: DocumentationMaturityContractErrorCode,
): void {
  withCode(code, () => {
    kit.unique([...values]);
  });
}

export const assertInertPlainData = (
  value: unknown,
  code: DocumentationMaturityContractErrorCode,
): void => {
  withCode(code, () => {
    kit.assertInert(value);
  });
};

export function rejectCredentials(
  value: unknown,
  code: DocumentationMaturityContractErrorCode,
): void {
  withCode(code, () => {
    kit.rejectCredentials(value);
  });
}
