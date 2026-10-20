// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import type { RepositoryTarget } from "../../repository/contracts.js";
import { deepFreeze } from "../../contract-kit/freeze.js";
import { createContractKit } from "../../contract-kit/index.js";
import { verifyActiveRepositoryWorkspace } from "../../repository/workspace/tracked-read.js";
import type { RepositoryWorkspace } from "../../repository/workspace/contracts.js";
import type { DocumentationMaturityAuthorityV1 } from "../contracts.js";

export class DocumentationMaturityEvaluatorError extends Error {
  public constructor(
    public readonly code:
      | "invalid-catalog"
      | "invalid-product-need"
      | "invalid-source"
      | "repository-mismatch"
      | "invalid-mapping"
      | "evidence-limit-exceeded",
  ) {
    super(`Documentation maturity evaluator rejected: ${code}.`);
    this.name = "DocumentationMaturityEvaluatorError";
  }
}

export function invalid(code: DocumentationMaturityEvaluatorError["code"]): never {
  throw new DocumentationMaturityEvaluatorError(code);
}

/**
 * Shared contract-kit binding for evaluator dialect helpers.
 * Freeze and inert checks come from the kit; custom exact bottoms below
 * preserve evaluator fail-closed codes.
 */
const kit = createContractKit({
  fail: () => invalid("invalid-source"),
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
  inertMode: "strict",
});

export { deepFreeze };
export const canonicalDigest = kit.canonicalDigest;
export const canonicalJson = kit.canonicalJson;

export const assertInertPlainData = (value: unknown): void => {
  kit.assertInert(omitUndefinedLeaves(value));
};

const MAXIMUM_INERT_DEPTH = 64;
const MAXIMUM_INERT_NODES = 100_000;

function omitUndefinedLeaves(
  value: unknown,
  active = new Set<object>(),
  depth = 0,
  nodes = { count: 0 },
): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  if (nodeUtilTypes.isProxy(value)) invalid("invalid-source");
  if (depth > MAXIMUM_INERT_DEPTH || ++nodes.count > MAXIMUM_INERT_NODES || active.has(value)) {
    invalid("invalid-source");
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return value;
  const cleaned: Record<string, unknown> = {};
  active.add(value);
  try {
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor ||
        descriptor.get ||
        descriptor.set ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        return value;
      }
      if (descriptor.value === undefined) continue;
      cleaned[key] = omitUndefinedLeaves(descriptor.value, active, depth + 1, nodes);
    }
  } finally {
    active.delete(value);
  }
  return cleaned;
}

export function assertExactShallowInput(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): void {
  if (
    !value ||
    typeof value !== "object" ||
    nodeUtilTypes.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    invalid("invalid-source");
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === "symbol")) invalid("invalid-source");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.values(descriptors).some(
      (descriptor) =>
        descriptor.get || descriptor.set || !("value" in descriptor) || !descriptor.enumerable,
    )
  ) {
    invalid("invalid-source");
  }
  const keys = ownKeys as string[];
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (requiredKeys.some((key) => !keys.includes(key)) || keys.some((key) => !allowed.has(key))) {
    invalid("invalid-source");
  }
}

export function snapshotPlainData<T>(value: T): T {
  assertInertPlainData(value);
  return deepFreeze(structuredClone(value));
}

export function snapshotOpaqueSequence<T>(value: readonly T[], maximum: number): readonly T[] {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    invalid("invalid-source");
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  const descriptorKeys = Reflect.ownKeys(descriptors);
  const length = descriptors.length;
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 0 ||
    !length ||
    length.get ||
    length.set ||
    !("value" in length) ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0 ||
    length.enumerable
  ) {
    invalid("invalid-source");
  }
  if (length.value > maximum) {
    invalid("evidence-limit-exceeded");
  }
  if (descriptorKeys.length !== length.value + 1) invalid("invalid-source");
  const expectedKeys = [
    ...Array.from({ length: length.value }, (_, index) => String(index)),
    "length",
  ];
  if (
    !hasExactKeys(descriptors, expectedKeys) ||
    Object.entries(descriptors).some(
      ([key, descriptor]) =>
        descriptor.get ||
        descriptor.set ||
        !("value" in descriptor) ||
        (key === "length" ? descriptor.enumerable : !descriptor.enumerable),
    )
  ) {
    invalid("invalid-source");
  }
  return Object.freeze(
    Array.from({ length: length.value }, (_, index) => descriptors[String(index)]!.value as T),
  );
}

export async function authenticWorkspaceForRepository(
  workspaceValue: unknown,
  repository: RepositoryTarget,
): Promise<RepositoryWorkspace> {
  let workspace: RepositoryWorkspace;
  try {
    workspace = await verifyActiveRepositoryWorkspace(workspaceValue);
  } catch {
    invalid("invalid-source");
  }
  if (
    workspace.sourcePath !== repository.sourcePath ||
    workspace.requestedRevision !== repository.requestedRevision ||
    workspace.revision !== repository.revision
  )
    invalid("repository-mismatch");
  return workspace;
}

export function primitiveString(value: unknown): string {
  if (typeof value !== "string") invalid("invalid-source");
  return value;
}

export function choice<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) invalid("invalid-source");
  return value as T;
}

export function sha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) invalid("invalid-source");
  return value;
}

export function revision(value: unknown): string {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) {
    invalid("invalid-mapping");
  }
  return value;
}

export function safeId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u.test(value) ||
    value.includes(":/") ||
    value.includes("\\") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    invalid("invalid-mapping");
  }
  return value;
}

export function safeHostToken(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    invalid("invalid-source");
  }
  return value;
}

export function canonicalTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    invalid("invalid-source");
  return value;
}

export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

export function plainObject(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    invalid("invalid-mapping");
  return value as Record<string, unknown>;
}

export function shaArray(value: unknown): string[] {
  if (!Array.isArray(value)) invalid("invalid-mapping");
  const result = value.map(sha).sort();
  unique(result);
  return result;
}

export function safeIdArray(value: unknown): string[] {
  if (!Array.isArray(value)) invalid("invalid-mapping");
  const result = value.map(safeId).sort();
  unique(result);
  return result;
}

export function boundedStrings(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 256 ||
    value.some(
      (item) =>
        typeof item !== "string" ||
        item.length === 0 ||
        item.length > 4_096 ||
        /[\u0000-\u001f\u007f]/u.test(item),
    )
  )
    invalid("invalid-mapping");
  return [...value] as string[];
}

export function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) invalid("invalid-mapping");
}

export function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(","))
    invalid("invalid-mapping");
}

export function isSortedUnique(values: readonly string[]): boolean {
  return (
    new Set(values).size === values.length &&
    values.every((value, index) => index === 0 || values[index - 1]! < value)
  );
}

export function repositoryBinding(sourcePath: string, revisionValue: string) {
  if (!sourcePath || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(revisionValue)) {
    invalid("repository-mismatch");
  }
  return {
    identitySha256: createHash("sha256").update(sourcePath).digest("hex"),
    revision: revisionValue,
  };
}

export function baseAuthority(repository: RepositoryTarget): DocumentationMaturityAuthorityV1 {
  return {
    repository: structuredClone(repository),
    repositoryIdentitySha256: createHash("sha256").update(repository.sourcePath).digest("hex"),
    repositoryObservations: [],
    searches: [],
    gapLedger: null,
    outcomeRecords: [],
    humanInputRequirements: [],
    humanInputs: [],
    workflowInputRequirements: [],
    governedInputs: [],
  };
}

export function snapshotRepositoryTarget(value: unknown): RepositoryTarget {
  assertExactShallowInput(value, ["sourcePath", "requestedRevision", "revision"]);
  return snapshotPlainData(value as RepositoryTarget);
}
