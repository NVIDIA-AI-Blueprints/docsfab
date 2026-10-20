// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isProxy } from "node:util/types";

const MAX_PUBLIC_GRAPH_DEPTH = 32;
const MAX_PUBLIC_GRAPH_NODES = 100_000;
const MAX_PUBLIC_RECORD_FIELDS = 128;
const MAX_ROADMAP_ARRAY_ITEMS = 10_000;

export type ManagedIssueContractErrorCode =
  | "invalid-type"
  | "invalid-value"
  | "unknown-field"
  | "missing-field"
  | "unsafe-content"
  | "unsafe-path"
  | "digest-mismatch"
  | "repository-mismatch"
  | "finding-mismatch"
  | "mutation-mismatch"
  | "multiple-markers"
  | "ambiguous-match";

export class ManagedIssueContractError extends Error {
  public constructor(
    public readonly code: ManagedIssueContractErrorCode,
    public readonly path: string,
  ) {
    super(`Managed issue contract validation failed: ${code} at ${path}`);
    this.name = "ManagedIssueContractError";
  }
}

export function closed(
  value: unknown,
  path: string,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): Record<string, unknown> {
  requireValue(
    typeof value === "object" && value !== null && !isProxy(value) && !Array.isArray(value),
    "invalid-type",
    path,
  );
  requireValue(Object.getPrototypeOf(value) === Object.prototype, "invalid-type", path);
  const keys = Reflect.ownKeys(value);
  requireValue(keys.length <= MAX_PUBLIC_RECORD_FIELDS, "invalid-value", path);
  const root: Record<string, unknown> = {};
  for (const key of keys) {
    requireValue(typeof key === "string", "unknown-field", path);
    requireValue(allowed.includes(key), "unknown-field", `${path}.${key}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireValue(
      descriptor !== undefined && "value" in descriptor && descriptor.enumerable,
      "invalid-type",
      `${path}.${key}`,
    );
    root[key] = descriptor.value;
  }
  for (const key of required)
    requireValue(Object.hasOwn(root, key), "missing-field", `${path}.${key}`);
  return root;
}

export function denseArray(
  value: unknown,
  path: string,
  maxItems: number,
  minItems = 0,
): unknown[] {
  requireValue(
    typeof value === "object" && value !== null && !isProxy(value) && Array.isArray(value),
    "invalid-type",
    path,
  );
  requireValue(Object.getPrototypeOf(value) === Array.prototype, "invalid-type", path);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  requireValue(
    lengthDescriptor !== undefined &&
      "value" in lengthDescriptor &&
      Number.isSafeInteger(lengthDescriptor.value) &&
      lengthDescriptor.value >= minItems &&
      lengthDescriptor.value <= maxItems,
    "invalid-value",
    `${path}.length`,
  );
  const length = lengthDescriptor.value as number;
  const keys = Reflect.ownKeys(value);
  requireValue(
    keys.length === length + 1 &&
      keys.every(
        (key) => typeof key === "string" && (key === "length" || /^(?:0|[1-9][0-9]*)$/u.test(key)),
      ),
    "unknown-field",
    path,
  );
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    requireValue(
      descriptor !== undefined && "value" in descriptor && descriptor.enumerable,
      "invalid-type",
      `${path}[${index}]`,
    );
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

export function assertPassiveDataGraph(value: unknown, path: string): void {
  const seen = new WeakSet<object>();
  const state = { nodes: 0 };
  visitPassiveData(value, path, 0, seen, state);
}

function visitPassiveData(
  value: unknown,
  path: string,
  depth: number,
  seen: WeakSet<object>,
  state: { nodes: number },
): void {
  requireValue(typeof value !== "function", "invalid-type", path);
  if (value === null || typeof value !== "object") return;
  requireValue(!isProxy(value), "invalid-type", path);
  requireValue(depth <= MAX_PUBLIC_GRAPH_DEPTH, "invalid-value", path);
  requireValue(!seen.has(value), "invalid-value", path);
  seen.add(value);
  state.nodes += 1;
  requireValue(state.nodes <= MAX_PUBLIC_GRAPH_NODES, "invalid-value", path);
  if (Array.isArray(value)) {
    const items = denseArray(value, path, MAX_ROADMAP_ARRAY_ITEMS);
    items.forEach((item, index) =>
      visitPassiveData(item, `${path}[${index}]`, depth + 1, seen, state),
    );
    seen.delete(value);
    return;
  }
  requireValue(Object.getPrototypeOf(value) === Object.prototype, "invalid-type", path);
  const keys = Reflect.ownKeys(value);
  requireValue(keys.length <= MAX_PUBLIC_RECORD_FIELDS, "invalid-value", path);
  for (const key of keys) {
    requireValue(typeof key === "string", "unknown-field", path);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireValue(
      descriptor !== undefined && "value" in descriptor && descriptor.enumerable,
      "invalid-type",
      `${path}.${key}`,
    );
    visitPassiveData(descriptor.value, `${path}.${key}`, depth + 1, seen, state);
  }
  seen.delete(value);
}

export function requireValue(
  condition: unknown,
  code: ManagedIssueContractErrorCode,
  path: string,
): asserts condition {
  if (!condition) throw new ManagedIssueContractError(code, path);
}
