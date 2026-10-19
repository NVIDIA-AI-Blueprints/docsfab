// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Contract-kit decode bounds.
 *
 * Catalog ceilings load from `config/limits.yaml` through the generated
 * mirror and stay the default snapshot. This module cannot import `limit()`:
 * doctor observations decode run records through this kit at module load, so
 * a loader import would cycle. Supported startup (`loadConfig`,
 * `docsfab doctor --limits`) validates host shrinks through the shared parser
 * and installs that result here; the inert walk and array helper read the
 * snapshot at decode time.
 *
 * Exceeding a bound refuses with sibling code `bound-exceeded` and a message
 * that names the axis, the configured limit, and the observed value. The kit
 * never truncates, clamps, or skips. Caller codes stay theirs.
 */

import { LIMIT_DEFINITION_BY_NAME } from "../config/limits.generated.js";

export const CONTRACT_DECODE_BOUND_AXES = Object.freeze({
  maxNodes: "runtime.contract.maxNodes",
  maxDepth: "runtime.contract.maxDepth",
  maxArrayLength: "runtime.contract.maxArrayLength",
  maxStringChars: "runtime.contract.maxStringChars",
} as const);

export type ContractDecodeBoundAxis =
  (typeof CONTRACT_DECODE_BOUND_AXES)[keyof typeof CONTRACT_DECODE_BOUND_AXES];

export interface ContractBoundExceeded {
  readonly axis: ContractDecodeBoundAxis;
  readonly limit: number;
  readonly observed: number;
}

export const DELEGATED_TASK_STATE_BYTE_LIMIT = "runtime.delegatedTask.stateMaxBytes" as const;

export interface ContractDecodeLimitSnapshot {
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly maxArrayLength: number;
  readonly maxStringChars: number;
  /** Pinned delegated-task record size. Catalog: runtime.delegatedTask.stateMaxBytes. */
  readonly stateMaxBytes: number;
}

function catalogLimit(name: ContractDecodeBoundAxis): number {
  const definition = LIMIT_DEFINITION_BY_NAME[name];
  if (!definition) {
    throw new Error(`Contract decode limit ${name} is missing from config/limits.yaml.`);
  }
  return definition.value;
}

/**
 * Maximum JSON-like nodes a strict inert decode may visit.
 *
 * - **Unit:** visited nodes (each object, array, and primitive counts as one).
 * - **Catalog:** `runtime.contract.maxNodes`.
 * - **Rationale:** the shared decode gate must refuse a huge payload before the
 *   walk becomes unbounded. The catalog value admits real sealed records and
 *   still caps CPU and memory on every `createContractKit` contract.
 */
export const CONTRACT_MAX_NODES = catalogLimit(CONTRACT_DECODE_BOUND_AXES.maxNodes);

/**
 * Maximum nesting depth a strict inert decode may visit.
 *
 * - **Unit:** nesting depth, with the root at 0.
 * - **Catalog:** `runtime.contract.maxDepth`.
 * - **Rationale:** sealed records are shallow closed schemas. The catalog
 *   ceiling is far above any honest envelope and still small enough to bound
 *   recursion and prototype chain walk cost.
 */
export const CONTRACT_MAX_DEPTH = catalogLimit(CONTRACT_DECODE_BOUND_AXES.maxDepth);

/**
 * Maximum array length a contract-kit array or strict inert walk may accept.
 *
 * - **Unit:** array elements (the object's `length` value).
 * - **Catalog:** `runtime.contract.maxArrayLength`.
 * - **Rationale:** one ceiling for the strict inert walk and the standard
 *   `array()` helper. Large enough for real identifier and hash lists; small
 *   enough that a huge array cannot hide behind a generic shape failure.
 */
export const CONTRACT_MAX_ARRAY_LENGTH = catalogLimit(CONTRACT_DECODE_BOUND_AXES.maxArrayLength);

/**
 * Maximum string length a strict inert decode may accept.
 *
 * - **Unit:** UTF-16 code units (`String.length`).
 * - **Catalog:** `runtime.contract.maxStringChars`.
 * - **Rationale:** identifiers, hashes, and timestamps are tiny; the catalog
 *   ceiling is a generous scalar bound so a huge string is reported as this
 *   bound rather than as a typo'd value.
 */
export const CONTRACT_MAX_STRING_CHARS = catalogLimit(CONTRACT_DECODE_BOUND_AXES.maxStringChars);

function catalogByteLimit(name: typeof DELEGATED_TASK_STATE_BYTE_LIMIT): number {
  const definition = LIMIT_DEFINITION_BY_NAME[name];
  if (!definition) {
    throw new Error(`Contract decode limit ${name} is missing from config/limits.yaml.`);
  }
  return definition.value;
}

const CATALOG_DECODE_LIMITS: ContractDecodeLimitSnapshot = Object.freeze({
  maxNodes: CONTRACT_MAX_NODES,
  maxDepth: CONTRACT_MAX_DEPTH,
  maxArrayLength: CONTRACT_MAX_ARRAY_LENGTH,
  maxStringChars: CONTRACT_MAX_STRING_CHARS,
  stateMaxBytes: catalogByteLimit(DELEGATED_TASK_STATE_BYTE_LIMIT),
});

let effectiveDecodeLimits: ContractDecodeLimitSnapshot = CATALOG_DECODE_LIMITS;

/**
 * Effective decode ceilings. Catalog defaults until supported startup
 * installs a validated host snapshot.
 */
export function contractDecodeLimits(): ContractDecodeLimitSnapshot {
  return effectiveDecodeLimits;
}

/**
 * Publish a parser-validated snapshot to decoder consumers. Callers must
 * pass values already resolved through `limit()` / `resolveLimits()`.
 */
export function installContractDecodeLimitSnapshot(snapshot: ContractDecodeLimitSnapshot): void {
  effectiveDecodeLimits = Object.freeze({
    maxNodes: snapshot.maxNodes,
    maxDepth: snapshot.maxDepth,
    maxArrayLength: snapshot.maxArrayLength,
    maxStringChars: snapshot.maxStringChars,
    stateMaxBytes: snapshot.stateMaxBytes,
  });
}

/**
 * Catalog default for the pinned delegated-task record.
 *
 * Effective enforcement uses `delegatedTaskStateMaxBytes()`, which follows the
 * validated host snapshot installed by `activateContractDecodeLimits`.
 */
export const DELEGATED_TASK_STATE_MAX_BYTES = catalogByteLimit(DELEGATED_TASK_STATE_BYTE_LIMIT);

/** Byte ceiling the private store enforces on the pinned record read. */
export function delegatedTaskStateMaxBytes(): number {
  return effectiveDecodeLimits.stateMaxBytes;
}

export function formatContractBoundExceeded(details: ContractBoundExceeded): string {
  return `bound-exceeded axis=${details.axis} limit=${details.limit} observed=${details.observed}`;
}

/** The bound each kit refusal crossed, keyed by the error the kit threw. */
const boundExceededByError = new WeakMap<object, ContractBoundExceeded>();

export function annotateContractBoundExceeded(
  error: unknown,
  details: ContractBoundExceeded,
): unknown {
  const fragment = formatContractBoundExceeded(details);
  if (error instanceof Error && !error.message.includes(fragment)) {
    error.message = `${error.message} ${fragment}`;
  }
  if (typeof error === "object" && error !== null) {
    boundExceededByError.set(
      error,
      Object.freeze({ axis: details.axis, limit: details.limit, observed: details.observed }),
    );
  }
  return error;
}

/**
 * The decode bound a contract-kit refusal crossed, read from the error the kit
 * threw rather than from its message, or `undefined` for any other error. A
 * caller that wraps the refusal can record the bound by its catalog name.
 */
export function contractBoundExceededOf(error: unknown): ContractBoundExceeded | undefined {
  return typeof error === "object" && error !== null ? boundExceededByError.get(error) : undefined;
}
