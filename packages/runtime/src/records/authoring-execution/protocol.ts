// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createContractKit, type ContractFail } from "../../contract-kit/index.js";

export type AuthoringExecutionErrorCode =
  | "credential-material"
  | "digest-mismatch"
  | "invalid-shape"
  | "invalid-value"
  | "schema-mismatch"
  | "subject-mismatch"
  | "path-mismatch"
  | "candidate-mismatch"
  | "phase-mismatch"
  | "selection-mismatch"
  | "patch-mismatch";

export class AuthoringExecutionError extends Error {
  public readonly code: AuthoringExecutionErrorCode;
  public constructor(code: AuthoringExecutionErrorCode) {
    super(`Authoring execution evidence rejected: ${code}.`);
    this.code = code;
    this.name = "AuthoringExecutionError";
  }
}

export function fail(code: AuthoringExecutionErrorCode): never {
  throw new AuthoringExecutionError(code);
}

export const kit = createContractKit<AuthoringExecutionErrorCode>({
  fail: fail as ContractFail<AuthoringExecutionErrorCode>,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "schema-mismatch",
  },
});

export const SAFE_PATH = /^(?!\.)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u;

export function normalizePaths(value: unknown): string[] {
  const paths = kit.array(value).map((entry) => kit.string(entry));
  if (
    paths.length === 0 ||
    paths.length > 512 ||
    new Set(paths).size !== paths.length ||
    paths.some(
      (path) =>
        !SAFE_PATH.test(path) ||
        path.includes("\\") ||
        path.split("/").some((part) => !part || part === "." || part === ".."),
    )
  ) {
    fail("path-mismatch");
  }
  const sorted = [...paths].sort(kit.compare);
  if (!sameStrings(paths, sorted)) fail("path-mismatch");
  return sorted;
}

export function normalizeRevisionChangedPaths(
  value: unknown,
  writePaths: readonly string[],
): string[] {
  const paths = kit.array(value).map((entry) => kit.string(entry));
  if (
    paths.length > writePaths.length ||
    new Set(paths).size !== paths.length ||
    paths.some((path) => !writePaths.includes(path))
  ) {
    fail("path-mismatch");
  }
  const sorted = [...paths].sort(kit.compare);
  if (!sameStrings(paths, sorted)) fail("path-mismatch");
  return sorted;
}

export function normalizeIds(value: unknown): string[] {
  return kit.array(value).map((entry) => kit.identifier(entry));
}

export function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const root = kit.object(value);
  kit.exact(root, keys);
  return root;
}

export function nonnegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail("invalid-value");
  return value as number;
}

export function nullableHash(value: unknown): string | null {
  return value === null ? null : kit.hash(value);
}

export function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
